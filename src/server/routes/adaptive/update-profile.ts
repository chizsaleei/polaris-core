// src/server/routes/adaptive/update-profile.ts
/**
 * Polaris Core - Adaptive update-profile endpoint
 *
 * Accepts onboarding quiz answers, persists lightweight profile data,
 * and returns coach recommendations with a 7 day starter plan.
 *
 * Path (mounted by the server):
 *   POST /adaptive/update-profile
 */

import {
  Router,
  type Request,
  type Response,
} from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../lib/supabase";
import { Tier } from "../../../types";
import {
  recommendWithPlan,
  type QuizAnswers,
  type CoachRec,
  type SevenDayPlan,
} from "../../../core/matching/quiz-to-coach";

const router = Router();
const supabase = createClient();

// -----------------------------------------------------------------------------
// Shared API shapes for UI and server
// -----------------------------------------------------------------------------

export interface AdaptiveUpdateProfileRequestBody {
  firstName: string;
  profession: string;
  goal: string;
  domains: string[];
  priorities: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  timezone?: string | null;
  countryCode?: string | null;
  currencyCode?: string | null;
  dailyTargetMinutes?: number | null;
  reminderTimeLocal?: string | null;
  practiceFocus?: string | null;
  marketingOptIn?: boolean | null;
}

export interface AdaptiveUpdateProfileSuccess {
  saved: boolean;
  tier: Tier;
  recommendations: CoachRec[];
  starterPlan: SevenDayPlan;
}

export type AdaptiveUpdateProfileErrorCode =
  | "unauthorized"
  | "invalid_payload"
  | "internal_error";

export interface AdaptiveUpdateProfileError {
  error: AdaptiveUpdateProfileErrorCode;
  message?: string;
  issues?: string[];
}

export type AdaptiveUpdateProfileResponseBody =
  | AdaptiveUpdateProfileSuccess
  | AdaptiveUpdateProfileError;

// Re-export core matching types for the web app
export { Tier };
export type { CoachRec, SevenDayPlan, QuizAnswers };

// -----------------------------------------------------------------------------
// Auth helper for typed user on Request
// -----------------------------------------------------------------------------

interface AuthUserShape {
  id?: unknown;
  userId?: unknown;
}

type AdaptiveRequest = Request<
  ParamsDictionary,
  AdaptiveUpdateProfileResponseBody,
  unknown
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

// -----------------------------------------------------------------------------
// Main handler
// -----------------------------------------------------------------------------

export async function handleAdaptiveUpdateProfile(
  req: AdaptiveRequest,
  res: Response<AdaptiveUpdateProfileResponseBody>,
): Promise<void> {
  try {
    // 1) Identify user
    const headerUser = readUserId(req);
    const fallbackHeader = req.header("x-user-id") ?? null;
    const userId = headerUser ?? fallbackHeader;

    if (!userId) {
      res.status(401).json({
        error: "unauthorized",
        message: "Missing user id",
      });
      return;
    }

    // 2) Parse and validate payload
    const body = sanitizeQuiz(req.body);
    const issues = validateQuiz(body);
    if (issues.length > 0) {
      res.status(400).json({
        error: "invalid_payload",
        message: "Invalid onboarding quiz payload",
        issues,
      });
      return;
    }

    // 3) Resolve tier
    const tier = await resolveTierForUser(supabase, userId);

    // 4) Persist onboarding payload to profiles
    let saved = false;
    const nowIso = new Date().toISOString();

    const preferencePatch: Partial<ProfileOnboardingRow> = {
      timezone: body.timezone ?? null,
      country_code: body.countryCode ?? null,
      currency_code: body.currencyCode ?? null,
      daily_target_minutes: body.dailyTargetMinutes ?? null,
      reminder_time_local: body.reminderTimeLocal ?? null,
      practice_focus: body.practiceFocus ?? null,
    };

    if (typeof body.marketingOptIn === "boolean") {
      preferencePatch.marketing_opt_in = body.marketingOptIn;
    }

    const fullPayload: ProfileOnboardingRow = {
      id: userId,
      onboarding: body,
      first_name: body.firstName || null,
      profession: body.profession || null,
      goal: body.goal || null,
      difficulty: body.difficulty,
      updated_at: nowIso,
      ...preferencePatch,
    };

    try {
      const { error: upError } = await supabase
        .from("profiles")
        .upsert(fullPayload, { onConflict: "id" });

      if (!upError) {
        saved = true;
      } else {
        // If the upsert fails due to schema differences, fall back to minimal shape
        const minimalPayload: ProfileOnboardingRow = {
          id: userId,
          onboarding: body,
          updated_at: nowIso,
          ...preferencePatch,
        };
        const { error: minimalError } = await supabase
          .from("profiles")
          .upsert(minimalPayload, { onConflict: "id" });

        saved = !minimalError;
      }
    } catch {
      const minimalPayload: ProfileOnboardingRow = {
        id: userId,
        onboarding: body,
        updated_at: nowIso,
        ...preferencePatch,
      };
      const { error: minimalError } = await supabase
        .from("profiles")
        .upsert(minimalPayload, { onConflict: "id" });

      saved = !minimalError;
    }

    // 5) Build recommendations and starter plan
    const { recommendations, starterPlan } = recommendWithPlan(
      toQuizAnswers(body),
      tier,
    );

    res.status(200).json({
      saved,
      tier,
      recommendations,
      starterPlan,
    });
  } catch (err: unknown) {
    console.error("/adaptive/update-profile error", err);

    const message = extractErrorMessage(err);

    res.status(500).json({
      error: "internal_error",
      message,
    });
  }
}

