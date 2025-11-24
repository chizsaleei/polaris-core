// polaris-core/src/server/routes/admin/users/progress.ts
import type { Request, Response } from "express";
import { Router } from "express";
import type { ParamsDictionary } from "express-serve-static-core";

import { createClient } from "../../../../lib/supabase";

const router = Router();
const supabase = createClient();

type ProgressQuery = {
  from?: string;
  to?: string;
  coach?: string;
  limit?: string;
};

type AuthedAdminRequest = Request<ParamsDictionary, Record<string, unknown>, unknown, ProgressQuery> & {
  user?: { id?: string | null };
};

type UserSummary = {
  id: string;
  email?: string | null;
  full_name?: string | null;
  tier?: string | null;
  created_at?: string | null;
};

type TotalsSummary = {
  sessions: number;
  attempts: number;
  minutes?: number;
  last_activity: string | null;
};

type CoachBreakdown = {
  coach: string;
  sessions: number;
  attempts: number;
  avg_score?: number;
  last?: string;
};

type DailyActivityPoint = {
  date: string;
  sessions: number;
  attempts: number;
};

type RecentSession = {
  id: string | number;
  started_at: string | null;
  coach: string | null;
  topic: string | null;
  score: number | null;
};

interface ProfileRow {
  user_id: string;
  email: string | null;
  full_name: string | null;
  tier: string | null;
  created_at: string | null;
}

interface EventRow {
  created_at: string;
}

interface DurationRow {
  duration_sec: number | null;
}

interface DrillStatsRow {
  coach_key: string | null;
  sessions: number | null;
  attempts: number | null;
  avg_score: number | null;
  last_activity: string | null;
  date?: string | null;
}

interface SessionRow {
  id: string | number;
  started_at: string | null;
  created_at: string | null;
  coach_id: string | null;
  topic: string | null;
  score: number | null;
}

interface AttemptRow {
  coach_id: string | null;
  created_at: string | null;
}

interface DailyRow {
  date: string;
  sessions: number | null;
  attempts: number | null;
}

interface AdminFlagRow {
  is_admin: boolean | null;
}

type SessionCountResult = { count: number | null };
type EventCountResult = { data: EventRow | null };

router.get("/:id", (req, res) => {
  void handleProgressRequest(req as AuthedAdminRequest, res);
});

