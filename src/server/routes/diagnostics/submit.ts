import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();

interface SubmitPayload {
  runId?: string;
  runItemId?: string;
  score?: number;
  durationSec: number;
  responseText?: string;
  responseUrl?: string;
  completeRun: boolean;
}

type Supabase = ReturnType<typeof createClient>;

interface RunRow {
  id: string;
  user_id: string;
  state: string;
}

interface RunItemRow {
  id: string;
  run_id: string;
  status: string;
}

type SubmitRequest = Request<ParamsDictionary, unknown, SubmitBody>;

type SubmitBody = Partial<Record<string, unknown>>;

router.post("/", (req: SubmitRequest, res: Response) => {
  void runWithRequestContext({ headers: req.headers, user_id: req.user?.userId }, async () => {
    try {
      const userId = req.user?.userId || req.header("x-user-id");
      if (!userId) {
        sendError(res, 401, "unauthorized", "Missing user id.");
        return;
      }

      const payload = sanitizePayload(req.body);
      const issues = validatePayload(payload);
      if (issues.length) {
        sendError(res, 400, "invalid_payload", issues.join(" | "));
        return;
      }

      const supabase = createClient();

      const run = await fetchRun(supabase, payload.runId!);
      if (!run) {
        sendError(res, 404, "run_not_found", "Diagnostic run not found.");
        return;
      }
      if (run.user_id !== userId) {
        sendError(res, 403, "forbidden", "Diagnostic run does not belong to user.");
        return;
      }
      if (run.state === "completed") {
        sendError(res, 409, "already_completed", "Diagnostic run already completed.");
        return;
      }

      const runItem = await fetchRunItem(supabase, payload.runItemId!);
      if (!runItem) {
        sendError(res, 404, "item_not_found", "Diagnostic run item not found.");
        return;
      }
      if (runItem.run_id !== run.id) {
        sendError(res, 400, "invalid_item", "Run item does not belong to this run.");
        return;
      }
      if (runItem.status === "scored") {
        sendError(res, 409, "already_scored", "Run item already submitted.");
        return;
      }

      await submitRunItem(supabase, payload);

      let completed = false;
      if (payload.completeRun) {
        await completeRun(supabase, run.id);
        completed = true;
      }

      res.status(200).json({
        ok: true,
        data: {
          runId: run.id,
          runItemId: runItem.id,
          completed,
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      log.error("diagnostics/submit error", { err: safeError(error) });
      const httpError = parseHttpError(error);
      const fallbackMessage =
        httpError.status === 500 ? "Unable to submit diagnostic item." : httpError.message ?? undefined;
      sendError(res, httpError.status, httpError.code, fallbackMessage || "Unable to submit diagnostic item.");
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

async function fetchRun(supabase: Supabase, runId: string): Promise<RunRow | null> {
  const { data, error } = await supabase
    .from("diagnostic_runs")
    .select("id, user_id, state")
    .eq("id", runId)
    .maybeSingle();

  if (error) handleDbError("fetch_run", error);
  return (data as RunRow) ?? null;
}

async function fetchRunItem(supabase: Supabase, runItemId: string): Promise<RunItemRow | null> {
  const { data, error } = await supabase
    .from("diagnostic_run_items")
    .select("id, run_id, status")
    .eq("id", runItemId)
    .maybeSingle();

  if (error) handleDbError("fetch_run_item", error);
  return (data as RunItemRow) ?? null;
}

async function submitRunItem(supabase: Supabase, payload: SubmitPayload) {
  const { error } = await supabase.rpc("diagnostic_submit_item", {
    p_run_item_id: payload.runItemId,
    p_outcome_score: payload.score ?? null,
    p_duration_sec: payload.durationSec,
    p_response_text: payload.responseText ?? null,
    p_response_url: payload.responseUrl ?? null,
  } as any);

  if (error) handleDbError("submit_item", error);
}

async function completeRun(supabase: Supabase, runId: string) {
  const { error } = await supabase.rpc("diagnostic_complete_run", { p_run_id: runId } as any);
  if (error) handleDbError("complete_run", error);
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

function sanitizePayload(raw: unknown): SubmitPayload {
  const source: Record<string, unknown> = isPlainObject(raw) ? raw : {};
  const runId = firstString(source.runId ?? source.run_id);
  const runItemId = firstString(source.runItemId ?? source.run_item_id ?? source.itemId ?? source.item_id);
  const score = clamp01(toNumber(source.score ?? source.outcome ?? source.result));
  const durationSec = toDuration(
    source.durationSec ??
      source.duration_sec ??
      source.duration ??
      source.seconds ??
      source.timeSec ??
      source.time_sec,
  );
  const responseText = sanitizeText(source.responseText ?? source.response_text ?? source.answer);
  const responseUrl = normalizeUrl(firstString(source.responseUrl ?? source.response_url));
  const completeRun = parseBoolean(source.completeRun ?? source.complete ?? source.finish ?? source.complete_run);

  return {
    runId,
    runItemId,
    score,
    durationSec: durationSec ?? 0,
    responseText,
    responseUrl,
    completeRun,
  };
}

function validatePayload(payload: SubmitPayload) {
  const issues: string[] = [];
  if (!payload.runId || !isUuid(payload.runId)) issues.push("runId is required and must be a UUID");
  if (!payload.runItemId || !isUuid(payload.runItemId)) issues.push("runItemId is required and must be a UUID");
  if (typeof payload.score !== "number" || Number.isNaN(payload.score)) {
    issues.push("score is required and must be between 0 and 1");
  }
  if (payload.durationSec == null || payload.durationSec < 0 || payload.durationSec > 7200) {
    issues.push("durationSec must be between 0 and 7200 seconds");
  }
  return issues;
}

function sanitizeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return truncate(trimmed, 4000);
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

function handleDbError(label: string, error: { message: string }) {
  log.error(`diagnostics/submit ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function parseHttpError(error: unknown): { status: number; code: string; message?: string } {
  if (isPlainObject(error)) {
    const status = typeof error.status === "number" ? error.status : 500;
    const code = typeof error.code === "string" ? error.code : "internal_error";
    const message = typeof error.message === "string" ? error.message : undefined;
    return { status, code, message };
  }
  return { status: 500, code: "internal_error" };
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const str = firstString(item);
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
  return undefined;
}

function parseBoolean(value: unknown): boolean {
  if (value == null) return false;
  const str = firstString(value);
  if (!str) return false;
  return ["1", "true", "yes", "on"].includes(str.toLowerCase());
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function toNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function clamp01(value?: number): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function toDuration(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  if (!Number.isFinite(num)) return undefined;
  const rounded = Math.round(num);
  if (rounded < 0) return 0;
  if (rounded > 7200) return 7200;
  return rounded;
}

function truncate(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeUrl(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim().slice(0, 2048);
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