// Wire router without returning a Promise directly to satisfy no-misused-promises
router.post(
  "/",
  (
    req: AdaptiveRequest,
    res: Response<AdaptiveUpdateProfileResponseBody>,
  ): void => {
    void handleAdaptiveUpdateProfile(req, res);
  },
);

export const adaptiveUpdateProfileRouter = router;
export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Canonical sanitized quiz payload that the rest of the system uses
export type SanitizedQuizPayload = AdaptiveUpdateProfileRequestBody;

interface RawQuizInput {
  firstName?: unknown;
  first_name?: unknown;
  profession?: unknown;
  goal?: unknown;
  domains?: unknown;
  priorities?: unknown;
  difficulty?: unknown;
  timezone?: unknown;
  timeZone?: unknown;
  countryCode?: unknown;
  country_code?: unknown;
  currencyCode?: unknown;
  currency_code?: unknown;
  dailyTargetMinutes?: unknown;
  daily_target_minutes?: unknown;
  reminderTimeLocal?: unknown;
  reminder_time_local?: unknown;
  practiceFocus?: unknown;
  practice_focus?: unknown;
  marketingOptIn?: unknown;
  marketing_opt_in?: unknown;
}

function sanitizeQuiz(input: unknown): SanitizedQuizPayload {
  const raw: RawQuizInput =
    typeof input === "object" && input !== null
      ? (input as RawQuizInput)
      : {};

  const firstNameSource =
    typeof raw.firstName === "string" && raw.firstName.trim().length > 0
      ? raw.firstName
      : typeof raw.first_name === "string"
        ? raw.first_name
        : "";

  const firstName = firstNameSource.trim().slice(0, 100);
  const profession =
    typeof raw.profession === "string"
      ? raw.profession.trim().slice(0, 120)
      : "";
  const goal =
    typeof raw.goal === "string"
      ? raw.goal.trim().slice(0, 240)
      : "";

  const domains = arrOfString(raw.domains, 12);
  const priorities = arrOfString(raw.priorities, 12);
  const difficulty = clampInt(raw.difficulty, 1, 5, 3) as 1 | 2 | 3 | 4 | 5;
  const timezone = sanitizeString(raw.timezone ?? raw.timeZone, 120);
  const countryCode = normalizeCountryCode(
    raw.countryCode ?? raw.country_code,
  );
  const currencyCode = normalizeCurrencyCode(
    raw.currencyCode ?? raw.currency_code,
  );
  const dailyTargetMinutes = clampOptionalInt(
    raw.dailyTargetMinutes ?? raw.daily_target_minutes,
    0,
    600,
  );
  const reminderTimeLocal = sanitizeTime(raw.reminderTimeLocal ?? raw.reminder_time_local);
  const practiceFocus = sanitizeString(raw.practiceFocus ?? raw.practice_focus, 240);
  const marketingOptIn = toOptionalBoolean(
    raw.marketingOptIn ?? raw.marketing_opt_in,
  );

  return {
    firstName,
    profession,
    goal,
    domains,
    priorities,
    difficulty,
    timezone,
    countryCode,
    currencyCode,
    dailyTargetMinutes,
    reminderTimeLocal,
    practiceFocus,
    marketingOptIn,
  };
}

function validateQuiz(q: SanitizedQuizPayload): string[] {
  const issues: string[] = [];
  if (!q.firstName) issues.push("firstName is required");
  if (!q.profession) issues.push("profession is required");
  if (!q.goal) issues.push("goal is required");
  if (!Array.isArray(q.domains)) issues.push("domains must be an array");
  if (!Array.isArray(q.priorities)) issues.push("priorities must be an array");
  if (!(q.difficulty >= 1 && q.difficulty <= 5)) {
    issues.push("difficulty must be 1..5");
  }
  return issues;
}

function arrOfString(v: unknown, max = 20): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];

  for (const item of v) {
    let raw: string | null = null;
    if (typeof item === "string") {
      raw = item;
    } else if (typeof item === "number" && Number.isFinite(item)) {
      raw = item.toString(10);
    }
    if (!raw) continue;
    const s = raw.trim();
    if (!s) continue;
    out.push(s);
    if (out.length >= max) break;
  }

  return out;
}

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

