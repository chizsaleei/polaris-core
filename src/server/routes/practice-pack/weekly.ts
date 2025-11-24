// src/server/routes/practice-pack/weekly.ts
/**
 * Weekly Practice Pack
 *
 * Returns a short plan for the current week:
 *   - up to three drills (id + title)
 *   - how many vocabulary items are due for review
 *   - a single reflection prompt
 *
 * Data primarily comes from the `weekly_recaps` table, with graceful fallbacks
 * to deterministic drill picks so new users still receive a plan.
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { PostgrestError } from "@supabase/supabase-js";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import type { AuthInfo } from "../../middleware/auth";

const DEFAULT_REFLECTION_PROMPT = "What worked and what will you change next week";
const MAX_DRILLS = 3;

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type WeeklyRequest = Request<ParamsDictionary> & { user?: AuthInfo };

router.get("/", (req: WeeklyRequest, res: Response) => {
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

        const supabase = createClient();
        const pack = await buildWeeklyPack(supabase, userId);

        res.status(200).json({
          ok: true,
          data: pack,
          correlation_id: getCorrelationId(),
        });
      } catch (error: unknown) {
        log.error("practice-pack/weekly error", { err: safeError(error) });
        const parsed = parseHttpError(error);
        const message =
          parsed.status === 500 ? "Unable to load weekly pack." : parsed.message ?? "Unable to load weekly pack.";
        sendError(res, parsed.status, parsed.code, message);
      }
    },
  );
});

export default router;

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

interface WeeklyPackResponse {
  week_of: string;
  drills: PracticeDrill[];
  vocab_review_count: number;
  reflection_prompt: string;
}

interface PracticeDrill {
  drill_id: string;
  title: string;
}

interface RecapRow {
  week_start_date?: string | null;
  summary?: Record<string, any> | null;
  next_drills?: unknown;
}

interface RequestedDrill {
  id: string;
  title?: string;
}

async function buildWeeklyPack(supabase: Supabase, userId: string): Promise<WeeklyPackResponse> {
  const [recap, vocabCount] = await Promise.all([
    fetchLatestWeeklyRecap(supabase, userId),
    fetchVocabReviewCount(supabase, userId),
  ]);

  const requestedDrills = recap ? extractRequestedDrills(recap.next_drills) : [];
  let drills = requestedDrills.length ? await fetchDrillSummaries(supabase, requestedDrills) : [];

  if (!drills.length) {
    drills = await fetchPracticeNowFallback(supabase, MAX_DRILLS);
  }

  const normalizedDrills = drills.slice(0, MAX_DRILLS);

  return {
    week_of: recap?.week_start_date ? toDateOnly(recap.week_start_date) : currentWeekAnchor(),
    drills: normalizedDrills,
    vocab_review_count: vocabCount,
    reflection_prompt: DEFAULT_REFLECTION_PROMPT,
  };
}

// -----------------------------------------------------------------------------
// Data fetchers
// -----------------------------------------------------------------------------

async function fetchLatestWeeklyRecap(supabase: Supabase, userId: string): Promise<RecapRow | null> {
  const { data, error } = await supabase
    .from("weekly_recaps")
    .select("week_start_date, summary, next_drills")
    .eq("user_id", userId)
    .order("week_start_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const dbError: PostgrestError | null = error;
  if (dbError) {
    if (isMissingRelation(dbError)) return null;
    handleDbError("fetch_weekly_recap", dbError);
  }

  return isRecord(data) ? (data as RecapRow) : null;
}

async function fetchDrillSummaries(supabase: Supabase, requested: RequestedDrill[]): Promise<PracticeDrill[]> {
  const ids = requested.map((r) => r.id);
  if (!ids.length) return [];

  const { data, error } = await supabase.from("drills").select("id, title").in("id", unique(ids));

  const dbError: PostgrestError | null = error;
  if (dbError) {
    if (isMissingRelation(dbError)) {
      return requested.map((entry) => ({
        drill_id: entry.id,
        title: entry.title ?? "Practice drill",
      }));
    }
    handleDbError("fetch_drill_summaries", dbError);
  }

  const rows: Array<Record<string, unknown>> = Array.isArray(data)
    ? data.reduce<Array<Record<string, unknown>>>((acc, row) => {
        if (isRecord(row)) acc.push(row);
        return acc;
      }, [])
    : [];
  const map = new Map(
    rows.map((row) => [firstString(row.id) ?? "", firstString(row.title) ?? "Practice drill"]),
  );

  return requested.map((entry) => ({
    drill_id: entry.id,
    title: map.get(entry.id) ?? entry.title ?? "Practice drill",
  }));
}

async function fetchPracticeNowFallback(supabase: Supabase, limit: number): Promise<PracticeDrill[]> {
  const rpc = await runPracticeNowRpc(supabase, limit);
  if (rpc.length) return rpc;

  const { data, error } = await supabase
    .from("drills")
    .select("id, title")
    // Remove unsupported `nullsLast`; rely on Postgres defaults
    .order("published_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(limit);

  const dbError: PostgrestError | null = error;
  if (dbError) {
    if (isMissingRelation(dbError)) return [];
    handleDbError("fetch_recent_drills", dbError);
  }

  if (!Array.isArray(data)) return [];

  return data.reduce<PracticeDrill[]>((acc, row) => {
    const drillId = firstString((row as Record<string, unknown>).id);
    if (!drillId) return acc;
    acc.push({ drill_id: drillId, title: firstString((row as Record<string, unknown>).title) ?? "Practice drill" });
    return acc;
  }, []);
}

async function runPracticeNowRpc(supabase: Supabase, limit: number): Promise<PracticeDrill[]> {
  const rpcResult = await supabase.rpc("rpc_practice_now", { p_limit: limit });
  const data: unknown = rpcResult.data;
  const dbError: PostgrestError | null = rpcResult.error;
  if (dbError) {
    if (isMissingRelation(dbError)) return [];
    const msg = String(dbError?.message || "").toLowerCase();
    if (msg.includes("function") && msg.includes("does not exist")) return [];
    handleDbError("rpc_practice_now", dbError);
  }

  if (!Array.isArray(data)) return [];

  return data.reduce<PracticeDrill[]>((acc, row) => {
    const drillId = firstString((row as Record<string, unknown>).id);
    if (!drillId) return acc;
    acc.push({
      drill_id: drillId,
      title: firstString((row as Record<string, unknown>).title) ?? "Practice drill",
    });
    return acc;
  }, []);
}

async function fetchVocabReviewCount(supabase: Supabase, userId: string): Promise<number> {
  const nowIso = new Date().toISOString();
  const { count, error } = await supabase
    .from("spaced_review_queue")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", userId)
    .lte("next_review_at", nowIso);

  const dbError: PostgrestError | null = error;
  if (dbError) {
    if (isMissingRelation(dbError)) return 0;
    handleDbError("fetch_vocab_queue", dbError);
  }

  return Math.max(0, count ?? 0);
}

// -----------------------------------------------------------------------------
// Mapping helpers
// -----------------------------------------------------------------------------

function extractRequestedDrills(payload: unknown): RequestedDrill[] {
  const source = resolveArray(payload);
  if (!source.length) return [];

  const out: RequestedDrill[] = [];
  for (const entry of source) {
    if (typeof entry === "string") {
      const id = firstString(entry);
      if (id) out.push({ id });
      continue;
    }
    if (isRecord(entry)) {
      const id = firstString(entry.drill_id ?? entry.id ?? entry.drillId);
      if (!id) continue;
      const title = firstString(entry.title ?? entry.name);
      out.push({ id, title: title || undefined });
    }
  }

  return unique(out, (item) => item.id).slice(0, MAX_DRILLS);
}

function resolveArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    if (Array.isArray(payload.drills)) return payload.drills;
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.next)) return payload.next;
  }
  return [];
}

function toDateOnly(value: string | Date | null | undefined): string {
  if (!value) return currentWeekAnchor();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return currentWeekAnchor();
  return date.toISOString().slice(0, 10);
}

function currentWeekAnchor(): string {
  const today = new Date();
  const day = today.getUTCDay() || 7; // convert Sunday(0) -> 7
  today.setUTCHours(0, 0, 0, 0);
  today.setUTCDate(today.getUTCDate() - (day - 1));
  return today.toISOString().slice(0, 10);
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
  log.error(`practice-pack/weekly ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function isMissingRelation(error: { message?: string } | PostgrestError) {
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("relation") || msg.includes("missing");
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

function unique<T>(list: T[], keyFn?: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    const key = keyFn ? keyFn(item) : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
