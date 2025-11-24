// src/server/routes/tickets/messages.ts

import { Router, type Request, type Response } from "express";
import type { AuthInfo } from "../../middleware/auth";
import { authRequired } from "../../middleware/auth";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();
const enforceAuth = authRequired();
router.use((req, res, next) => {
  void enforceAuth(req, res, next);
});

const supabase = createClient();

type TicketMessageRequest = Request & { user?: AuthInfo };

router.get(
  "/:id/messages",
  (req: TicketMessageRequest, res: Response) => {
    const contextUserId = req.user?.userId ?? readUserId(req.header("x-user-id"));
    void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
      try {
        const userId = contextUserId ?? readUserId(req.header("x-user-id"));
        if (!userId) return sendError(res, 401, "unauthorized", "Missing authenticated user.");

        const ticketId = firstString(req.params.id);
        if (!ticketId) return sendError(res, 400, "invalid_ticket_id", "Ticket id is required.");

        await ensureTicketOwner(userId, ticketId);

        const query = sanitizeQuery(req);
        const result = await listMessages(ticketId, query);

        return res.status(200).json({
          ok: true,
          data: result,
          correlation_id: getCorrelationId(),
        });
      } catch (error) {
        log.error("tickets/messages error", { err: safeError(error) });
        if (isSendableError(error)) {
          return sendError(
            res,
            error.status,
            error.code || "messages_failed",
            error.message || "Unable to load ticket messages.",
          );
        }
        return sendError(res, 500, "messages_failed", "Unable to load ticket messages.");
      }
    });
  },
);

export default router;

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

interface ListQuery {
  limit: number;
  offset: number;
}

interface TicketMessage {
  id: string;
  ticket_id: string;
  author_type: string;
  author_id: string | null;
  body_text: string;
  attachments: Array<Record<string, unknown>>;
  meta: Record<string, unknown>;
  created_at: string | null;
}

async function listMessages(ticketId: string, query: ListQuery): Promise<{ items: TicketMessage[]; next_cursor?: string }> {
  const { data, error } = await supabase
    .from("ticket_messages")
    .select("id, ticket_id, author_type, author_id, body_text, attachments, meta, created_at")
    .eq("ticket_id", ticketId)
    .eq("visibility", "public")
    .order("created_at", { ascending: true })
    .range(query.offset, query.offset + query.limit);

  if (error) handleDbError("list_messages", error);

  const rows: Record<string, unknown>[] = Array.isArray(data) ? data.filter(isRecord) : [];
  const hasMore = rows.length > query.limit;
  const slice = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: slice.map(mapMessage),
    next_cursor: hasMore ? encodeCursor(query.offset + query.limit) : undefined,
  };
}

function mapMessage(row: Record<string, unknown>): TicketMessage {
  const id = firstString(row["id"]);
  if (!id) throw sendableError(500, "message_invalid", "Message record is missing id.");
  const ticketId = firstString(row["ticket_id"]);
  if (!ticketId) throw sendableError(500, "message_invalid", "Message record is missing ticket id.");
  const authorType = firstString(row["author_type"]) ?? "user";
  const meta = isRecord(row["meta"]) ? row["meta"] : {};
  return {
    id,
    ticket_id: ticketId,
    author_type: authorType,
    author_id: firstString(row["author_id"]) ?? null,
    body_text: firstString(row["body_text"]) ?? "",
    attachments: toAttachmentArray(row["attachments"]),
    meta,
    created_at: firstString(row["created_at"]) ?? null,
  };
}

async function ensureTicketOwner(userId: string, ticketId: string) {
  const { data, error } = await supabase.from("tickets").select("id").eq("id", ticketId).eq("user_id", userId).maybeSingle();
  if (error) handleDbError("ensure_ticket", error);
  if (!isRecord(data)) throw sendableError(404, "ticket_not_found", "Ticket could not be found.");
}

// -----------------------------------------------------------------------------
// Query helpers
// -----------------------------------------------------------------------------

function sanitizeQuery(req: Request): ListQuery {
  const limit = clampInt(firstNumber(req.query.limit), 1, 50, 20);
  const offset = decodeCursor(firstString(req.query.cursor));
  return { limit, offset };
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  });
}

function handleDbError(label: string, error: { message?: string }) {
  log.error(`tickets/messages ${label} failed`, { err: safeError(error) });
  throw sendableError(500, "db_error", "Database query failed.");
}

function sendableError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const str = firstString(entry);
      if (str) return str;
    }
    return undefined;
  }
  if (value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  if (value instanceof Date) {
    const iso = value.toISOString().trim();
    return iso.length ? iso : undefined;
  }
  return undefined;
}

function firstNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function encodeCursor(offset: number): string {
  const base = Buffer.from(String(offset), "utf8").toString("base64");
  return base.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const decoded = Buffer.from(normalized + padding, "base64").toString("utf8");
    const value = Number.parseInt(decoded, 10);
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid");
    return value;
  } catch {
    throw sendableError(400, "invalid_cursor", "Cursor is invalid or expired.");
  }
}

type SendableErrorShape = Error & { status: number; code?: string };

function isSendableError(value: unknown): value is SendableErrorShape {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Partial<SendableErrorShape>).status === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAttachmentArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const attachments: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    attachments.push(entry);
    if (attachments.length >= 10) break;
  }
  return attachments;
}

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}