function clampOptionalInt(
  v: unknown,
  min: number,
  max: number,
): number | null {
  const parsed = parseInteger(v);
  if (parsed == null) return null;
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function normalizeCountryCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const code = v.trim().slice(0, 3).toUpperCase();
  return code.length > 0 ? code : null;
}

function normalizeCurrencyCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const code = v.trim().slice(0, 3).toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function sanitizeTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(trimmed)) {
    return trimmed.slice(0, 8);
  }
  return null;
}

function toOptionalBoolean(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const normalized = v.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
  }
  return null;
}

function toQuizAnswers(q: SanitizedQuizPayload): QuizAnswers {
  return {
    firstName: q.firstName,
    profession: q.profession,
    goal: q.goal,
    domains: q.domains,
    priorities: normalizePriorities(q.priorities),
    difficulty: q.difficulty,
  };
}

function normalizePriorities(
  p: string[],
): QuizAnswers["priorities"] {
  const map: Record<string, QuizAnswers["priorities"][number]> = {
    fluency: "fluency",
    interview: "interview",
    exam: "exam",
    leadership: "leadership",
    technical: "technical",
    medical: "medical",
    nursing: "nursing",
    finance: "finance",
    admissions: "admissions",
    personal: "personal",
  };

  const out: QuizAnswers["priorities"] = [];
  for (const raw of p) {
    const k =
      typeof raw === "string" ? raw.trim().toLowerCase() : "";
    const mapped = map[k];
    if (mapped && !out.includes(mapped)) {
      out.push(mapped);
    }
  }

  // default priority if none matched
  return out.length > 0 ? out : ["fluency"];
}

// -----------------------------------------------------------------------------
// Supabase row types and tier resolver
// -----------------------------------------------------------------------------

interface EntitlementRow {
  plan: string | null;
  status: string | null;
  active: boolean | null;
}

interface ProfileTierRow {
  tier: string | null;
}

interface ProfileOnboardingRow {
  id: string;
  onboarding?: SanitizedQuizPayload;
  first_name?: string | null;
  profession?: string | null;
  goal?: string | null;
  difficulty?: number | null;
  updated_at?: string | null;
  timezone?: string | null;
  country_code?: string | null;
  currency_code?: string | null;
  daily_target_minutes?: number | null;
  reminder_time_local?: string | null;
  practice_focus?: string | null;
  marketing_opt_in?: boolean | null;
}

async function resolveTierForUser(
  client: ReturnType<typeof createClient>,
  userId: string,
): Promise<Tier> {
  // Prefer entitlements
  const entitlementsResult = await client
    .from("entitlements")
    .select("plan,status,active")
    .eq("user_id", userId)
    .eq("active", true);
  const entError = entitlementsResult.error;
  const ents = asEntitlementRows(entitlementsResult.data);

  if (!entError && ents.length > 0) {
    const plans = new Set(
      ents.map((e) => (e.plan ?? "").toLowerCase()),
    );
    if (
      plans.has("vip") ||
      plans.has("vip_monthly") ||
      plans.has("vip_yearly")
    ) {
      return Tier.VIP;
    }
    if (
      plans.has("pro") ||
      plans.has("pro_monthly") ||
      plans.has("pro_yearly")
    ) {
      return Tier.PRO;
    }
  }

  // Fallback to profiles.tier
  const profileResult = await client
    .from("profiles")
    .select("tier")
    .eq("id", userId)
    .maybeSingle();
  const prof = asProfileTierRow(profileResult.data);

  const t =
    typeof prof?.tier === "string"
      ? prof.tier.toLowerCase()
      : "free";

  if (t === "vip") return Tier.VIP;
  if (t === "pro") return Tier.PRO;
  return Tier.FREE;
}

function extractErrorMessage(err: unknown): string {
  if (typeof err === "string") return err;
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
  if (typeof value === "bigint") {
    return Number.isSafeInteger(Number(value)) ? Number(value) : null;
  }
  return null;
}

function asEntitlementRows(value: unknown): EntitlementRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isEntitlementRow);
}

function asProfileTierRow(value: unknown): ProfileTierRow | null {
  return isProfileTierRow(value) ? value : null;
}

function isEntitlementRow(value: unknown): value is EntitlementRow {
  if (!isRecord(value)) return false;
  const { plan, status, active } = value;
  const planOk = plan === null || typeof plan === "string";
  const statusOk = status === null || typeof status === "string";
  const activeOk = active === null || typeof active === "boolean";
  return planOk && statusOk && activeOk;
}

function isProfileTierRow(value: unknown): value is ProfileTierRow {
  if (!isRecord(value)) return false;
  const { tier } = value;
  return tier === null || typeof tier === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