const handleProgressRequest = async (req: AuthedAdminRequest, res: Response) => {
  try {
    const adminId = getAdminUserId(req);
    if (!(await isAdminUser(adminId))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const userId = String(req.params.id ?? "").trim();
    if (!userId) {
      res.status(400).json({ error: "missing_user_id" });
      return;
    }

    const qFrom = parseDate(req.query.from);
    const qTo = parseDate(req.query.to);
    const coach = safeString(req.query.coach);
    const limit = clampLimit(req.query.limit, 20, 100);

    const user = await fetchUserSummary(userId);

    const haveDaily = await tableExists("v_drill_stats_daily");
    const haveDrillStats = await tableExists("v_drill_stats");

    const [totals, byCoach, daily, recentSessions] = await Promise.all([
      fetchTotals(userId, qFrom, qTo),
      fetchByCoach(userId, qFrom, qTo, coach, haveDrillStats),
      haveDaily ? fetchDaily(userId, qFrom, qTo) : Promise.resolve([] as DailyActivityPoint[]),
      fetchRecentSessions(userId, qFrom, qTo, coach, limit),
    ]);

    res.status(200).json({
      user,
      range: { from: qFrom ?? undefined, to: qTo ?? undefined },
      totals,
      byCoach,
      daily,
      recentSessions,
    });
  } catch (error) {
    console.error("[admin/users/progress] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Data fetchers
// -----------------------------------------------------------------------------

async function fetchUserSummary(userId: string): Promise<UserSummary> {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, email, full_name, tier, created_at")
      .eq("user_id", userId)
      .maybeSingle<ProfileRow>();

    if (!error && data) {
      return {
        id: data.user_id,
        email: data.email,
        full_name: data.full_name,
        tier: data.tier,
        created_at: data.created_at,
      };
    }
  } catch {
    // ignore
  }
  return { id: userId };
}

async function fetchTotals(userId: string, from?: string | null, to?: string | null): Promise<TotalsSummary> {
  let sessionCount = 0;
  let attemptCount = 0;
  let lastActivity: string | null = null;

  try {
    const [sessions, attempts, last] = await Promise.all([
      supabase
        .from("sessions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .then(({ count }: SessionCountResult) => count ?? 0),
      supabase
        .from("attempts")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .then(({ count }: SessionCountResult) => count ?? 0),
      supabase
        .from("events")
        .select("created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle<EventRow>()
        .then(({ data }: EventCountResult) => data?.created_at ?? null),
    ]);
    sessionCount = sessions;
    attemptCount = attempts;
    lastActivity = last;
  } catch {
    // ignore failures, keep defaults
  }

  let minutes: number | undefined;
  try {
    let query = supabase
      .from("attempts")
      .select("duration_sec")
      .eq("user_id", userId);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    const { data, error } = await query;
    if (!error && Array.isArray(data)) {
      const seconds = (data as DurationRow[]).reduce((acc, row) => acc + (Number(row.duration_sec) || 0), 0);
      minutes = Math.round(seconds / 60);
    }
  } catch {
    // optional, ignore
  }

  return {
    sessions: sessionCount,
    attempts: attemptCount,
    minutes,
    last_activity: lastActivity,
  };
}

async function fetchByCoach(
  userId: string,
  from: string | null | undefined,
  to: string | null | undefined,
  coach: string | null,
  haveDrillStats: boolean,
): Promise<CoachBreakdown[]> {
  const results: CoachBreakdown[] = [];

  if (haveDrillStats) {
    try {
      let q = supabase
        .from("v_drill_stats")
        .select("coach_key, sessions, attempts, avg_score, last_activity")
        .eq("user_id", userId);

      if (coach) q = q.eq("coach_key", coach);
      if (from) q = q.gte("date", from);
      if (to) q = q.lte("date", to);

      const { data, error } = await q;
      if (!error && Array.isArray(data)) {
        (data as DrillStatsRow[]).forEach((row) => {
          const coachKey = row.coach_key ?? "unknown";
          results.push({
            coach: coachKey,
            sessions: Number(row.sessions) || 0,
            attempts: Number(row.attempts) || 0,
            avg_score: isFiniteNumber(row.avg_score) ? Number(row.avg_score) : undefined,
            last: row.last_activity ?? undefined,
          });
        });
        return results;
      }
    } catch {
      // fall through to manual aggregation
    }
  }

  try {
    let sessionQuery = supabase
      .from("sessions")
      .select("coach_id, created_at")
      .eq("user_id", userId);

    if (coach) sessionQuery = sessionQuery.eq("coach_id", coach);
    if (from) sessionQuery = sessionQuery.gte("created_at", from);
    if (to) sessionQuery = sessionQuery.lte("created_at", to);

    const { data: sessions, error } = await sessionQuery;
    if (!error && Array.isArray(sessions)) {
      const aggregates = new Map<string, { sessions: number; attempts: number; last?: string }>();

      (sessions as AttemptRow[]).forEach((row) => {
        const key = String(row.coach_id || "unknown");
        const current = aggregates.get(key) || { sessions: 0, attempts: 0, last: undefined };
        current.sessions += 1;
        if (!current.last || (row.created_at && row.created_at > current.last)) {
          current.last = row.created_at ?? undefined;
        }
        aggregates.set(key, current);
      });

      let attemptQuery = supabase
        .from("attempts")
        .select("coach_id, created_at")
        .eq("user_id", userId);
      if (coach) attemptQuery = attemptQuery.eq("coach_id", coach);
      if (from) attemptQuery = attemptQuery.gte("created_at", from);
      if (to) attemptQuery = attemptQuery.lte("created_at", to);
      const { data: attempts } = await attemptQuery;

      if (Array.isArray(attempts)) {
        (attempts as AttemptRow[]).forEach((row) => {
          const key = String(row.coach_id || "unknown");
          const current = aggregates.get(key) || { sessions: 0, attempts: 0, last: undefined };
          current.attempts += 1;
          if (!current.last || (row.created_at && row.created_at > current.last)) {
            current.last = row.created_at ?? undefined;
          }
          aggregates.set(key, current);
        });
      }

      aggregates.forEach((value, key) => {
        results.push({
          coach: key,
          sessions: value.sessions,
          attempts: value.attempts,
          last: value.last,
        });
      });
    }
  } catch {
    // ignore failures and return whatever we have
  }

  return results;
}

async function fetchDaily(userId: string, from?: string | null, to?: string | null): Promise<DailyActivityPoint[]> {
  try {
    let q = supabase
      .from("v_drill_stats_daily")
      .select("date, sessions, attempts")
      .eq("user_id", userId)
      .order("date", { ascending: true });

    if (from) q = q.gte("date", from);
    if (to) q = q.lte("date", to);

    const { data, error } = await q;
    if (!error && Array.isArray(data)) {
      return (data as DailyRow[]).map((row) => ({
        date: row.date,
        sessions: Number(row.sessions) || 0,
        attempts: Number(row.attempts) || 0,
      }));
    }
  } catch {
    // ignore
  }
  return [];
}

async function fetchRecentSessions(
  userId: string,
  from: string | null | undefined,
  to: string | null | undefined,
  coach: string | null | undefined,
  limit: number,
): Promise<RecentSession[]> {
  try {
    let q = supabase
      .from("sessions")
      .select("id, started_at, coach_id, topic, score, created_at")
      .eq("user_id", userId)
      .order("started_at", { ascending: false })
      .limit(limit);

    if (coach) q = q.eq("coach_id", coach);
    if (from) q = q.gte("started_at", from);
    if (to) q = q.lte("started_at", to);

    const { data, error } = await q;
    if (!error && Array.isArray(data)) {
      return (data as SessionRow[]).map((row) => ({
        id: row.id,
        started_at: row.started_at ?? row.created_at ?? null,
        coach: row.coach_id ?? null,
        topic: row.topic ?? null,
        score: isFiniteNumber(row.score) ? Number(row.score) : null,
      }));
    }
  } catch {
    // ignore
  }
  return [];
}

// -----------------------------------------------------------------------------
// Admin guard and helpers
// -----------------------------------------------------------------------------

async function isAdminUser(userId?: string | null): Promise<boolean> {
  if (!userId) return false;

  const allow = String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(userId)) return true;

  try {
    const rpc = await supabase.rpc("is_admin", { p_user_id: userId }).single<{ is_admin: boolean }>();
    if (!rpc.error && rpc.data.is_admin === true) return true;
  } catch {
    // ignore
  }

  try {
    const prof = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("user_id", userId)
      .maybeSingle<AdminFlagRow>();
    if (prof.data?.is_admin) return true;
  } catch {
    // ignore
  }

  return false;
}

async function tableExists(table: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from(table)
      .select("*", { head: true, count: "exact" })
      .limit(0);
    return !error;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Small utils
// -----------------------------------------------------------------------------

function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseDate(value?: string): string | null {
  if (!value || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampLimit(value: unknown, def = 20, max = 100): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return def;
  return Math.max(1, Math.min(max, Math.round(num)));
}

function isFiniteNumber(value: unknown): boolean {
  return Number.isFinite(Number(value));
}

function getAdminUserId(req: AuthedAdminRequest): string | null {
  if (req.user?.id && typeof req.user.id === "string") return req.user.id;
  const header = req.header("x-user-id");
  return header ? String(header) : null;
}
