// src/server/routes/admin/metrics.ts
import type { Request, Response, NextFunction } from "express";
import { Router } from "express";

import { createClient } from "../../../lib/supabase";

const router = Router();
const supabase = createClient();

type TableMaybe =
  | "events"
  | "sessions"
  | "payments_events"
  | "entitlements"
  | "drills"
  | "practice_packs"
  | "profiles";

interface ProfilesAdminRow {
  is_admin: boolean | null;
}

interface CountResult {
  ok: boolean;
  count: number;
  error?: string;
}

interface PaymentEventRow {
  provider: string | null;
  status: string | null;
  amount_minor: number | null;
  currency: string | null;
  created_at: string;
}

interface DrillRow {
  id: string | number;
  coach_key: string | null;
  created_at: string;
}

interface EventRowLite {
  name: string | null;
  tier: string | null;
  coach_id: string | null;
  created_at: string;
  user_id?: string | null;
}

interface CohortEventRow {
  user_id: string | null;
  created_at: string;
}

interface DistinctUserRow {
  user_id: string | null;
}

type AdminRequest = Request & {
  user?: { id?: string | null; userId?: string | null };
};

type SupabaseTableQuery = ReturnType<(typeof supabase)["from"]>;
type SupabaseSelectBuilder = ReturnType<SupabaseTableQuery["select"]>;
type FilterFn = (q: SupabaseSelectBuilder) => SupabaseSelectBuilder;

// -------- Admin guard
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
      .maybeSingle<ProfilesAdminRow>();
    if (prof.data?.is_admin) return true;
  } catch {
    // ignore
  }

  return false;
}

const adminGate = async (req: AdminRequest, res: Response, next: NextFunction): Promise<void> => {
  const uid = resolveUserId(req);
  if (!(await isAdminUser(uid))) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  next();
};

router.use((req, res, next) => {
  void adminGate(req as AdminRequest, res, next);
});

// -------- Helpers

function clampDays(days: number, min = 1, max = 180) {
  return Math.max(min, Math.min(max, Math.floor(days)));
}

function parseDateOr(defaultIso: string, v?: string | string[]) {
  if (!v) return new Date(defaultIso);
  const s = Array.isArray(v) ? v[0] : v;
  const d = new Date(s);
  return Number.isFinite(d.valueOf()) ? d : new Date(defaultIso);
}

function isoDayStart(d: Date) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x.toISOString();
}

function isoDayEnd(d: Date) {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x.toISOString();
}

function sanitizeError(msg: string) {
  return msg.replace(/\s+/g, " ").slice(0, 180);
}

function resolveUserId(req: AdminRequest): string | null {
  if (req.user?.id && typeof req.user.id === "string") return req.user.id;
  if (req.user?.userId && typeof req.user.userId === "string") return req.user.userId;
  const header = req.header("x-user-id");
  return header ? String(header) : null;
}

// Safe count for a table
async function safeCount(table: TableMaybe, filters?: Array<[string, string | number | boolean]>): Promise<CountResult> {
  try {
    let query = supabase.from(table).select("*", { count: "exact", head: true });
    if (filters) {
      for (const [col, val] of filters) {
        query = query.eq(col, val);
      }
    }
    const { count, error } = await query;
    if (error) {
      const missing = /42P01|relation .* does not exist/i.test(error.message);
      return { ok: missing, count: 0, error: missing ? "table_missing" : sanitizeError(error.message) };
    }
    return { ok: true, count: count || 0 };
  } catch (err) {
    return { ok: false, count: 0, error: sanitizeError(String((err as Error)?.message || err)) };
  }
}

async function fetchRows<T>(
  table: TableMaybe,
  columns: string,
  where: FilterFn = (q) => q,
  limit = 10000,
): Promise<T[]> {
  try {
    const baseQuery = supabase.from(table).select(columns) as SupabaseSelectBuilder;
    const filteredQuery = where(baseQuery);
    const query = filteredQuery.order("created_at", { ascending: false }).range(0, Math.max(0, limit - 1));
    const { data, error } = await query;
    if (error || !data) {
      return [];
    }
    return data as T[];
  } catch {
    return [];
  }
}

// -------- KPIs and summaries

