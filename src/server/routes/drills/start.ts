// src/server/routes/drills/start.ts
/**
 * Start a drill session.
 *
 * - Validates drill availability (published + tier gating).
 * - Enforces daily minute limits per tier and concurrent session caps.
 * - Calls rpc_start_session to create the session row and daily usage stub.
 * - Returns session id plus remaining minutes for the day.
 */

import { Router, type Request, type Response } from "express";

import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import { Tier } from "../../../core/scheduler/daily-deterministic";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type RequestWithUser = Request & { user?: { id?: string | null } };

interface DrillRow {
  id: string;
  coach_key: string | null;
  coach_id: string | null;
  coach: string | null;
  tags: string[] | null;
  tag_list: string[] | null;
  state: string | null;
  active: boolean | null;
  is_public: boolean | null;
  runtime_seconds: number | null;
  runtime_sec: number | null;
  duration_sec: number | null;
  estimated_seconds: number | null;
  runtime_minutes: number | null;
  time_estimate_minutes: number | null;
  estimated_minutes: number | null;
  minutes: number | null;
  format: string | null;
  type: string | null;
}

interface SessionRow {
  id: string;
  started_at: string | null;
  created_at: string | null;
}

interface StartPayload {
  drillId?: string;
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
      if (!payload.drillId) {
        return sendError(res, 400, "invalid_drill", "drill_id is required and must be a UUID.");
      }

      const supabase = createClient();

      const [drillRow, tier] = await Promise.all([fetchDrill(supabase, payload.drillId), resolveTierForUser(supabase, userId)]);
      if (!drillRow) {
        return sendError(res, 404, "drill_not_found", "Drill could not be found.");
      }
      if (!isDrillAvailable(drillRow)) {
        return sendError(res, 403, "drill_unavailable", "Drill is not published or available.");
      }

      const coachKey = normalizeCoach(drillRow.coach_key ?? drillRow.coach_id ?? drillRow.coach);
      if (!coachKey) {
        return sendError(res, 500, "missing_coach", "Drill is missing coach metadata.");
      }

      const tags = toStringArray(drillRow.tags ?? drillRow.tag_list);
      if (!allowedByTier(tags, tier)) {
        return sendError(res, 403, "tier_restricted", "This drill is limited to a higher tier.");
      }

      const runtimeSeconds = pickRuntimeSeconds(drillRow);
      const minutesRequired = Math.max(1, Math.ceil(runtimeSeconds / 60));

      const [minutesCap, minutesUsed, concurrentLimit, activeSessions] = await Promise.all([
        fetchTierMinutesPerDay(supabase, tier),
        fetchTodayMinutes(supabase, userId),
        fetchLimitInt(supabase, tier, "PRACTICE_CONCURRENT_SESSIONS_MAX", 2),
        countActiveSessions(supabase, userId),
      ]);

      const minutesRemaining = Math.max(0, minutesCap - minutesUsed);
      if (!minutesRemaining) {
        return sendError(res, 429, "minute_cap_reached", "You have used all available minutes for today.");
      }
      if (minutesRequired > minutesRemaining) {
        return sendError(
          res,
          429,
          "insufficient_minutes",
          `This drill requires ~${minutesRequired} minutes but you only have ${minutesRemaining} remaining today.`,
        );
      }

      if (activeSessions >= concurrentLimit) {
        return sendError(res, 429, "too_many_sessions", "You already have an active session. Finish it before starting another.");
      }

      const session = await startSession(supabase, {
        coachKey,
        tier,
        toolUsed: buildToolUsed(drillRow),
      });

