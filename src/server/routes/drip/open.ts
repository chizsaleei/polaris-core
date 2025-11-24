// src/server/routes/drip/open.ts
/**
 * Marks a drip queue item as opened / viewed.
 * Similar to /drip/complete but preserves pending status so users can still act on the email.
 *
 * Request:
 *   POST /drip/open
 *   Headers: x-user-id
 *   Body: { queueId: string }
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { PostgrestError } from "@supabase/supabase-js";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import type { AuthInfo } from "../../middleware/auth";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type DripOpenRequest = Request<ParamsDictionary> & { user?: AuthInfo };

router.post("/", (req: DripOpenRequest, res: Response) => {
  const headerUser = req.header("x-user-id");
  const contextUserId =
    req.user?.userId ?? (typeof headerUser === "string" ? headerUser.trim() : undefined);

  void runWithRequestContext(
    { headers: req.headers, user_id: contextUserId },
    async () => {
      try {
        const userId = contextUserId ?? "";
        if (!userId) {
          sendError(res, 401, "unauthorized", "Missing user id.");
          return;
        }

        const payload = sanitizePayload(req.body);
        if (!payload.queueId) {
          sendError(res, 400, "invalid_queue_id", "queueId is required.");
          return;
        }

        const supabase = createClient();
        const queue = await fetchQueueRow(supabase, payload.queueId);
        if (!queue) {
          sendError(res, 404, "queue_not_found", "Drip queue item not found.");
          return;
        }
        if (queue.user_id && queue.user_id !== userId) {
          sendError(res, 403, "forbidden", "Queue item does not belong to this user.");
          return;
        }

        const alreadyOpened = isOpened(queue.status);
        if (!alreadyOpened) {
          await markOpened(supabase, payload.queueId);
          await logEvent(supabase, {
            userId,
            queueId: payload.queueId,
            category: queue.category ?? null,
          });
        }

        res.status(200).json({
          ok: true,
          data: {
            queue_id: payload.queueId,
            opened: true,
            already_opened: alreadyOpened,
          },
          correlation_id: getCorrelationId(),
        });
      } catch (error: unknown) {
        const parsed = parseHttpError(error);
        const message =
          parsed.status === 500 ? "Unable to mark drip as opened." : parsed.message ?? "Unable to mark drip as opened.";
        if (parsed.status >= 500) log.error("drip/open error", { err: safeError(error) });
        sendError(res, parsed.status, parsed.code, message);
      }
    },
  );
});

export default router;

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

interface DripQueueRow {
  id: string;
  user_id: string | null;
  status: string | null;
  category: string | null;
}

async function fetchQueueRow(
  supabase: Supabase,
  queueId: string,
): Promise<DripQueueRow | null> {
  const { data, error } = await supabase
    .from("drip_queue")
    .select("id, user_id, status, category")
    .eq("id", queueId)
    .maybeSingle();
  const dbError: PostgrestError | null = error;
  if (dbError) {
    if (isMissingRelation(dbError)) throw makeHttpError(501, "not_supported", "drip_queue table not available.");
    handleDbError("fetch_queue", dbError);
  }
  if (!isRecord(data)) return null;
  return {
    id: firstString(data.id) ?? queueId,
    user_id: firstString(data.user_id) ?? null,
    status: firstString(data.status) ?? null,
    category: firstString(data.category) ?? null,
  };
}

async function markOpened(supabase: Supabase, queueId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const attempts: Array<Record<string, unknown>> = [
    { opened_at: now, status: "opened" },
    { metrics: { opened_at: now } },
    { status: "opened" },
  ];

  for (const patch of attempts) {
    const { error } = await supabase
      .from("drip_queue")
      .update(patch)
      .eq("id", queueId);
    const dbError: PostgrestError | null = error;
    if (!dbError) return true;
    if (isMissingColumnError(dbError)) continue;
    if (isMissingRelation(dbError)) throw makeHttpError(501, "not_supported", "drip_queue table not available.");
    handleDbError("update_queue", dbError);
  }
  return false;
}

async function logEvent(
  supabase: Supabase,
  input: { userId: string; queueId: string; category: string | null },
) {
  try {
    const { error } = await supabase.from("events").insert({
      user_id: input.userId,
      type: "drill_opened",
      metadata: {
        source: "drip_queue",
        queue_id: input.queueId,
        category: input.category,
      },
    });
    const dbError: PostgrestError | null = error;
    if (dbError && !isMissingRelation(dbError) && !isMissingColumnError(dbError)) {
      log.warn("drip/open events insert failed", { err: safeError(dbError) });
    }
  } catch (error: unknown) {
    log.warn("drip/open events insert threw", { err: safeError(error) });
  }
}

function isOpened(status?: string | null) {
  if (!status) return false;
  const normalized = status.toLowerCase();
  return ["opened", "viewed", "completed", "sent", "dismissed"].includes(normalized);
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

interface OpenPayload {
  queueId?: string;
}

function sanitizePayload(body: unknown): OpenPayload {
  const source = isRecord(body) ? body : {};
  const queueId = firstString(source.queueId ?? source.queue_id);
  return queueId && isUuid(queueId) ? { queueId } : {};
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

function handleDbError(label: string, error: { message?: string } | PostgrestError) {
  log.error(`drip/open ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function isMissingRelation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeMessage = "message" in error ? (error as { message?: unknown }).message : undefined;
  const normalized = typeof maybeMessage === "string" ? maybeMessage.toLowerCase() : "";
  return normalized.includes("does not exist") || normalized.includes("undefined table") || normalized.includes("missing");
}

function isMissingColumnError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeMessage = "message" in error ? (error as { message?: unknown }).message : undefined;
  const normalized = typeof maybeMessage === "string" ? maybeMessage.toLowerCase() : "";
  return normalized.includes("column") && normalized.includes("does not exist");
}

function parseHttpError(error: unknown): { status: number; code: string; message?: string } {
  if (isRecord(error)) {
    const status = typeof error.status === "number" ? error.status : 500;
    const code = typeof error.code === "string" ? error.code : "internal_error";
    const message = typeof error.message === "string" ? error.message : undefined;
    return { status, code, message };
  }
  return { status: 500, code: "internal_error" };
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const str = firstString(entry);
      if (str) return str;
    }
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