async function getSummary() {
  const [profiles, sessions, attempts, packs, drills, entitlements, payments] = await Promise.all([
    safeCount("profiles"),
    safeCount("sessions"),
    safeCount("events", [["name", "practice_submitted"]]),
    safeCount("practice_packs"),
    safeCount("drills"),
    safeCount("entitlements", [["active", true]]),
    safeCount("payments_events"),
  ]);

  return { profiles, sessions, attempts, packs, drills, entitlements, payments };
}

async function distinctUsersSince(table: "events" | "sessions", sinceIso: string) {
  try {
    const { data, error } = await supabase
      .from(table)
      .select("user_id")
      .gte("created_at", sinceIso)
      .not("user_id", "is", null)
      .limit(100000);
    if (error || !data) return 0;
    const set = new Set<string>((data as DistinctUserRow[]).map((r) => r.user_id).filter((id): id is string => Boolean(id)));
    return set.size;
  } catch {
    return 0;
  }
}

async function computeActiveKpis(now = new Date()) {
  const oneDay = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
  const seven = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirty = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const dau = await distinctUsersSince("events", oneDay.toISOString());
  const wau = await distinctUsersSince("events", seven.toISOString());
  const mau = await distinctUsersSince("events", thirty.toISOString());

  return { dau, wau, mau, asOf: now.toISOString() };
}

async function paymentsSummary(sinceIso: string, untilIso: string) {
  const paidStatuses = new Set(["paid", "succeeded", "completed", "approved"]);
  const rows = await fetchRows<PaymentEventRow>(
    "payments_events",
    "provider,status,amount_minor,currency,created_at",
    (q) => q.gte("created_at", sinceIso).lte("created_at", untilIso),
    50000,
  );

  const byKey: Record<string, { count: number; amountMinor: number; currency: string }> = {};
  for (const r of rows) {
    const key = `${r.provider || "unknown"}:${r.currency || "USD"}`;
    const paid = paidStatuses.has(String(r.status || "").toLowerCase());
    if (!byKey[key]) byKey[key] = { count: 0, amountMinor: 0, currency: r.currency || "USD" };
    if (paid) {
      byKey[key].count += 1;
      byKey[key].amountMinor += Number(r.amount_minor || 0);
    }
  }

  const total = Object.values(byKey).reduce<Record<string, number>>((acc, cur) => {
    acc[cur.currency] = (acc[cur.currency] || 0) + cur.amountMinor;
    return acc;
  }, {});

  return { buckets: byKey, totals: total };
}

async function contentSummary() {
  const drills = await fetchRows<DrillRow>(
    "drills",
    "id,coach_key,created_at",
    (q) => q,
    20000,
  );
  const byCoach: Record<string, number> = {};
  for (const r of drills) {
    const k = r.coach_key || "unknown";
    byCoach[k] = (byCoach[k] || 0) + 1;
  }
  return { drillsByCoach: byCoach, totalDrills: drills.length };
}

async function eventsGrouped(sinceIso: string, untilIso: string) {
  const rows = await fetchRows<EventRowLite>(
    "events",
    "name,tier,coach_id,created_at",
    (q) => q.gte("created_at", sinceIso).lte("created_at", untilIso),
    50000,
  );
  const byName: Record<string, number> = {};
  const byNameTier: Record<string, number> = {};

  for (const r of rows) {
    const n = String(r.name || "unknown");
    byName[n] = (byName[n] || 0) + 1;

    const key = `${n}:${r.tier || "unknown"}`;
    byNameTier[key] = (byNameTier[key] || 0) + 1;
  }

  return { byName, byNameTier };
}

