// src/server/routes/drip/list.ts
/**
 * List drip queue items for current user.
 *
 * Query params:
 *   - status?: pending|completed|all (default pending)
 *   - limit?: 1..50 (default 10)
 */

import { Router, type Request, type Response } from "express";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type RequestWithUser = Request & { user?: { id?: string | null } };

interface QueueItem {
  id: string;
  category: string | null;
  status: string | null;
  subject: string | null;
  to: string | null;
  provider: string | null;
  window_start: string | null;
  window_end: string | null;
  created_at: string | null;
  sent_at: string | null;
  completed_at: string | null;
  template: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
}

router.get("/", (req: Request, res: Response) => {
  const request = req as RequestWithUser;
  const contextUserId = readUserId(request.user?.id) ?? readUserId(req.header("x-user-id"));

  void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
    try {
      const userId = contextUserId ?? readUserId(req.header("x-user-id"));
      if (!userId) {
        return sendError(res, 401, "unauthorized", "Missing user id.");
      }

      const query = sanitizeQuery(req);
      const supabase = createClient();
      const rows = await fetchQueueItems(supabase, userId, query);

      return res.status(200).json({
        ok: true,
        data: {
          items: rows,
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      const httpError = parseHttpError(error, "Unable to load drip queue.");
      if (httpError.status >= 500) log.error("drip/list error", { err: safeError(error) });
      return sendError(res, httpError.status, httpError.code, httpError.message);
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Data
// -----------------------------------------------------------------------------

interface ListQuery {
  status: "pending" | "completed" | "all";
  limit: number;
}

async function fetchQueueItems(supabase: Supabase, userId: string, query: ListQuery) {
  try {
    let builder = supabase
      .from("drip_queue")
      .select(
        [
          "id",
          "category",
          "status",
          "subject",
          "to_email",
          "window_start",
          "window_end",
          "provider",
          "created_at",
          "sent_at",
          "completed_at",
          "template_json",
          "meta",
        ].join(","),
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(query.limit);

    if (query.status !== "all") {
      if (query.status === "pending") {
        builder = builder.in("status", ["queued", "pending", "sending"]);
      } else if (query.status === "completed") {
        builder = builder.in("status", ["completed", "sent", "dismissed"]);
      }
    }

    const { data, error } = await builder;
    if (error) {
      if (isMissingRelation(error)) {
        throw makeHttpError(501, "not_supported", "drip_queue table not available.");
      }
      handleDbError("fetch_queue", error);
    }

    if (!Array.isArray(data) || !data.length) return [];
    const rows: QueueItem[] = [];
    for (const row of data) {
      const record = toRecord(row);
      if (!record) continue;
      const mapped = mapQueueRow(record);
      if (mapped) rows.push(mapped);
    }
    return rows;
  } catch (error) {
    const known = toRecord(error);
    if (known?.code === "not_supported") throw error;
    throw error;
  }
}

function mapQueueRow(record: Record<string, unknown>): QueueItem | null {
  const id = readNullableString(record.id);
  if (!id) return null;
  return {
    id,
    category: readNullableString(record.category),
    status: readNullableString(record.status),
    subject: readNullableString(record.subject),
    to: readNullableString(record.to_email),
    provider: readNullableString(record.provider),
    window_start: readNullableString(record.window_start),
    window_end: readNullableString(record.window_end),
    created_at: readNullableString(record.created_at),
    sent_at: readNullableString(record.sent_at),
    completed_at: readNullableString(record.completed_at),
    template: toRecord(record.template_json),
    meta: toRecord(record.meta),
  };
}

// -----------------------------------------------------------------------------
// Query helpers
// -----------------------------------------------------------------------------

function sanitizeQuery(req: Request): ListQuery {
  const rawStatus = firstString(req.query.status) || "pending";
  const status = normalizeStatus(rawStatus);
  const limit = clampInt(firstNumber(req.query.limit), 1, 50, 10);
  return { status, limit };
}

function normalizeStatus(value: string): ListQuery["status"] {
  const key = value.toLowerCase();
  if (key === "pending" || key === "completed" || key === "all") return key;
  return "pending";
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value as number)));
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

function makeHttpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

interface HttpErrorShape {
  status: number;
  code: string;
  message: string;
}

function parseHttpError(error: unknown, fallbackMessage: string): HttpErrorShape {
  const fallback: HttpErrorShape = { status: 500, code: "internal_error", message: fallbackMessage };
  const record = toRecord(error);
  if (!record) return fallback;

  const status = typeof record.status === "number" ? record.status : fallback.status;
  const code = typeof record.code === "string" && record.code ? record.code : fallback.code;
  if (status === 500) return { status, code, message: fallback.message };
  const message = readErrorMessage(record) || fallback.message;
  return { status, code, message };
}

function handleDbError(label: string, error: unknown) {
  log.error(`drip/list ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function isMissingRelation(error: unknown) {
  const msg = readErrorMessage(error).toLowerCase();
  return msg.includes("does not exist") || msg.includes("undefined table");
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
    const str = value.trim();
    return str.length ? str : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  return undefined;
}

function firstNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return null;
}

function readNullableString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function readErrorMessage(error: unknown): string {
  const record = toRecord(error);
  if (record && typeof record.message === "string") {
    return record.message;
  }
  return "";
}
