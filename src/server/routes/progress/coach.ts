// src/server/routes/progress/coach.ts
/**
 * GET /api/progress/coach
 *
 * Returns the current (or requested) week's practice distribution per coach for
 * the authenticated user. Data comes from v_user_weekly_by_coach when available,
 * otherwise falls back to aggregating sessions directly.
 *
 * Query params:
 *   - week (optional): YYYY-MM-DD Monday anchor. Defaults to current Manila week.
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { PostgrestError } from "@supabase/supabase-js";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import {
  startOfIsoWeekInTimezone,
  startOfDayInTimezone,
  addDays,
} from "../../../lib/timezone";
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

        const requestedWeek = parseWeekParam(req.query.week);
        const supabaseClient = createClient();
        const payload = await buildCoachProgress(supabaseClient, userId, timezone, requestedWeek);

        res.status(200).json({
          ok: true,
          data: payload,
          correlation_id: getCorrelationId(),
        });
      } catch (error: unknown) {
        log.error("progress/coach error", { err: safeError(error) });
        const parsed = parseHttpError(error);
        const message =
          parsed.status === 500
            ? "Unable to load coach progress."
            : parsed.message || "Unable to load coach progress.";
        sendError(res, parsed.status, parsed.code, message);
      }
    },
  );
});

export default router;

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

interface CoachAggregateRow {
  coach_id: string | null;
  minutes: number;
  sessions: number;
  last_session_at?: string | null;
}

interface CoachProgressEntry extends CoachAggregateRow {
  display_name: string | null;
  share: number | null;
  delta_minutes: number | null;
  delta_sessions: number | null;
}

interface CoachProgressPayload {
  week_of: string;
  previous_week_of: string | null;
  totals: { minutes: number; sessions: number };
  coaches: CoachProgressEntry[];
  source: "view" | "sessions";
}

async function buildCoachProgress(
  supabase: Supabase,
  userId: string,
  timezone: string,
  requestedWeek?: string | null,
): Promise<CoachProgressPayload> {
  const fromView = await fetchFromWeeklyView(supabase, userId, requestedWeek ?? undefined);
  if (fromView) {
    const meta = await formatProgressPayload(supabase, {
      week: fromView.week,
      previousWeek: fromView.previousWeek,
      current: fromView.currentRows,
      previous: fromView.previousRows,
      source: "view",
    });
    return meta;
  }

  const fallbackWeek = requestedWeek ?? currentWeekForTimezone(timezone);
  const previousWeek = shiftDate(fallbackWeek, -7);

  const [currentRows, previousRows] = await Promise.all([
    aggregateSessionsForWeek(supabase, userId, fallbackWeek, timezone),
    previousWeek ? aggregateSessionsForWeek(supabase, userId, previousWeek, timezone) : Promise.resolve([]),
  ]);

  return formatProgressPayload(supabase, {
    week: fallbackWeek,
    previousWeek: previousWeek,
    current: currentRows,
    previous: previousRows,
    source: "sessions",
  });
}

// -----------------------------------------------------------------------------
// Data fetchers
// -----------------------------------------------------------------------------

interface WeeklyViewRow {
  coach_key: string | null;
  week_start: string | null;
  total_minutes: number | string | null;
  sessions_count: number | string | null;
}

interface SessionRow {
  coach_key: string | null;
  duration_sec: number | null;
  started_at: string | null;
  ended_at: string | null;
}

interface CoachMetadataRow {
  key: string | null;
  display_name: string | null;
}

async function fetchFromWeeklyView(
  supabase: Supabase,
  userId: string,
  week?: string,
): Promise<{ week: string; previousWeek: string | null; currentRows: CoachAggregateRow[]; previousRows: CoachAggregateRow[] } | null> {
  try {
    if (week) {
      const targetWeeks = [week];
      const prev = shiftDate(week, -7);
      if (prev) targetWeeks.push(prev);

      const { data, error } = await supabase
        .from("v_user_weekly_by_coach")
        .select("coach_key, week_start, total_minutes, sessions_count")
        .eq("user_id", userId)
        .in("week_start", targetWeeks);

      const dbError: PostgrestError | null = error;
      if (dbError) {
        if (isMissingRelation(dbError)) return null;
        handleDbError("fetch_weekly_view", dbError);
      }
      const rows = asWeeklyViewRows(data);
      if (!rows.length) return null;

      const weekRows = rows.filter((row) => normalizeDate(row.week_start) === week).map(mapViewRow);
      const prevRows = prev
        ? rows.filter((row) => normalizeDate(row.week_start) === prev).map(mapViewRow)
        : [];
      return { week, previousWeek: prev ?? null, currentRows: weekRows, previousRows: prevRows };
    }

    const { data, error } = await supabase
      .from("v_user_weekly_by_coach")
      .select("coach_key, week_start, total_minutes, sessions_count")
      .eq("user_id", userId)
      .order("week_start", { ascending: false })
      .limit(32);

    const dbError: PostgrestError | null = error;
    if (dbError) {
      if (isMissingRelation(dbError)) return null;
      handleDbError("fetch_weekly_view", dbError);
    }

    const rows = asWeeklyViewRows(data);
    if (!rows.length) return null;

    const orderedWeeks = unique(
      rows
        .map((row) => normalizeDate(row.week_start))
        .filter((value): value is string => Boolean(value)),
    );

    if (!orderedWeeks.length) return null;

    const activeWeek = orderedWeeks[0];
    const prevWeek = orderedWeeks.find((w) => w !== activeWeek) ?? null;

    return {
      week: activeWeek,
      previousWeek: prevWeek ?? null,
      currentRows: rows.filter((row) => normalizeDate(row.week_start) === activeWeek).map(mapViewRow),
      previousRows: prevWeek ? rows.filter((row) => normalizeDate(row.week_start) === prevWeek).map(mapViewRow) : [],
    };
  } catch (error: unknown) {
    if (isMissingRelation(error)) return null;
    throw error;
  }
}

function mapViewRow(row: WeeklyViewRow): CoachAggregateRow {
  return {
    coach_id: firstString(row.coach_key) ?? null,
    minutes: toNumber(row.total_minutes) ?? 0,
    sessions: toNumber(row.sessions_count) ?? 0,
  };
}

async function aggregateSessionsForWeek(
  supabase: Supabase,
  userId: string,
  weekStart: string,
  timezone: string,
): Promise<CoachAggregateRow[]> {
  const bounds = dateRangeForWeek(weekStart, timezone);
  const { data, error } = await supabase
    .from("sessions")
    .select("coach_key, duration_sec, started_at, ended_at")
    .eq("user_id", userId)
    .gte("started_at", bounds.start)
    .lt("started_at", bounds.end);

  const dbError: PostgrestError | null = error;
  if (dbError) {
    if (isMissingRelation(dbError)) return [];
    handleDbError("aggregate_sessions", dbError);
  }

  const rows = asSessionRows(data);
  if (!rows.length) return [];

  const bucket = new Map<string | null, CoachAggregateRow>();

  rows.forEach((row) => {
    const key = row.coach_key ?? null;
    const minutes = computeSessionMinutes(row);
    const current = bucket.get(key) ?? { coach_id: key, minutes: 0, sessions: 0, last_session_at: null };
    current.minutes += minutes;
    current.sessions += 1;
    const timestamp = row.started_at ?? row.ended_at ?? null;
    if (timestamp) {
      if (
        !current.last_session_at ||
        new Date(timestamp).getTime() > new Date(current.last_session_at).getTime()
      ) {
        current.last_session_at = timestamp;
      }
    }
    bucket.set(key, current);
  });

  return Array.from(bucket.values()).map((row) => ({
    coach_id: row.coach_id,
    minutes: round(row.minutes, 2),
    sessions: row.sessions,
    last_session_at: row.last_session_at ?? null,
  }));
}

async function fetchCoachMetadata(
  supabase: Supabase,
  keys: string[],
): Promise<Map<string, { display_name: string | null }>> {
  if (!keys.length) return new Map();

  const { data, error } = await supabase.from("coaches").select("key, display_name").in("key", keys);
  const dbError: PostgrestError | null = error;
  if (dbError && !isMissingRelation(dbError)) {
    handleDbError("fetch_coach_meta", dbError);
  }
  const rows = asCoachMetadataRows(data);
  if (!rows.length) return new Map();

  const map = new Map<string, { display_name: string | null }>();
  rows.forEach((row) => {
    const key = row.key;
    if (!key) return;
    map.set(key, { display_name: row.display_name ?? null });
  });
  return map;
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

async function formatProgressPayload(
  supabase: Supabase,
  input: {
    week: string;
    previousWeek: string | null;
    current: CoachAggregateRow[];
    previous: CoachAggregateRow[];
    source: "view" | "sessions";
  },
): Promise<CoachProgressPayload> {
  const totals = input.current.reduce(
    (acc, row) => {
      acc.minutes += row.minutes;
      acc.sessions += row.sessions;
      return acc;
    },
    { minutes: 0, sessions: 0 },
  );

  const prevMap = new Map<string | null, CoachAggregateRow>();
  input.previous.forEach((row) => {
    prevMap.set(row.coach_id ?? null, row);
  });

  const coachKeys = unique(
    input.current
      .map((row) => row.coach_id)
      .filter((value): value is string => Boolean(value)),
  );
  const meta = await fetchCoachMetadata(supabase, coachKeys);

  const coaches = input.current
    .slice()
    .sort((a, b) => {
      if (b.minutes !== a.minutes) return b.minutes - a.minutes;
      const aKey = a.coach_id ?? "";
      const bKey = b.coach_id ?? "";
      return aKey.localeCompare(bKey);
    })
    .map<CoachProgressEntry>((row) => {
      const prev = prevMap.get(row.coach_id ?? null);
      const share = totals.minutes > 0 ? row.minutes / totals.minutes : null;
      const metaEntry = row.coach_id ? meta.get(row.coach_id) : undefined;
      return {
        coach_id: row.coach_id,
        display_name: metaEntry?.display_name ?? humanizeCoach(row.coach_id),
        minutes: round(row.minutes, 2),
        sessions: row.sessions,
        share: share === null ? null : round(share, 4),
        delta_minutes: prev ? round(row.minutes - prev.minutes, 2) : null,
        delta_sessions: prev ? row.sessions - prev.sessions : null,
        last_session_at: row.last_session_at ?? null,
      };
    });

  return {
    week_of: input.week,
    previous_week_of: input.previousWeek,
    totals: { minutes: round(totals.minutes, 2), sessions: totals.sessions },
    coaches,
    source: input.source,
  };
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

function handleDbError(label: string, error: { message?: string } | PostgrestError) {
  log.error(`progress/coach ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function makeHttpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function parseWeekParam(value: unknown): string | null {
  const str = firstString(value);
  if (!str) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  const d = new Date(`${str}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : str;
}

function currentWeekForTimezone(timezone: string): string {
  const start = startOfIsoWeekInTimezone(new Date(), timezone);
  return formatDate(start);
}

function shiftDate(dateStr: string, deltaDays: number): string | null {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return formatDate(date);
}

function dateRangeForWeek(weekStart: string, timezone: string): { start: string; end: string } {
  const startDate = weekStringToUtcStart(weekStart, timezone);
  const endDate = addDays(startDate, 7);
  return { start: startDate.toISOString(), end: endDate.toISOString() };
}

function computeSessionMinutes(row: SessionRow): number {
  const duration = toNumber(row.duration_sec);
  if (duration && duration > 0) return duration / 60;
  const start = row.started_at;
  const end = row.ended_at;
  if (start && end) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      return (endMs - startMs) / 60000;
    }
  }
  return 0;
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

function unique<T>(values: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  values.forEach((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(value);
  });
  return out;
}

function round(value: number, precision = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatDate(parsed);
}

function weekStringToUtcStart(weekStart: string, timezone: string): Date {
  const parts = weekStart.split("-");
  if (parts.length !== 3) {
    return startOfIsoWeekInTimezone(new Date(), timezone);
  }
  const [yearStr, monthStr, dayStr] = parts;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return startOfIsoWeekInTimezone(new Date(), timezone);
  }
  const approx = new Date(Date.UTC(year, month - 1, day, 12));
  return startOfDayInTimezone(approx, timezone);
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function humanizeCoach(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((chunk) => chunk.charAt(0).toUpperCase() + chunk.slice(1))
    .join(" ");
}

function isMissingRelation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeMessage = "message" in error ? (error as { message?: unknown }).message : undefined;
  const normalized = typeof maybeMessage === "string" ? maybeMessage.toLowerCase() : "";
  return normalized.includes("does not exist") || normalized.includes("missing") || normalized.includes("relation");
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

function asWeeklyViewRows(value: unknown): WeeklyViewRow[] {
  if (!Array.isArray(value)) return [];
  const rows: WeeklyViewRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const coach = firstString(entry.coach_key) ?? null;
    const week = firstString(entry.week_start) ?? null;
    const total =
      typeof entry.total_minutes === "number" || typeof entry.total_minutes === "string"
        ? entry.total_minutes
        : null;
    const sessions =
      typeof entry.sessions_count === "number" || typeof entry.sessions_count === "string"
        ? entry.sessions_count
        : null;
    rows.push({
      coach_key: coach,
      week_start: week,
      total_minutes: total,
      sessions_count: sessions,
    });
  }
  return rows;
}

function asSessionRows(value: unknown): SessionRow[] {
  if (!Array.isArray(value)) return [];
  const rows: SessionRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    rows.push({
      coach_key: firstString(entry.coach_key) ?? null,
      duration_sec: typeof entry.duration_sec === "number" ? entry.duration_sec : toNumber(entry.duration_sec) ?? null,
      started_at: firstString(entry.started_at) ?? null,
      ended_at: firstString(entry.ended_at) ?? null,
    });
  }
  return rows;
}

function asCoachMetadataRows(value: unknown): CoachMetadataRow[] {
  if (!Array.isArray(value)) return [];
  const rows: CoachMetadataRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    rows.push({
      key: firstString(entry.key) ?? null,
      display_name: firstString(entry.display_name) ?? null,
    });
  }
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
