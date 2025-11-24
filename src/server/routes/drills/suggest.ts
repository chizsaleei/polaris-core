// src/server/routes/drills/suggest.ts
/**
 * Drill suggestion endpoint
 *
 * Returns up to N recommended drills for the authenticated user based on their
 * recent history (coach/topic), tier, and optional query overrides.
 *
 * Query params (all optional):
 *   - limit: number (1..10, default 5)
 *   - coach: csv of coach ids
 *   - topic: csv of topics
 *   - difficulty: csv difficulty labels/levels
 */

import { Router, type Request, type Response } from "express";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import { Tier } from "../../../core/scheduler/daily-deterministic";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type RequestWithUser = Request & { user?: { id?: string | null } };

router.get(
  "/",
  (req: Request, res: Response) => {
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
        const tier = await resolveTierForUser(supabase, userId);

        const [history, catalog] = await Promise.all([
          fetchRecentHistory(supabase, userId, 20),
          fetchCatalog(supabase, {
            limit: query.limit * 4,
            coaches: query.coach.length ? query.coach : undefined,
            topics: query.topic.length ? query.topic : undefined,
            difficulty: query.difficulty.length ? query.difficulty : undefined,
            tier,
          }),
        ]);

        if (!catalog.length) {
          return res.status(200).json({ ok: true, data: { items: [], correlation_id: getCorrelationId() } });
        }

        const suggestions = rankSuggestions({ catalog, history, limit: query.limit, tier });

        return res.status(200).json({
          ok: true,
          data: {
            items: suggestions,
          },
          correlation_id: getCorrelationId(),
        });
      } catch (error) {
        log.error("drills/suggest error", { err: safeError(error) });
        const httpError = parseHttpError(error);
        return sendError(res, httpError.status, httpError.code, httpError.message);
      }
    });
  },
);

export default router;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface SuggestQuery {
  limit: number;
  coach: string[];
  topic: string[];
  difficulty: string[];
}

interface HistoryRow {
  drill_id?: string | null;
  coach?: string | null;
  topic?: string | null;
  score?: number | null;
  created_at?: string | null;
}

interface DrillRow {
  id: string;
  title: string;
  coach_key?: string | null;
  coach_id?: string | null;
  topic?: string | null;
  skill?: string | null;
  difficulty?: string | number | null;
  tags?: string[] | null;
  minutes?: number | null;
  format?: string | null;
  state?: string | null;
  published_at?: string | null;
  estimated_minutes?: number | null;
  runtime_minutes?: number | null;
  time_estimate_minutes?: number | null;
}

interface RankedSuggestion {
  drill_id: string;
  title: string;
  coach_id: string | null;
  topic?: string | null;
  difficulty?: string | number | null;
  minutes?: number | null;
  format?: string | null;
  score: number;
  reason: string[];
}

// -----------------------------------------------------------------------------
// Ranking pipeline
// -----------------------------------------------------------------------------

