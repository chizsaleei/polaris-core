/**
 * Polaris Core - Adaptive next-item endpoint
 */

import {
  Router,
  type Request,
  type Response,
} from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../lib/supabase";
import {
  pickDailyItems,
  type CatalogItem,
  type PickerFilters,
} from "../../../core/scheduler/daily-deterministic";
import { Tier, type CoachKey } from "../../../types";

const router = Router();
const supabase = createClient();

// Re-export shared scheduler types for API/UI
export { Tier };
export type { CoachKey, CatalogItem, PickerFilters };

// ---------------------------------------------------------------------
// Shared types for API/UI
// ---------------------------------------------------------------------

export interface AdaptiveNextItemFiltersInput {
  coach?: CoachKey[];
  topic?: string[];
  skill?: string[];
  format?: string[];
  difficultyMin?: number;
  difficultyMax?: number;
  language?: string;
}

export interface AdaptiveNextItemRequestBody {
  count?: number;
  lru?: string[];
  lastSelectedId?: string;
  filters?: AdaptiveNextItemFiltersInput;
}

export type AdaptiveNextItemSuccess = ReturnType<typeof pickDailyItems>;

export type AdaptiveNextItemErrorCode = "unauthorized" | "internal_error";

export interface AdaptiveNextItemError {
  error: AdaptiveNextItemErrorCode;
  message?: string;
}

export type AdaptiveNextItemResponse =
  | AdaptiveNextItemSuccess
  | AdaptiveNextItemError;

// Auth helper shape to match other routes
interface AuthUserShape {
  id?: unknown;
  userId?: unknown;
}

type AdaptiveRequest = Request<
  ParamsDictionary,
  AdaptiveNextItemResponse,
  AdaptiveNextItemRequestBody
>;

type RequestWithUser = AdaptiveRequest & { user?: AuthUserShape };

export function readUserId(req: AdaptiveRequest): string | null {
  const r = req as RequestWithUser;
  const u = r.user;
  if (!u) return null;
  if (typeof u.id === "string") return u.id;
  if (typeof u.userId === "string") return u.userId;
  return null;
}

// ---------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------

export async function handleAdaptiveNextItem(
  req: AdaptiveRequest,
  res: Response<AdaptiveNextItemResponse>,
): Promise<void> {
  try {
    const headerUser = readUserId(req);
    const headerFallback = req.header("x-user-id");
    const userId = headerUser ?? headerFallback ?? null;

    if (!userId) {
      res.status(401).json({
        error: "unauthorized",
        message: "Missing user id",
      });
      return;
    }

    const { tier, timezone } = await resolveTierAndTimezoneForUser(
      supabase,
      userId,
    );

    const body: AdaptiveNextItemRequestBody = req.body ?? {};

    const count = clampInt(body.count, 1, 5, 1);
    const lru = Array.isArray(body.lru) ? body.lru.slice(0, 50) : [];

    const items = await loadActiveCatalogItems(supabase);

    const lastSelected =
      body.lastSelectedId != null
        ? items.find((i) => i.id === body.lastSelectedId) ?? null
        : null;

    const result = pickDailyItems({
      userId,
      tier,
      items,
      lru,
      count,
      filters: normalizeFilters(body.filters),
      lastSelected,
      timezone: timezone ?? undefined,
    });

    res.status(200).json(result);
  } catch (err: unknown) {
    console.error("/adaptive/next-item error", err);
    const message = extractErrorMessage(err);

    res.status(500).json({
      error: "internal_error",
      message,
    });
  }
}

// Wire router without async callback to satisfy no-misused-promises
router.post(
  "/",
  (
    req: AdaptiveRequest,
    res: Response<AdaptiveNextItemResponse>,
  ): void => {
    void handleAdaptiveNextItem(req, res);
  },
);

export const adaptiveNextItemRouter = router;
export default router;

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function clampInt(
  v: unknown,
  min: number,
  max: number,
  d: number,
): number {
  const parsed = parseInteger(v);
  if (parsed == null) return d;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeFilters(
  f?: AdaptiveNextItemFiltersInput,
): PickerFilters {
  return {
    coach: cleanupArray<CoachKey>(f?.coach),
    topic: cleanupArray<string>(f?.topic),
    skill: cleanupArray<string>(f?.skill),
    format: cleanupArray<string>(f?.format),
    difficultyMin: clampInt(f?.difficultyMin, 1, 5, 1),
    difficultyMax: clampInt(f?.difficultyMax, 1, 5, 5),
    language: typeof f?.language === "string" ? f.language : undefined,
  };
}

function cleanupArray<T extends string>(
  v: unknown,
): T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];

  for (const value of v) {
    if (typeof value === "string") {
      const s = value.trim();
      if (!s) continue;
      out.push(s as T);
      if (out.length >= 20) break;
    }
  }

  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------
// Supabase row types and resolvers
// ---------------------------------------------------------------------

interface EntitlementRow {
  plan: string | null;
  status: string;
}

interface ProfileSettingsRow {
  tier: string | null;
  timezone: string | null;
}

interface DrillRow {
  id: string | number;
  coach_key: string;
  skill: string | null;
  topic: string | null;
  format: string | null;
  difficulty: number | null;
  language: string | null;
  minutes: number | null;
  tags: string[] | null;
  active: boolean | null;
}

