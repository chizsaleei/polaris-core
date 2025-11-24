// src/server/routes/tickets/index.ts
/**
 * Support tickets endpoint
 *
 * Routes:
 *   GET    /api/tickets              -> list user's tickets
 *   POST   /api/tickets              -> create ticket (and optional first message)
 *   POST   /api/tickets/:id/messages -> add a message to an existing ticket
 */

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

type TicketRequest = Request & { user?: AuthInfo };

router.get("/", (req: TicketRequest, res: Response) => {
  const contextUserId = req.user?.userId ?? readUserId(req.header("x-user-id"));
  void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
    try {
      const userId = contextUserId ?? readUserId(req.header("x-user-id"));
      if (!userId) return sendError(res, 401, "unauthorized", "Missing authenticated user.");
      const query = sanitizeListQuery(req);
      const result = await listTickets(userId, query);

      return res.status(200).json({
        ok: true,
        data: result,
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      log.error("tickets/list error", { err: safeError(error) });
      if (isSendableError(error)) {
        return sendError(res, error.status, error.code || "list_failed", error.message || "Unable to load tickets.");
      }

      return sendError(res, 500, "list_failed", "Unable to load tickets.");
    }
  });
});

router.post(
  "/",
  (req: TicketRequest, res: Response) => {
    const contextUserId = req.user?.userId ?? readUserId(req.header("x-user-id"));
    void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
      try {
        const userId = contextUserId ?? readUserId(req.header("x-user-id"));
        if (!userId) return sendError(res, 401, "unauthorized", "Missing authenticated user.");

        const input = sanitizeCreatePayload(req);
        const ticket = await createTicket(userId, input);

        if (input.messageBody) {
          await addMessage(userId, ticket.id, {
            body: input.messageBody,
            attachments: input.attachments,
          });
        }

        return res.status(201).json({
          ok: true,
          data: ticket,
          correlation_id: getCorrelationId(),
        });
      } catch (error) {
        log.error("tickets/create error", { err: safeError(error) });
        if (isSendableError(error)) {
          return sendError(res, error.status, error.code || "create_failed", error.message || "Unable to create ticket.");
        }
        return sendError(res, 500, "create_failed", "Unable to create ticket.");
      }
    });
  },
);

router.post(
  "/:id/messages",
  (req: TicketRequest, res: Response) => {
    const contextUserId = req.user?.userId ?? readUserId(req.header("x-user-id"));
    void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
      try {
        const userId = contextUserId ?? readUserId(req.header("x-user-id"));
        if (!userId) return sendError(res, 401, "unauthorized", "Missing authenticated user.");
        const ticketId = firstString(req.params.id);
        if (!ticketId) return sendError(res, 400, "invalid_ticket_id", "Ticket id is required.");

        await ensureTicketOwner(userId, ticketId);

        const body = sanitizeMessagePayload(req);
        const message = await addMessage(userId, ticketId, body);

        return res.status(201).json({
          ok: true,
          data: message,
          correlation_id: getCorrelationId(),
        });
      } catch (error) {
        log.error("tickets/message error", { err: safeError(error) });
        if (isSendableError(error)) {
          return sendError(res, error.status, error.code || "message_failed", error.message || "Unable to add message.");
        }
        return sendError(res, 500, "message_failed", "Unable to add message.");
      }
    });
  },
);

export default router;

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

interface ListQuery {
  state?: string;
  limit: number;
  offset: number;
}

interface TicketSummary {
  id: string;
  subject: string;
  state: string;
  priority: string;
  category: string;
  tags: string[];
  last_message_at: string | null;
  created_at: string | null;
  sla_due_at: string | null;
  meta: Record<string, unknown>;
}

interface TicketMessage {
  id: string;
  ticket_id: string;
  body_text: string;
  attachments: Array<Record<string, unknown>>;
  created_at: string | null;
}

async function listTickets(userId: string, query: ListQuery): Promise<{ items: TicketSummary[]; next_cursor?: string }> {
  let builder = supabase
    .from("tickets")
    .select("id, subject, state, priority, category, tags, last_message_at, created_at, sla_due_at, meta")
    .eq("user_id", userId)
    // Use nullsFirst: false to push nulls last in supported typings
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(query.offset, query.offset + query.limit);

  if (query.state) builder = builder.eq("state", query.state);

  const { data, error } = await builder;
  if (error) handleDbError("list_tickets", error);

  const rows: Record<string, unknown>[] = Array.isArray(data) ? data.filter(isRecord) : [];
  const hasMore = rows.length > query.limit;
  const slice = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: slice.map(mapTicketRow),
    next_cursor: hasMore ? encodeCursor(query.offset + query.limit) : undefined,
  };
}

function mapTicketRow(row: Record<string, unknown>): TicketSummary {
  const id = firstString(row["id"]);
  if (!id) {
    throw sendableError(500, "ticket_invalid", "Ticket record is missing id.");
  }
  const tagsSource = row["tags"];
  const tags = Array.isArray(tagsSource)
    ? tagsSource
        .map((entry) => firstString(entry))
        .filter((tag): tag is string => Boolean(tag))
        .slice(0, 20)
    : [];
  const metaSource = row["meta"];
  const meta = isRecord(metaSource) ? metaSource : {};
  return {
    id,
    subject: firstString(row["subject"]) ?? "",
    state: firstString(row["state"]) ?? "open",
    priority: firstString(row["priority"]) ?? "normal",
    category: firstString(row["category"]) ?? "other",
    tags,
    last_message_at: firstString(row["last_message_at"] ?? row["created_at"]) ?? null,
    created_at: firstString(row["created_at"]) ?? null,
    sla_due_at: firstString(row["sla_due_at"]) ?? null,
    meta,
  };
}