      return res.status(200).json({
        ok: true,
        data: {
          session_id: session.id,
          drill_id: drillRow.id,
          coach_id: coachKey,
          started_at: session.started_at ?? session.created_at ?? new Date().toISOString(),
          estimated_minutes: minutesRequired,
          remaining_minutes_today: Math.max(0, minutesRemaining - minutesRequired),
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      log.error("drills/start error", { err: safeError(error) });
      const httpError = parseHttpError(error, "Unable to start drill session.");
      return sendError(res, httpError.status, httpError.code, httpError.message);
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Data helpers
// -----------------------------------------------------------------------------

async function fetchDrill(supabase: Supabase, drillId: string): Promise<DrillRow | null> {
  const { data, error } = await supabase
    .from("drills")
    .select("*")
    .eq("id", drillId)
    .maybeSingle<Record<string, unknown>>();

  if (error) handleDbError("fetch_drill", error);
  if (!data) return null;
  const record = toRecord(data);
  if (!record) return null;
  return createDrillRow(record);
}

async function resolveTierForUser(supabase: Supabase, userId: string): Promise<Tier> {
  const { data: entRows } = await supabase
    .from("entitlements")
    .select("plan, status, active")
    .eq("user_id", userId)
    .eq("active", true);

  if (Array.isArray(entRows) && entRows.length) {
    const plans = new Set<string>();
    for (const row of entRows) {
      const record = toRecord(row);
      if (!record) continue;
      const plan = readNullableString(record.plan);
      if (!plan) continue;
      plans.add(plan.toLowerCase());
    }
    if (plans.has("vip") || plans.has("vip_monthly") || plans.has("vip_yearly")) return Tier.VIP;
    if (plans.has("pro") || plans.has("pro_monthly") || plans.has("pro_yearly")) return Tier.PRO;
  }

  const { data: prof } = await supabase.from("profiles").select("tier").eq("id", userId).maybeSingle();
  const profile = toRecord(prof);
  const tierValue = profile ? readNullableString(profile.tier) : null;
  const tier = (tierValue || "free").toLowerCase();
  if (tier === "vip") return Tier.VIP;
  if (tier === "pro") return Tier.PRO;
  return Tier.FREE;
}

async function fetchTierMinutesPerDay(supabase: Supabase, tier: Tier): Promise<number> {
  const fallback = DEFAULT_TIER_MINUTES[tier] ?? 10;
  const code = tier.toUpperCase();
  try {
    const { data } = await supabase.from("tiers").select("realtime_minutes_per_day").eq("code", code).maybeSingle();
    const record = toRecord(data);
    const minutes = record ? readNullableNumber(record.realtime_minutes_per_day) : null;
    if (typeof minutes === "number") {
      return Math.max(1, minutes);
    }
  } catch (error) {
    log.warn("drills/start tier minutes query failed", { err: safeError(error) });
  }
  return fallback;
}

async function fetchTodayMinutes(supabase: Supabase, userId: string): Promise<number> {
  const today = todayDate();
  const { data, error } = await supabase
    .from("daily_usage")
    .select("minutes_used")
    .eq("user_id", userId)
    .eq("d", today)
    .maybeSingle();

  if (error && !isMissingRelation(error)) handleDbError("fetch_usage", error);
  const record = toRecord(data);
  const minutes = record ? readNullableNumber(record.minutes_used) : null;
  return minutes ?? 0;
}

async function fetchLimitInt(supabase: Supabase, tier: Tier, key: string, fallback: number): Promise<number> {
  const tierCode = tier.toUpperCase();

  try {
    const { data } = await supabase.from("tier_limits").select("value_int").eq("tier_code", tierCode).eq("key", key).maybeSingle();
    const record = toRecord(data);
    const value = record ? readNullableNumber(record.value_int) : null;
    if (typeof value === "number") return value;
  } catch (error) {
    if (!isMissingRelation(error)) log.warn("drills/start tier_limits query failed", { err: safeError(error) });
  }

  try {
    const { data } = await supabase.from("limit_defaults").select("value_int").eq("key", key).maybeSingle();
    const record = toRecord(data);
    const value = record ? readNullableNumber(record.value_int) : null;
    if (typeof value === "number") return value;
  } catch (error) {
    if (!isMissingRelation(error)) log.warn("drills/start limit_defaults query failed", { err: safeError(error) });
  }

  return fallback;
}

async function countActiveSessions(supabase: Supabase, userId: string) {
  const { count, error } = await supabase
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["started"]);

  if (error && !isMissingRelation(error)) handleDbError("count_sessions", error);
  return count ?? 0;
}

async function startSession(
  supabase: Supabase,
  input: { coachKey: string; tier: Tier; toolUsed?: string },
): Promise<SessionRow> {
  const payload = {
    p_coach_key: input.coachKey,
    p_tier: input.tier,
    p_tool_used: input.toolUsed ?? "drill",
  };

  const response = await supabase.rpc("rpc_start_session", payload);

  if (response.error) handleDbError("rpc_start_session", response.error);
  const resultData: unknown = response.data;
  const record = Array.isArray(resultData)
    ? resultData.map((row) => toRecord(row)).find((r): r is Record<string, unknown> => Boolean(r))
    : toRecord(resultData);
  if (!record) throw makeHttpError(500, "session_creation_failed", "Failed to start session.");
  return createSessionRow(record);
}

// -----------------------------------------------------------------------------
// Business helpers
// -----------------------------------------------------------------------------

function isDrillAvailable(row: DrillRow): boolean {
  if (typeof row.active === "boolean" && row.active === false) return false;
  if (typeof row.is_public === "boolean" && row.is_public === false) return false;
  const state = firstString(row.state)?.toLowerCase();
  if (state && !["approved", "published"].includes(state)) return false;
  return true;
}

function pickRuntimeSeconds(row: DrillRow): number {
  const sec = row.runtime_seconds ?? row.runtime_sec ?? row.duration_sec ?? row.estimated_seconds;
  if (typeof sec === "number" && Number.isFinite(sec)) return Math.max(60, sec);

  const minutes = row.runtime_minutes ?? row.time_estimate_minutes ?? row.estimated_minutes ?? row.minutes;
  if (typeof minutes === "number" && Number.isFinite(minutes)) return Math.max(60, Math.round(minutes * 60));

  return 120;
}

function allowedByTier(tags: string[], tier: Tier): boolean {
  const bag = new Set(tags.map((t) => t.toLowerCase()));
  if (bag.has("vip_only") && tier !== Tier.VIP) return false;
  if (bag.has("pro_only") && tier === Tier.FREE) return false;
  return true;
}

function buildToolUsed(drill: DrillRow): string {
  const tool = firstString(drill.format ?? drill.type);
  return tool ? `drill:${tool}` : "drill";
}

function createDrillRow(record: Record<string, unknown>): DrillRow | null {
  const id = readNullableString(record.id);
  if (!id) return null;

  return {
    id,
    coach_key: readNullableString(record.coach_key),
    coach_id: readNullableString(record.coach_id),
    coach: readNullableString(record.coach),
    tags: readStringArray(record.tags),
    tag_list: readStringArray(record.tag_list),
    state: readNullableString(record.state),
    active: readNullableBoolean(record.active),
    is_public: readNullableBoolean(record.is_public),
    runtime_seconds: readNullableNumber(record.runtime_seconds),
    runtime_sec: readNullableNumber(record.runtime_sec),
    duration_sec: readNullableNumber(record.duration_sec),
    estimated_seconds: readNullableNumber(record.estimated_seconds),
    runtime_minutes: readNullableNumber(record.runtime_minutes),
    time_estimate_minutes: readNullableNumber(record.time_estimate_minutes),
    estimated_minutes: readNullableNumber(record.estimated_minutes),
    minutes: readNullableNumber(record.minutes),
    format: readNullableString(record.format),
    type: readNullableString(record.type),
  };
}

function createSessionRow(record: Record<string, unknown>): SessionRow {
  const id = readNullableString(record.id);
  if (!id) throw makeHttpError(500, "session_creation_failed", "Failed to start session.");
  return {
    id,
    started_at: readNullableString(record.started_at),
    created_at: readNullableString(record.created_at),
  };
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

function sanitizePayload(body: unknown): StartPayload {
  const source = toRecord(body) ?? {};
  const drillId = firstString(source.drill_id ?? source.drillId ?? source.id);
  const payload: StartPayload = {};
  if (drillId && isUuid(drillId)) {
    payload.drillId = drillId;
  }
  return payload;
}

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------

const DEFAULT_TIER_MINUTES: Record<Tier, number> = {
  [Tier.FREE]: 10,
  [Tier.PRO]: 30,
  [Tier.VIP]: 120,
};

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
  const message = typeof record.message === "string" && record.message ? record.message : fallback.message;
  return { status, code, message };
}

function handleDbError(label: string, error: unknown) {
  log.error(`drills/start ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function isMissingRelation(error: unknown) {
  const record = toRecord(error);
  const raw = typeof record?.message === "string" ? record.message : "";
  const msg = raw.toLowerCase();
  return msg.includes("does not exist") || msg.includes("relation") || msg.includes("not exist");
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

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => firstString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 50);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, 50);
  }
  return [];
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeCoach(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/_/g, "-");
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function readNullableString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

function readNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function readNullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.map((entry) => firstString(entry)).filter((entry): entry is string => Boolean(entry));
  return out.length ? out : [];
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