async function resolveTierAndTimezoneForUser(
  client: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ tier: Tier; timezone: string | null }> {
  // First, check entitlements for Pro or VIP
  const entitlementsResult = await client
    .from("entitlements")
    .select("plan,status")
    .eq("user_id", userId)
    .eq("active", true);
  const entError = entitlementsResult.error;
  const ents = asEntitlementRows(entitlementsResult.data);

  let tier: Tier = Tier.FREE;

  if (!entError && ents.length > 0) {
    const plans = new Set(
      ents.map((e) => (e.plan ?? "").toLowerCase()),
    );
    if (
      plans.has("vip") ||
      plans.has("vip_monthly") ||
      plans.has("vip_yearly")
    ) {
      tier = Tier.VIP;
    } else if (
      plans.has("pro") ||
      plans.has("pro_monthly") ||
      plans.has("pro_yearly")
    ) {
      tier = Tier.PRO;
    }
  }

  // Then, read profile tier and timezone
  const profileResult = await client
    .from("profiles")
    .select("tier,timezone")
    .eq("id", userId)
    .maybeSingle();
  const prof = asProfileSettingsRow(profileResult.data);

  const timezone = prof?.timezone ?? null;

  if (tier === Tier.FREE) {
    const t =
      typeof prof?.tier === "string"
        ? prof.tier.toLowerCase()
        : "free";

    if (t === "vip") tier = Tier.VIP;
    else if (t === "pro") tier = Tier.PRO;
  }

  return { tier, timezone };
}

async function loadActiveCatalogItems(
  client: ReturnType<typeof createClient>,
): Promise<CatalogItem[]> {
  const { data, error } = await client
    .from("drills")
    .select(
      [
        "id",
        "coach_key",
        "skill",
        "topic",
        "format",
        "difficulty",
        "language",
        "minutes",
        "tags",
        "active",
      ].join(","),
    )
    .eq("active", true);

  if (error) {
    throw new Error(`Failed to load drills: ${error.message}`);
  }

  const rows = asDrillRows(data);

  const mapped: CatalogItem[] = rows.map((r) => ({
    id: typeof r.id === "string" ? r.id : r.id.toString(),
    coach: normalizeCoachKey(r.coach_key),
    skill: r.skill ?? undefined,
    topic: r.topic ?? undefined,
    format: r.format ?? "drill",
    difficulty: normalizeDifficulty(r.difficulty),
    language: r.language ?? undefined,
    minutes: toInt(r.minutes, 12),
    tags: Array.isArray(r.tags) ? r.tags : [],
    active: r.active !== false,
  }));

  return mapped;
}

function normalizeDifficulty(
  v: unknown,
): 1 | 2 | 3 | 4 | 5 | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const c = Math.max(1, Math.min(5, Math.round(n)));
  return c as 1 | 2 | 3 | 4 | 5;
}

function toInt(
  v: unknown,
  d = 0,
): number {
  const parsed = parseInteger(v);
  return parsed ?? d;
}

/** Normalize coach keys: allow "chelsea-lightbown" or "chelsea_lightbown" */
function normalizeCoachKey(v: unknown): CoachKey {
  const s = toSafeString(v)
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");

  return (s as CoachKey) || ("chelsea_lightbown" as CoachKey);
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error && typeof err.message === "string") {
    return err.message;
  }
  if (isRecord(err) && typeof err.message === "string") {
    return err.message;
  }
  return "unknown_error";
}

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toSafeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toString(10);
  }
  if (typeof value === "bigint") {
    return value.toString(10);
  }
  return "";
}

function asEntitlementRows(value: unknown): EntitlementRow[] {
  return toArrayOf(value, isEntitlementRow);
}

function asProfileSettingsRow(
  value: unknown,
): ProfileSettingsRow | null {
  return isProfileSettingsRow(value) ? value : null;
}

function asDrillRows(value: unknown): DrillRow[] {
  return toArrayOf(value, isDrillRow);
}

function toArrayOf<T>(
  value: unknown,
  predicate: (entry: unknown) => entry is T,
): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const entry of value) {
    if (predicate(entry)) {
      result.push(entry);
    }
  }
  return result;
}

function isEntitlementRow(value: unknown): value is EntitlementRow {
  if (!isRecord(value)) return false;
  const { plan, status } = value;
  return (
    (plan === null || typeof plan === "string") &&
    typeof status === "string"
  );
}

function isProfileSettingsRow(
  value: unknown,
): value is ProfileSettingsRow {
  if (!isRecord(value)) return false;
  const { tier, timezone } = value;
  return (
    (tier === null || typeof tier === "string") &&
    (timezone === null || typeof timezone === "string")
  );
}

function isDrillRow(value: unknown): value is DrillRow {
  if (!isRecord(value)) return false;
  const {
    id,
    coach_key: coachKey,
    skill,
    topic,
    format,
    difficulty,
    language,
    minutes,
    tags,
    active,
  } = value;
  const idValid =
    typeof id === "string" || typeof id === "number";
  const coachValid = typeof coachKey === "string";
  const skillValid = skill === null || typeof skill === "string";
  const topicValid = topic === null || typeof topic === "string";
  const formatValid = format === null || typeof format === "string";
  const difficultyValid =
    difficulty === null || typeof difficulty === "number";
  const languageValid =
    language === null || typeof language === "string";
  const minutesValid =
    minutes === null || typeof minutes === "number";
  const tagsValid = tags === null || isStringArray(tags);
  const activeValid =
    active === null || typeof active === "boolean";

  return (
    idValid &&
    coachValid &&
    skillValid &&
    topicValid &&
    formatValid &&
    difficultyValid &&
    languageValid &&
    minutesValid &&
    tagsValid &&
    activeValid
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
  );
}