function rankSuggestions(input: {
  catalog: DrillRow[];
  history: HistoryRow[];
  limit: number;
  tier: Tier;
}): RankedSuggestion[] {
  const { catalog, history, limit } = input;
  const lru = buildLru(history);
  const last = history[0];
  const coachPreference = buildPreference(history.map((h) => normalizeCoach(h.coach)));
  const topicPreference = buildPreference(history.map((h) => (h.topic || "").toLowerCase()));

  const scored = catalog
    .filter((drill) => {
      if (lru.has(drill.id)) return false;
      return true;
    })
    .map((drill) => {
      const coach = normalizeCoach(drill.coach_key ?? drill.coach_id);
      const topic = (drill.topic || "").toLowerCase();
      let score = 0;
      const reasons: string[] = [];

      score += baseScore(drill);

      if (coach && coachPreference[coach]) {
        score += 0.6 * coachPreference[coach];
        reasons.push("matches recent coach preference");
      }
      if (topic && topicPreference[topic]) {
        score += 0.4 * topicPreference[topic];
        reasons.push("reinforces recent topic");
      }

      if (last && coach && normalizeCoach(last.coach) !== coach) {
        score += 0.1;
      }

      if (Array.isArray(drill.tags) && drill.tags.some((t) => t.toLowerCase().includes("starter"))) {
        score += 0.2;
      }

      return {
        drill_id: drill.id,
        title: drill.title,
        coach_id: coach,
        topic: drill.topic ?? null,
        difficulty: drill.difficulty ?? null,
        minutes: pickMinutes(drill),
        format: drill.format ?? null,
        score,
        reason: reasons.length ? reasons : ["fresh practice item"],
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

function buildLru(history: HistoryRow[]) {
  const out = new Set<string>();
  for (const row of history.slice(0, 10)) {
    if (row.drill_id) out.add(row.drill_id);
  }
  return out;
}

function buildPreference(values: Array<string | null | undefined>) {
  const freq: Record<string, number> = {};
  values.forEach((value) => {
    if (!value) return;
    const key = value.toLowerCase();
    freq[key] = (freq[key] || 0) + 1;
  });
  const max = Object.values(freq).reduce((m, v) => Math.max(m, v), 0) || 1;
  const normalized: Record<string, number> = {};
  Object.keys(freq).forEach((key) => {
    normalized[key] = freq[key] / max;
  });
  return normalized;
}

function baseScore(drill: DrillRow) {
  let score = 0.5;
  if (drill.published_at) score += 0.2;
  const difficulty = String(drill.difficulty || "").toLowerCase();
  if (["beginner", "intermediate", "advanced"].includes(difficulty)) score += 0.1;
  if (drill.minutes && drill.minutes <= 5) score += 0.1;
  return score;
}

// -----------------------------------------------------------------------------
// Data fetching
// -----------------------------------------------------------------------------

async function resolveTierForUser(supabase: Supabase, userId: string): Promise<Tier> {
  const { data: entRows } = await supabase
    .from("entitlements")
    .select("plan")
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

async function fetchRecentHistory(supabase: Supabase, userId: string, limit: number): Promise<HistoryRow[]> {
  const { data, error } = await supabase
    .from("attempts")
    .select("drill_id, coach_key, topic, score, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error && !isMissingRelation(error)) handleDbError("fetch_history", error);
  if (!Array.isArray(data) || !data.length) {
    return [];
  }

  const history: HistoryRow[] = [];
  for (const row of data) {
    const record = toRecord(row);
    if (!record) continue;
    history.push({
      drill_id: readNullableString(record.drill_id),
      coach: readNullableString(record.coach_key),
      topic: readNullableString(record.topic),
      score: readNullableNumber(record.score),
      created_at: readNullableString(record.created_at),
    });
  }

  return history;
}

async function fetchCatalog(
  supabase: Supabase,
  input: {
    limit: number;
    coaches?: string[];
    topics?: string[];
    difficulty?: string[];
    tier: Tier;
  },
): Promise<DrillRow[]> {
  let builder = supabase
    .from("drills")
    .select(
      "id, title, coach_key, coach_id, topic, skill, difficulty, tags, minutes, format, state, published_at, estimated_minutes, runtime_minutes, time_estimate_minutes",
    )
    .limit(input.limit);

  if (input.coaches?.length) builder = builder.in("coach_key", input.coaches.map(normalizeCoach));
  if (input.topics?.length) builder = builder.in("topic", input.topics);
  if (input.difficulty?.length) builder = builder.in("difficulty", input.difficulty);

  builder = builder.or(
    [
      "state.eq.Approved",
      "state.eq.Published",
      "state.eq.approved",
      "state.eq.published",
      "published_at.not.is.null",
      "is_public.eq.true",
      "active.eq.true",
    ].join(","),
  );

  builder = builder.order("published_at", { ascending: false }).order("updated_at", { ascending: false });

  const { data, error } = await builder;
  if (error && !isMissingRelation(error)) handleDbError("fetch_catalog", error);
  if (!Array.isArray(data) || !data.length) return [];

  const catalog: DrillRow[] = [];
  for (const row of data) {
    const record = toRecord(row);
    if (!record) continue;
    const drill = createDrillRow(record);
    if (!drill) continue;
    catalog.push(drill);
  }

  return catalog.filter((row) => allowedByTier(row.tags, input.tier));
}

function createDrillRow(record: Record<string, unknown>): DrillRow | null {
  const id = readNullableString(record.id);
  const title = readNullableString(record.title);
  if (!id || !title) return null;

  return {
    id,
    title,
    coach_key: readNullableString(record.coach_key),
    coach_id: readNullableString(record.coach_id),
    topic: readNullableString(record.topic),
    skill: readNullableString(record.skill),
    difficulty: readDifficulty(record.difficulty),
    tags: readStringArray(record.tags),
    minutes: readNullableNumber(record.minutes),
    format: readNullableString(record.format),
    state: readNullableString(record.state),
    published_at: readNullableString(record.published_at),
    estimated_minutes: readNullableNumber(record.estimated_minutes),
    runtime_minutes: readNullableNumber(record.runtime_minutes),
    time_estimate_minutes: readNullableNumber(record.time_estimate_minutes),
  };
}

// -----------------------------------------------------------------------------
// Query helpers
// -----------------------------------------------------------------------------

function sanitizeQuery(req: Request): SuggestQuery {
  const limit = clampInt(firstNumber(req.query.limit), 1, 10, 5);
  const coach = toList(req.query.coach ?? req.query.coach_id);
  const topic = toList(req.query.topic);
  const difficulty = toList(req.query.difficulty);
  return { limit, coach, topic, difficulty };
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry ?? "").split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
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

function handleDbError(label: string, error: { message?: string }) {
  log.error(`drills/suggest ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function makeHttpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

interface HttpErrorPayload {
  status: number;
  code: string;
  message: string;
}

function parseHttpError(error: unknown): HttpErrorPayload {
  const fallback: HttpErrorPayload = { status: 500, code: "internal_error", message: "Unable to suggest drills." };
  const record = toRecord(error);
  if (!record) return fallback;

  const status = typeof record.status === "number" ? record.status : fallback.status;
  const code = typeof record.code === "string" && record.code ? record.code : fallback.code;
  if (status === 500) {
    return { status, code, message: fallback.message };
  }
  const message = readErrorMessage(record) || fallback.message;
  return { status, code, message };
}

function isMissingRelation(error: any) {
  const msg = readErrorMessage(error).toLowerCase();
  return msg.includes("does not exist") || msg.includes("relation") || msg.includes("missing");
}

function firstNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value as number)));
}

function normalizeCoach(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/-/g, "_");
}

function pickMinutes(drill: DrillRow) {
  const minutes =
    toNumber(drill.runtime_minutes) ??
    toNumber(drill.estimated_minutes) ??
    toNumber(drill.minutes) ??
    toNumber(drill.time_estimate_minutes);
  if (Number.isFinite(minutes)) return Math.round(minutes as number);
  return null;
}

function toNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function allowedByTier(tags: string[] | null | undefined, tier: Tier) {
  if (!Array.isArray(tags)) return true;
  const bag = new Set(tags.map((t) => String(t || "").toLowerCase()));
  if (bag.has("vip_only") && tier !== Tier.VIP) return false;
  if (bag.has("pro_only") && tier === Tier.FREE) return false;
  return true;
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

function readNullableNumber(value: unknown): number | null {
  const num = toNumber(value);
  return typeof num === "number" ? num : null;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return out.length ? out : [];
}

function readDifficulty(value: unknown): string | number | null {
  if (typeof value === "string" && value.length) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readErrorMessage(value: unknown): string {
  const record = toRecord(value);
  if (record && typeof record.message === "string") {
    return record.message;
  }
  return "";
}
