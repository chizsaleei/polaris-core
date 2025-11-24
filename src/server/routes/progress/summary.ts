// src/server/routes/progress/summary.ts
/**
 * GET /api/progress/summary
 *
 * High-level progress metrics for the authenticated user.
 * Prefers the v_user_progress materialized view (fast path) and falls back to
 * direct aggregation over sessions/attempts if the view is unavailable.
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { PostgrestError } from "@supabase/supabase-js";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import { startOfDayInTimezone, addDays, formatYmdInTimezone } from "../../../lib/timezone";
import type { AuthInfo } from "../../middleware/auth";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type ProgressRequest = Request<ParamsDictionary> & { user?: AuthInfo };

router.get("/", (req: ProgressRequest, res: Response) => {
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

        const timezoneHeader = req.header("x-user-timezone");
        const timezone =
          typeof timezoneHeader === "string" && timezoneHeader.trim().length > 0
            ? timezoneHeader.trim()
            : "UTC";

        const supabaseClient = createClient();
        const summary = await buildProgressSummary(supabaseClient, userId, timezone);

        res.status(200).json({
          ok: true,
          data: summary,
          correlation_id: getCorrelationId(),
        });
      } catch (error: unknown) {
        log.error("progress/summary error", { err: safeError(error) });
        const parsed = parseHttpError(error);
        const message =
          parsed.status === 500 ? "Unable to load progress summary." : parsed.message ?? "Unable to load progress summary.";
        sendError(res, parsed.status, parsed.code, message);
      }
    },
  );
});

export default router;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface ProgressSummary {
  user: {
    tier: string | null;
    active_coach_id: string | null;
    joined_at: string | null;
  };
  activity: {
    minutes_all: number;
    minutes_28d: number;
    minutes_7d: number;
    attempts_all: number;
    attempts_28d: number;
    attempts_7d: number;
    days_active_7d: number;
    last_activity_at: string | null;
  };
  performance: {
    avg_score_28d: number | null;
    avg_wpm_28d: number | null;
    pass_rate_28d: number | null;
  };
  focus: {
    top_coach_id_28d: string | null;
    top_topic_28d: string | null;
  };
  source: "view" | "fallback";
}

type ProgressViewRow = Record<string, unknown>;

interface SessionRow {
  duration_sec: number | string | null;
  started_at: string | null;
  ended_at: string | null;
}

interface AttemptRow {
  created_at: string | null;
  score: number | string | null;
  words_per_minute: number | string | null;
  passed: boolean | null;
}

interface ProfileRow {
  tier: string | null;
  created_at: string | null;
  active_coach_key: string | null;
}

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

async function buildProgressSummary(supabase: Supabase, userId: string, timezone: string): Promise<ProgressSummary> {
  const viewRow = await fetchProgressView(supabase, userId);
  if (viewRow) {
    return mapViewRow(viewRow);
  }
  return buildFallbackSummary(supabase, userId, timezone);
}

async function fetchProgressView(supabase: Supabase, userId: string): Promise<ProgressViewRow | null> {
  try {
    const response = await supabase.from("v_user_progress").select("*").eq("user_id", userId).maybeSingle();
    const dbError: PostgrestError | null = response.error;
    if (dbError) {
      if (isMissingRelation(dbError)) return null;
      handleDbError("fetch_v_user_progress", dbError);
    }
    return isRecord(response.data) ? (response.data as ProgressViewRow) : null;
  } catch (error: unknown) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
}

function mapViewRow(row: ProgressViewRow): ProgressSummary {
  return {
    user: {
      tier: firstString(row.tier_current) ?? null,
      active_coach_id: firstString(row.active_coach_id) ?? null,
      joined_at: firstString(row.user_created_at) ?? null,
    },
    activity: {
      minutes_all: round(toNumber(row.minutes_all) ?? 0, 2),
      minutes_28d: round(toNumber(row.minutes_28d) ?? 0, 2),
      minutes_7d: round(toNumber(row.minutes_7d) ?? 0, 2),
      attempts_all: toNumber(row.attempts_all) ?? 0,
      attempts_28d: toNumber(row.attempts_28d) ?? 0,
      attempts_7d: toNumber(row.attempts_7d) ?? 0,
      days_active_7d: toNumber(row.days_active_7d) ?? 0,
      last_activity_at: firstString(row.last_activity_at) ?? null,
    },
    performance: {
      avg_score_28d: normalizeFloat(row.avg_score_28d),
      avg_wpm_28d: normalizeFloat(row.avg_wpm_28d),
      pass_rate_28d: normalizeFloat(row.pass_rate_28d),
    },
    focus: {
      top_coach_id_28d: firstString(row.top_coach_id_28d) ?? null,
      top_topic_28d: firstString(row.top_topic_28d) ?? null,
    },
    source: "view",
  };
}

async function buildFallbackSummary(supabase: Supabase, userId: string, timezone: string): Promise<ProgressSummary> {
  const [profile, sessionsResponse, attemptsResponse, attemptsCountResponse] = await Promise.all([
    fetchProfile(supabase, userId),
    supabase.from("sessions").select("duration_sec, started_at, ended_at").eq("user_id", userId),
    supabase.from("attempts").select("created_at, score, words_per_minute, passed").eq("user_id", userId),
    supabase.from("attempts").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);

  const sessionError: PostgrestError | null = sessionsResponse.error;
  if (sessionError) handleDbError("fetch_sessions_fallback", sessionError);
  const attemptError: PostgrestError | null = attemptsResponse.error;
  if (attemptError) handleDbError("fetch_attempts_fallback", attemptError);
  const attemptCountError: PostgrestError | null = attemptsCountResponse.error;
  if (attemptCountError) handleDbError("count_attempts_fallback", attemptCountError);

  const sessions: SessionRow[] = Array.isArray(sessionsResponse.data)
    ? sessionsResponse.data.filter(isSessionRow)
    : [];
  const attempts: AttemptRow[] = Array.isArray(attemptsResponse.data)
    ? attemptsResponse.data.filter(isAttemptRow)
    : [];

  const now = new Date();
  const startOfToday = startOfDayInTimezone(now, timezone);
  const start7Date = addDays(startOfToday, -7);
  const start28Date = addDays(startOfToday, -28);
  const start7 = start7Date.toISOString();
  const start28 = start28Date.toISOString();

  const minutesAll = sessions.reduce((sum, session) => sum + computeSessionMinutes(session), 0);
  const minutes28 = sessions
    .filter((session) => isOnOrAfter(session.started_at, start28))
    .reduce((sum, session) => sum + computeSessionMinutes(session), 0);
  const minutes7 = sessions
    .filter((session) => isOnOrAfter(session.started_at, start7))
    .reduce((sum, session) => sum + computeSessionMinutes(session), 0);

  const daysActiveSet = new Set<string>();
  sessions.forEach((session) => {
    const started = firstString(session.started_at);
    if (!started) return;
    if (isOnOrAfter(started, start7)) {
      daysActiveSet.add(formatYmdInTimezone(started, timezone));
    }
  });

  const attemptsAll =
    typeof attemptsCountResponse.count === "number" ? attemptsCountResponse.count : attempts.length;
  const attempts28 = attempts.filter((attempt) => isOnOrAfter(attempt.created_at, start28)).length;
  const attempts7 = attempts.filter((attempt) => isOnOrAfter(attempt.created_at, start7)).length;

  const attemptsWindow = attempts.filter((attempt) => isOnOrAfter(attempt.created_at, start28));
  const avgScore28 =
    attemptsWindow.length > 0
      ? attemptsWindow.reduce((sum, attempt) => sum + (toNumber(attempt.score) ?? 0), 0) / attemptsWindow.length
      : null;
  const avgWpm28 =
    attemptsWindow.length > 0
      ? attemptsWindow.reduce((sum, attempt) => sum + (toNumber(attempt.words_per_minute) ?? 0), 0) /
        attemptsWindow.length
      : null;
  const passRate28 =
    attemptsWindow.length > 0
      ? attemptsWindow.filter((attempt) => attempt.passed === true).length / attemptsWindow.length
      : null;

  const lastActivity = latestTimestamp([
    ...sessions.map((session) => firstString(session.ended_at) ?? firstString(session.started_at)),
    ...attempts.map((attempt) => firstString(attempt.created_at)),
  ]);

  return {
    user: {
      tier: profile?.tier ?? null,
      active_coach_id: profile?.active_coach_key ?? null,
      joined_at: profile?.created_at ?? null,
    },
    activity: {
      minutes_all: round(minutesAll, 2),
      minutes_28d: round(minutes28, 2),
      minutes_7d: round(minutes7, 2),
      attempts_all: attemptsAll,
      attempts_28d: attempts28,
      attempts_7d: attempts7,
      days_active_7d: daysActiveSet.size,
      last_activity_at: lastActivity,
    },
    performance: {
      avg_score_28d: avgScore28 === null ? null : round(avgScore28, 2),
      avg_wpm_28d: avgWpm28 === null ? null : round(avgWpm28, 2),
      pass_rate_28d: passRate28 === null ? null : round(passRate28, 4),
    },
    focus: {
      top_coach_id_28d: null,
      top_topic_28d: null,
    },
    source: "fallback",
  };
}

async function fetchProfile(supabase: Supabase, userId: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("tier, created_at, active_coach_key")
    .eq("id", userId)
    .maybeSingle();
  const dbError: PostgrestError | null = error;
  if (dbError && !isMissingRelation(dbError)) {
    handleDbError("fetch_profile", dbError);
  }
  return asProfileRow(data);
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  });
}

function handleDbError(label: string, error: { message?: string } | PostgrestError) {
  log.error(`progress/summary ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function makeHttpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function computeSessionMinutes(row: SessionRow): number {
  const duration = toNumber(row?.duration_sec);
  if (duration && duration > 0) return duration / 60;
  const start = firstString(row?.started_at);
  const end = firstString(row?.ended_at);
  if (start && end) {
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      return (endMs - startMs) / 60000;
    }
  }
  return 0;
}

function isOnOrAfter(value: unknown, thresholdIso: string): boolean {
  if (typeof thresholdIso !== "string" || !thresholdIso) return false;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return false;
  const threshold = Date.parse(thresholdIso);
  if (!Number.isFinite(threshold)) return false;
  return ts >= threshold;
}

function latestTimestamp(values: Array<string | undefined | null>): string | null {
  let latest: number | null = null;
  values.forEach((value) => {
    if (!value) return;
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return;
    if (latest === null || ts > latest) latest = ts;
  });
  return latest === null ? null : new Date(latest).toISOString();
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

function toNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeFloat(value: unknown): number | null {
  const num = toNumber(value);
  if (typeof num !== "number") return null;
  return round(num, 2);
}

function isSessionRow(value: unknown): value is SessionRow {
  if (!isRecord(value)) return false;
  const duration = value.duration_sec;
  const started = value.started_at;
  const ended = value.ended_at;
  const durationOk =
    duration === null || typeof duration === "string" || typeof duration === "number";
  const startedOk = started === null || typeof started === "string";
  const endedOk = ended === null || typeof ended === "string";
  return durationOk && startedOk && endedOk;
}

function isAttemptRow(value: unknown): value is AttemptRow {
  if (!isRecord(value)) return false;
  const created = value.created_at;
  const score = value.score;
  const wpm = value.words_per_minute;
  const passed = value.passed;
  const createdOk = created === null || typeof created === "string";
  const scoreOk = score === null || typeof score === "string" || typeof score === "number";
  const wpmOk = wpm === null || typeof wpm === "string" || typeof wpm === "number";
  const passedOk = passed === null || typeof passed === "boolean";
  return createdOk && scoreOk && wpmOk && passedOk;
}

function round(value: number, precision = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function isMissingRelation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeMessage = "message" in error ? (error as { message?: unknown }).message : undefined;
  const normalized = typeof maybeMessage === "string" ? maybeMessage.toLowerCase() : "";
  return normalized.includes("does not exist") || normalized.includes("relation") || normalized.includes("missing");
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

function asProfileRow(value: unknown): ProfileRow | null {
  if (!isRecord(value)) return null;
  return {
    tier: firstString(value.tier) ?? null,
    created_at: firstString(value.created_at) ?? null,
    active_coach_key: firstString(value.active_coach_key) ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