function mapTicketMessage(record: Record<string, unknown>, fallbackTicketId: string): TicketMessage {
  const id = firstString(record["id"]);
  if (!id) {
    throw sendableError(500, "message_invalid", "Ticket message record is missing id.");
  }
  const ticketId = firstString(record["ticket_id"]) ?? fallbackTicketId;
  return {
    id,
    ticket_id: ticketId,
    body_text: firstString(record["body_text"]) ?? "",
    attachments: toAttachmentArray(record["attachments"]),
    created_at: firstString(record["created_at"]) ?? null,
  };
}

interface CreateTicketInput {
  subject: string;
  category?: string;
  priority?: string;
  tags: string[];
  meta: Record<string, unknown>;
  reporter_email?: string | null;
  reporter_name?: string | null;
  messageBody?: string;
  attachments?: Array<Record<string, unknown>>;
}

async function createTicket(userId: string, input: CreateTicketInput): Promise<TicketSummary> {
  const payload = {
    user_id: userId,
    subject: input.subject,
    category: input.category ?? "other",
    priority: input.priority ?? "normal",
    tags: input.tags,
    meta: input.meta,
    reporter_email: input.reporter_email ?? null,
    reporter_name: input.reporter_name ?? null,
  };

  const insertResult = await supabase.from("tickets").insert(payload).select("*").single();
  if (insertResult.error) handleDbError("create_ticket", insertResult.error);
  const record = expectRecord(insertResult.data, "create_ticket");
  return mapTicketRow(record);
}

async function addMessage(
  userId: string,
  ticketId: string,
  input: { body: string; attachments?: Array<Record<string, unknown>> },
): Promise<TicketMessage> {
  const payload = {
    ticket_id: ticketId,
    author_type: "user",
    author_id: userId,
    body_text: input.body,
    attachments: Array.isArray(input.attachments) ? input.attachments.slice(0, 10) : [],
  };

  const insertResult = await supabase.from("ticket_messages").insert(payload).select("*").single();
  if (insertResult.error) handleDbError("add_message", insertResult.error);
  const record = expectRecord(insertResult.data, "add_message");
  return mapTicketMessage(record, ticketId);
}

async function ensureTicketOwner(userId: string, ticketId: string) {
  const { data, error } = await supabase
    .from("tickets")
    .select("id")
    .eq("id", ticketId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) handleDbError("ensure_ticket", error);
  if (!isRecord(data)) {
    throw sendableError(404, "ticket_not_found", "Ticket could not be found.");
  }
}

// -----------------------------------------------------------------------------
// Validators
// -----------------------------------------------------------------------------

function sanitizeListQuery(req: Request): ListQuery {
  const limit = clampInt(firstNumber(req.query.limit), 1, 50, 20);
  const cursor = decodeCursor(firstString(req.query.cursor));
  const state = firstString(req.query.state);
  return { limit, offset: cursor, state: state || undefined };
}

function sanitizeCreatePayload(req: Request): CreateTicketInput {
  const body = getBody(req.body);
  const subject = firstString(body.subject);
  if (!subject) throw sendableError(400, "invalid_subject", "subject is required.");
  const messageBody = firstString(body.message ?? body.body ?? body.message_body);
  const attachments = toAttachmentList(body.attachments);

  return {
    subject: subject.slice(0, 200),
    category: firstString(body.category) ?? undefined,
    priority: firstString(body.priority) ?? undefined,
    tags: toTags(body.tags),
    meta: toMeta(body.meta),
    reporter_email: firstString(body.reporter_email) ?? null,
    reporter_name: firstString(body.reporter_name) ?? null,
    messageBody: messageBody || undefined,
    attachments,
  };
}

function sanitizeMessagePayload(req: Request): { body: string; attachments?: Array<Record<string, unknown>> } {
  const bodyRecord = getBody(req.body);
  const body = firstString(bodyRecord.body ?? bodyRecord.message);
  if (!body) throw sendableError(400, "invalid_body", "body is required.");
  const attachments = toAttachmentList(bodyRecord.attachments);
  return { body: body.slice(0, 4000), attachments };
}

function toTags(value: unknown): string[] {
  const tags: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const tag = firstString(entry);
      if (!tag) continue;
      tags.push(tag.slice(0, 40));
      if (tags.length >= 10) break;
    }
    return tags;
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => tag.slice(0, 40))
      .slice(0, 10);
  }
  return [];
}

function toMeta(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------

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
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value as number)));
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

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  });
}

function handleDbError(label: string, error: { message?: string }) {
  log.error(`tickets ${label} failed`, { err: safeError(error) });
  throw sendableError(500, "db_error", "Database query failed.");
}

function sendableError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

type SendableErrorShape = Error & { status: number; code?: string };

function isSendableError(value: unknown): value is SendableErrorShape {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as Partial<SendableErrorShape>).status === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getBody(body: unknown): Record<string, unknown> {
  return isRecord(body) ? body : {};
}

function toAttachmentList(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    attachments.push(entry);
    if (attachments.length >= 10) break;
  }
  return attachments.length ? attachments : undefined;
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

function expectRecord(value: unknown, context: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw sendableError(500, "invalid_response", `${context} returned invalid payload.`);
}

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}
