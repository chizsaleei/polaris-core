// src/server/routes/drip/complete.ts
/**
 * Simple endpoint for drip emails to mark a queue item as completed.
 *
 * Expected request:
 *  POST /drip/complete
 *  Headers: { "x-user-id": "<uuid>" } (proxied by Next.js)
 *  Body: { queueId: string, reason?: string }
 *
 * Behaviour:
 *  - verifies the queue row exists and belongs to the user
 *  - idempotent (completing twice is a no-op)
 *  - updates status/completed timestamp (best-effort for schema variations)
 *  - logs completion to the events table when available
 */

import { Router, type Request, type Response } from "express";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type RequestWithUser = Request & { user?: { id?: string | null } };
interface QueueRow {
  id: string;
  user_id: string | null;
  status: string | null;
  category: string | null;
}

router.post("/", (req: Request, res: Response) => {
  const request = req as RequestWithUser;
  const contextUserId = readUserId(request.user?.id) ?? readUserId(req.header("x-user-id"));

  void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
    try {
      const userId = contextUserId ?? readUserId(req.header("x-user-id"));
      if (!userId) {
        return sendError(res, 401, "unauthorized", "Missing user id.");
      }

      const payload = sanitizePayload(req.body);
      if (!payload.queueId) return sendError(res, 400, "invalid_queue_id", "queueId is required.");

      const supabase = createClient();
      const queue = await fetchQueueRow(supabase, payload.queueId);
      if (!queue) return sendError(res, 404, "queue_not_found", "Drip queue item not found.");

      if (queue.user_id && queue.user_id !== userId) {
        return sendError(res, 403, "forbidden", "Queue item does not belong to this user.");
      }

      const alreadyCompleted = isCompleted(queue.status);
      if (!alreadyCompleted) {
        await markCompleted(supabase, payload.queueId, payload.reason);
        await logEvent(supabase, {
          userId,
          queueId: payload.queueId,
          category: queue.category,
          reason: payload.reason,
        });
      }

      return res.status(200).json({
        ok: true,
        data: {
          queue_id: payload.queueId,
          status: "completed",
          already_completed: alreadyCompleted,
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      const httpError = parseHttpError(error, "Unable to complete drip action.");
      if (httpError.status >= 500) log.error("drip/complete error", { err: safeError(error) });
      return sendError(res, httpError.status, httpError.code, httpError.message);
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

async function fetchQueueRow(supabase: Supabase, queueId: string): Promise<QueueRow | null> {
  try {
    const { data, error } = await supabase
      .from("drip_queue")
      .select("id, user_id, status, category")
      .eq("id", queueId)
      .maybeSingle();

    if (error) {
      if (isMissingRelation(error)) throw makeHttpError(501, "not_supported", "drip_queue table not available.");
      handleDbError("fetch_queue", error);
    }
    if (!data) return null;
    const record = toRecord(data);
    if (!record) return null;
    return createQueueRow(record);
  } catch (error) {
    const known = toRecord(error);
    if (known?.code === "not_supported") throw error;
    throw error;
  }
}

async function markCompleted(supabase: Supabase, queueId: string, reason?: string) {
  const now = new Date().toISOString();
  const attempts: Array<Record<string, unknown>> = [
    { status: "completed", completed_at: now, reason_completed: reason ?? null },
    { status: "completed", completed_ts: now },
    { status: "completed" },
  ];

  for (const patch of attempts) {
    const { error } = await supabase.from("drip_queue").update(patch).eq("id", queueId);

    if (!error) return true;
    if (isMissingColumnError(error)) continue;
    if (isMissingRelation(error)) throw makeHttpError(501, "not_supported", "drip_queue table not available.");
    handleDbError("update_queue", error);
  }

  return false;
}

async function logEvent(
  supabase: Supabase,
  input: { userId: string; queueId: string; category: string | null; reason?: string },
) {
  try {
    const { error } = await supabase.from("events").insert({
      user_id: input.userId,
      type: "feedback_viewed",
      metadata: {
        source: "drip_queue",
        queue_id: input.queueId,
        category: input.category,
        reason: input.reason ?? null,
      },
    });

    if (error && !isMissingRelation(error) && !isMissingColumnError(error)) {
      log.warn("drip/complete events insert failed", { err: safeError(error) });
    }
  } catch (error) {
    log.warn("drip/complete events insert threw", { err: safeError(error) });
  }
}

function isCompleted(status?: string | null) {
  if (!status) return false;
  const normalized = status.toLowerCase();
  return ["completed", "sent", "dismissed"].includes(normalized);
}

function createQueueRow(record: Record<string, unknown>): QueueRow | null {
  const id = readNullableString(record.id);
  if (!id) return null;
  return {
    id,
    user_id: readNullableString(record.user_id),
    status: readNullableString(record.status),
    category: readNullableString(record.category),
  };
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

interface CompletePayload {
  queueId?: string;
  reason?: string;
}

function sanitizePayload(body: unknown): CompletePayload {
  const source = toRecord(body) ?? {};
  const queueId = firstString(source.queueId ?? source.queue_id);
  const reason = firstString(source.reason)?.slice(0, 200);
  const payload: CompletePayload = {};
  if (queueId && isUuid(queueId)) payload.queueId = queueId;
  if (reason) payload.reason = reason;
  return payload;
}


// -----------------------------------------------------------------------------
// Utility helpers
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
  log.error(`drip/complete ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function isMissingRelation(error: unknown) {
  const msg = readErrorMessage(error).toLowerCase();
  return msg.includes("does not exist") || msg.includes("missing") || msg.includes("undefined table");
}

function isMissingColumnError(error: unknown) {
  const msg = readErrorMessage(error).toLowerCase();
  return msg.includes("column") && msg.includes("does not exist");
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

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function readNullableString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return null;
}

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function readErrorMessage(value: unknown): string {
  const record = toRecord(value);
  if (record && typeof record.message === "string") {
    return record.message;
  }
  return "";
}