async function weeklyCohorts(weeksBack = 8) {
  weeksBack = clampDays(weeksBack, 1, 26);
  const rows = await fetchRows<CohortEventRow>(
    "events",
    "user_id,created_at",
    (q) => q.gte("created_at", new Date(Date.now() - weeksBack * 7 * 24 * 3600 * 1000).toISOString()),
    100000,
  );
  if (!rows.length) return { weeks: [], cohorts: {} as Record<string, number[]>, cohortSizes: {} as Record<string, number> };

  const weekOf = (d: Date) => {
    const x = new Date(d);
    x.setUTCHours(0, 0, 0, 0);
    return x.toISOString().slice(0, 10);
  };

  const firstWeek = new Map<string, string>();
  for (const r of rows) {
    const uid = r.user_id;
    if (!uid) continue;
    const w = weekOf(new Date(r.created_at));
    const cur = firstWeek.get(uid);
    if (!cur || w < cur) firstWeek.set(uid, w);
  }

  const weekSet = new Set<string>();
  for (const r of rows) weekSet.add(weekOf(new Date(r.created_at)));
  const weeks = Array.from(weekSet).sort();

  const userWeeks = new Map<string, Set<string>>();
  for (const r of rows) {
    const uid = r.user_id;
    if (!uid) continue;
    const w = weekOf(new Date(r.created_at));
    const set = userWeeks.get(uid) || new Set<string>();
    set.add(w);
    userWeeks.set(uid, set);
  }

  const cohorts: Record<string, number[]> = {};
  for (const [uid, w0] of firstWeek.entries()) {
    const idx0 = weeks.indexOf(w0);
    if (idx0 < 0) continue;
    const set = userWeeks.get(uid) || new Set<string>();
    for (let i = 0; i < weeks.length - idx0; i++) {
      const w = weeks[idx0 + i];
      const key = w0;
      if (!cohorts[key]) cohorts[key] = [];
      cohorts[key][i] = (cohorts[key][i] || 0) + (set.has(w) ? 1 : 0);
    }
  }

  const cohortSizes: Record<string, number> = {};
  for (const w of weeks) {
    let c = 0;
    for (const v of firstWeek.values()) if (v === w) c++;
    if (c) cohortSizes[w] = c;
  }

  return { weeks, cohorts, cohortSizes };
}

// -------- Routes

router.get("/", (_req, res) => {
  void handleMetricsOverview(res);
});

router.get("/events", (req, res) => {
  void handleEventsMetrics(req, res);
});

router.get("/active", (_req, res) => {
  void handleActiveMetrics(res);
});

router.get("/payments", (req, res) => {
  void handlePaymentsMetrics(req, res);
});

router.get("/content", (_req, res) => {
  void handleContentMetrics(res);
});

router.get("/cohorts", (req, res) => {
  void handleCohortMetrics(req, res);
});

// -------- Route handlers

const handleMetricsOverview = async (res: Response) => {
  try {
    const [summary, kpis, pay] = await Promise.all([
      getSummary(),
      computeActiveKpis(),
      paymentsSummary(new Date(Date.now() - 24 * 3600 * 1000).toISOString(), new Date().toISOString()),
    ]);

    res.status(200).json({
      ok: true,
      summary,
      kpis,
      paymentsLast24h: pay,
      time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[admin/metrics] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

const handleEventsMetrics = async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const defaultSince = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
    const since = parseDateOr(defaultSince, req.query.since as string | undefined);
    const until = parseDateOr(now.toISOString(), req.query.until as string | undefined);

    const out = await eventsGrouped(isoDayStart(since), isoDayEnd(until));
    res.status(200).json({ ok: true, range: { since: isoDayStart(since), until: isoDayEnd(until) }, ...out });
  } catch (error) {
    console.error("[admin/metrics/events] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

const handleActiveMetrics = async (res: Response) => {
  try {
    const kpis = await computeActiveKpis();
    res.status(200).json({ ok: true, kpis });
  } catch (error) {
    console.error("[admin/metrics/active] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

const handlePaymentsMetrics = async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const defaultSince = new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString();
    const since = parseDateOr(defaultSince, req.query.since as string | undefined);
    const until = parseDateOr(now.toISOString(), req.query.until as string | undefined);
    const range = { since: isoDayStart(since), until: isoDayEnd(until) };

    const summary = await paymentsSummary(range.since, range.until);
    res.status(200).json({ ok: true, range, ...summary });
  } catch (error) {
    console.error("[admin/metrics/payments] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

const handleContentMetrics = async (res: Response) => {
  try {
    const content = await contentSummary();
    res.status(200).json({ ok: true, ...content });
  } catch (error) {
    console.error("[admin/metrics/content] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

const handleCohortMetrics = async (req: Request, res: Response) => {
  try {
    const weeksParam = req.query.weeks as string | undefined;
    const parsedWeeks = Number(weeksParam);
    const weeksBack = Number.isFinite(parsedWeeks) ? parsedWeeks : 8;

    const cohorts = await weeklyCohorts(weeksBack);
    res.status(200).json({ ok: true, ...cohorts });
  } catch (error) {
    console.error("[admin/metrics/cohorts] error", error);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;
