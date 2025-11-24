// src/server/routes/admin/audit.ts

import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../lib/supabase";
import { ENV, allowedOrigins, mask } from "../../../config/env";

const router = Router();
const supabase = createClient();

// -----------------------------------------------------------------------------
// Shared types for API <-> UI
// -----------------------------------------------------------------------------

export const AUDIT_TABLES = [
  "profiles",
  "sessions",
  "attempts",
  "practice_packs",
  "vocabulary",
  "key_expressions",
  "assignments",
  "entitlements",
  "payments_events",
  "daily_usage",
  "tickets",
  "notifications",
  "reconciliation_jobs",
] as const;

export type AuditTableName = (typeof AUDIT_TABLES)[number];

export interface AuditCountEntry {
  count: number;
  ok: boolean;
  error?: string;
}

export type AuditCounts = Record<AuditTableName, AuditCountEntry>;

export interface PaymentEventRow {
  id: string;
  provider: string | null;
  status: string | null;
  provider_ref: string | null;
  plan: string | null;
  user_id: string | null;
  amount_minor: number | null;
  currency: string | null;
  created_at: string;
}

export interface PaymentEventSummaryRow {
  provider: string | null;
  status: string | null;
  created_at: string;
}

export interface PaymentStatsLast24h {
  since: string;
  groups: Record<string, number>;
}

export interface AdminAuditSummaryMeta {
  appVersion: string;
  node: string;
  env: string;
  providers: string | string[] | undefined;
  time: string;
}

export interface AdminAuditSummaryResponse {
  ok: true;
  meta: AdminAuditSummaryMeta;
  db: AuditCounts;
  payments: {
    recent: PaymentEventRow[];
    last24h: PaymentStatsLast24h;
  };
}

export interface AdminAuditChecksConfig {
  vercelEnv: string | undefined;
  isProd: boolean;
  appBaseUrl: string | undefined;
  corsOrigins: string[];
  billingProviders: string | string[] | undefined;
  supabaseUrl: string | undefined;
  keys: {
    supabaseService: string;
    paymongoPublic: string;
    paymongoSecret: string;
    paypalClientId: string;
    paypalMode: string | undefined;
    kvUrl: string;
    redisUrl: string;
    openaiKey: string;
  };
}

export interface AdminAuditChecksRuntime {
  uptimeSec: number;
  memory: NodeJS.MemoryUsage;
}

export interface AdminAuditChecksResponse {
  ok: true;
  config: AdminAuditChecksConfig;
  db: AuditCounts;
  runtime: AdminAuditChecksRuntime;
  time: string;
}

export interface AdminAuditPaymentsResponse {
  ok: true;
  recent: PaymentEventRow[];
  last24h: PaymentStatsLast24h;
}

export interface SafeCountResult {
  table: AuditTableName;
  count: number;
  error?: string;
}

export interface ReconciliationJobRow {
  id: string;
  status: string;
  created_at: string;
  scheduled_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface AdminAuditCronSnapshot {
  queued: SafeCountResult;
  running: SafeCountResult;
  failed: SafeCountResult;
  succeeded: SafeCountResult;
  latest: ReconciliationJobRow[];
}

export interface AdminAuditCronResponse {
  ok: true;
  cron: AdminAuditCronSnapshot;
}

export type AdminAuditReconcileResponse =
  | { ok: true }
  | { ok: false; error: string };

export interface AdminErrorResponse {
  error: string;
}

// -----------------------------------------------------------------------------
// Auth helpers
// -----------------------------------------------------------------------------

interface AuthUserShape {
  id?: unknown;
  userId?: unknown;
}

type AdminRequest = Request<ParamsDictionary>;
type RequestWithUser = AdminRequest & { user?: AuthUserShape };

export function getUserIdFromRequest(req: AdminRequest): string | null {
  const r = req as RequestWithUser;
  const u = r.user;
  if (u) {
    if (typeof u.id === "string") return u.id;
    if (typeof u.userId === "string") return u.userId;
  }
  const headerId = req.header("x-user-id");
  if (headerId && headerId.trim()) return headerId.trim();
  return null;
}

// -----------------------------------------------------------------------------
// Admin guard
// -----------------------------------------------------------------------------

interface ProfileAdminRow {
  is_admin: boolean | null;
}

async function isAdminUser(userId?: string | null): Promise<boolean> {
  if (!userId) return false;

  const envList = String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (envList.includes(userId)) return true;

  try {
    // RPC may return a plain boolean, or a record; we only care if it is truthy
    const rpc = await supabase
      .rpc("is_admin", { p_user_id: userId })
      .single();

    if (!rpc.error) {
      if (typeof rpc.data === "boolean" && rpc.data) return true;
      const rpcRow = asProfileAdminRow(rpc.data);
      if (rpcRow?.is_admin) return true;
    }
  } catch {
    // ignore rpc failures, fall through to profile flag
  }

  try {
    const prof = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("user_id", userId)
      .maybeSingle();

    const row = asProfileAdminRow(prof.data);
    if (row?.is_admin) return true;
  } catch {
    // ignore
  }

  return false;
}

async function adminGuard(
  req: AdminRequest,
  res: Response<AdminErrorResponse>,
  next: NextFunction,
): Promise<void> {
  try {
    const uid = getUserIdFromRequest(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  } catch (e: unknown) {
    console.error("[admin/audit] guard error", e);
    res.status(500).json({ error: "internal_error" });
  }
}

// Use a non async wrapper to satisfy no-misused-promises
router.use((req, res, next) => {
  void adminGuard(req, res, next);
});

// -----------------------------------------------------------------------------
// Route handlers
// -----------------------------------------------------------------------------

async function handleAuditSummary(
  _req: AdminRequest,
  res: Response<AdminAuditSummaryResponse | AdminErrorResponse>,
): Promise<void> {
  try {
    const [counts, recent, payments24h] = await Promise.all([
      collectCounts(),
      latestPaymentEvents(20),
      paymentStatsLast24h(),
    ]);

    res.status(200).json({
      ok: true,
      meta: {
        appVersion: ENV.APP_VERSION,
        node: process.versions.node,
        env: ENV.VERCEL_ENV,
        providers: ENV.BILLING_PROVIDER,
        time: new Date().toISOString(),
      },
      db: counts,
      payments: {
        recent,
        last24h: payments24h,
      },
    });
  } catch (e: unknown) {
    console.error("[admin/audit] summary error", e);
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * GET /admin/audit
 */
router.get("/", (req: AdminRequest, res) => {
  void handleAuditSummary(req, res);
});

async function handleAuditChecks(
  _req: AdminRequest,
  res: Response<AdminAuditChecksResponse | AdminErrorResponse>,
): Promise<void> {
  try {
    const counts = await collectCounts();
    const origins = allowedOrigins();

    res.status(200).json({
      ok: true,
      config: {
        vercelEnv: ENV.VERCEL_ENV,
        isProd: ENV.isProd,
        appBaseUrl: ENV.APP_BASE_URL,
        corsOrigins: origins,
        billingProviders: ENV.BILLING_PROVIDER,
        supabaseUrl: ENV.SUPABASE_URL,
        keys: {
          supabaseService: mask(ENV.SUPABASE_SERVICE_ROLE_KEY),
          paymongoPublic: mask(ENV.PAYMONGO_PUBLIC_KEY),
          paymongoSecret: mask(ENV.PAYMONGO_SECRET_KEY),
          paypalClientId: mask(ENV.PAYPAL_CLIENT_ID),
          paypalMode: ENV.PAYPAL_MODE,
          kvUrl: ENV.POLARIS_REST_API_KV_URL ? "[set]" : "",
          redisUrl: ENV.POLARIS_REST_API_REDIS_URL ? "[set]" : "",
          openaiKey: mask(process.env.OPENAI_API_KEY || ""),
        },
      },
      db: counts,
      runtime: {
        uptimeSec: Math.round(process.uptime()),
        memory: process.memoryUsage(),
      },
      time: new Date().toISOString(),
    });
  } catch (e: unknown) {
    console.error("[admin/audit/checks] error", e);
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * GET /admin/audit/checks
 */
router.get("/checks", (req: AdminRequest, res) => {
  void handleAuditChecks(req, res);
});

async function handleAuditPayments(
  _req: AdminRequest,
  res: Response<AdminAuditPaymentsResponse | AdminErrorResponse>,
): Promise<void> {
  try {
    const [recent, last24h] = await Promise.all([
      latestPaymentEvents(50),
      paymentStatsLast24h(),
    ]);
    res.status(200).json({ ok: true, recent, last24h });
  } catch (e: unknown) {
    console.error("[admin/audit/payments] error", e);
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * GET /admin/audit/payments
 */
router.get("/payments", (req: AdminRequest, res) => {
  void handleAuditPayments(req, res);
});

async function handleAuditReconcile(
  _req: AdminRequest,
  res: Response<AdminAuditReconcileResponse | AdminErrorResponse>,
): Promise<void> {
  try {
    const { error } = await supabase
      .from("reconciliation_jobs")
      .insert({
        status: "queued",
        source: "manual",
        scheduled_at: new Date().toISOString(),
      });

    if (error) {
      res.status(400).json({ ok: false, error: error.message });
      return;
    }

    res.status(202).json({ ok: true });
  } catch (e: unknown) {
    console.error("[admin/audit/reconcile] error", e);
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * POST /admin/audit/reconcile
 */
router.post("/reconcile", (req: AdminRequest, res) => {
  void handleAuditReconcile(req, res);
});

async function handleAuditCron(
  _req: AdminRequest,
  res: Response<AdminAuditCronResponse | AdminErrorResponse>,
): Promise<void> {
  try {
    const cron: AdminAuditCronSnapshot = {
      queued: await safeCount("reconciliation_jobs", ["status", "queued"]),
      running: await safeCount("reconciliation_jobs", ["status", "running"]),
      failed: await safeCount("reconciliation_jobs", ["status", "failed"]),
      succeeded: await safeCount("reconciliation_jobs", [
        "status",
        "succeeded",
      ]),
      latest: [],
    };

    const latest = await supabase
      .from("reconciliation_jobs")
      .select(
        "id,status,created_at,scheduled_at,started_at,finished_at,error",
      )
      .order("created_at", { ascending: false })
      .limit(20);

    cron.latest = latest.error ? [] : asReconciliationJobRows(latest.data);

    res.status(200).json({ ok: true, cron });
  } catch (e: unknown) {
    console.error("[admin/audit/cron] error", e);
    res.status(500).json({ error: "internal_error" });
  }
}

/**
 * GET /admin/audit/cron
 */
router.get("/cron", (req: AdminRequest, res) => {
  void handleAuditCron(req, res);
});

export const adminAuditRouter = router;
export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export async function collectCounts(): Promise<AuditCounts> {
  const out = {} as AuditCounts;

  await Promise.all(
    AUDIT_TABLES.map(async (name) => {
      const { count, error } = await supabase
        .from(name)
        .select("*", { count: "exact", head: true });

      if (error) {
        const missing = /42P01|relation .* does not exist/i.test(
          error.message,
        );
        out[name] = {
          count: 0,
          ok: missing ? true : false,
          error: missing ? "table_missing" : error.message,
        };
      } else {
        out[name] = { count: count || 0, ok: true };
      }
    }),
  );

  return out;
}

export async function latestPaymentEvents(
  limit = 20,
): Promise<PaymentEventRow[]> {
  const sel = await supabase
    .from("payments_events")
    .select(
      "id,provider,status,provider_ref,plan,user_id,amount_minor,currency,created_at",
    )
    .order("created_at", { ascending: false })
    .limit(limit);

  if (sel.error) return [];
  return asPaymentEventRows(sel.data);
}

export async function paymentStatsLast24h(): Promise<PaymentStatsLast24h> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const sel = await supabase
    .from("payments_events")
    .select("provider,status,created_at", { count: "exact" })
    .gte("created_at", since);

  if (sel.error) {
    return { since, groups: {} };
  }

  const groups: Record<string, number> = {};
  const rows = asPaymentEventSummaryRows(sel.data);
  for (const r of rows) {
    const provider = typeof r.provider === "string" ? r.provider : "unknown";
    const status = typeof r.status === "string" ? r.status : "unknown";
    const key = `${provider}:${status}`;
    groups[key] = (groups[key] || 0) + 1;
  }

  return { since, groups };
}

export async function safeCount(
  table: AuditTableName,
  eq?: [column: string, value: string],
): Promise<SafeCountResult> {
  try {
    let query = supabase
      .from(table)
      .select("*", { count: "exact", head: true });

    if (eq) {
      query = query.eq(eq[0], eq[1]);
    }

    const { count, error } = await query;

    if (error) {
      return { table, count: 0, error: error.message };
    }

    return { table, count: count || 0 };
  } catch (e: unknown) {
    return { table, count: 0, error: extractErrorMessage(e) };
  }
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

function asProfileAdminRow(value: unknown): ProfileAdminRow | null {
  if (!isRecord(value)) return null;
  const { is_admin: isAdmin } = value;
  if (isAdmin === null || typeof isAdmin === "boolean") {
    return { is_admin: isAdmin ?? null };
  }
  return null;
}

function asReconciliationJobRows(
  value: unknown,
): ReconciliationJobRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isReconciliationJobRow);
}

function asPaymentEventRows(value: unknown): PaymentEventRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPaymentEventRow);
}

function asPaymentEventSummaryRows(
  value: unknown,
): PaymentEventSummaryRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPaymentEventSummaryRow);
}

function isReconciliationJobRow(
  value: unknown,
): value is ReconciliationJobRow {
  if (!isRecord(value)) return false;
  const {
    id,
    status,
    created_at: createdAt,
    scheduled_at: scheduledAt,
    started_at: startedAt,
    finished_at: finishedAt,
    error,
  } = value;
  return (
    typeof id === "string" &&
    typeof status === "string" &&
    typeof createdAt === "string" &&
    isNullableString(scheduledAt) &&
    isNullableString(startedAt) &&
    isNullableString(finishedAt) &&
    isNullableString(error)
  );
}

function isPaymentEventRow(value: unknown): value is PaymentEventRow {
  if (!isRecord(value)) return false;
  const {
    id,
    provider,
    status,
    provider_ref: providerRef,
    plan,
    user_id: userId,
    amount_minor: amountMinor,
    currency,
    created_at: createdAt,
  } = value;
  return (
    typeof id === "string" &&
    isNullableString(provider) &&
    isNullableString(status) &&
    isNullableString(providerRef) &&
    isNullableString(plan) &&
    isNullableString(userId) &&
    (typeof amountMinor === "number" || amountMinor === null) &&
    isNullableString(currency) &&
    typeof createdAt === "string"
  );
}

function isPaymentEventSummaryRow(
  value: unknown,
): value is PaymentEventSummaryRow {
  if (!isRecord(value)) return false;
  const { provider, status, created_at: createdAt } = value;
  return (
    typeof createdAt === "string" &&
    isNullableString(provider) &&
    isNullableString(status)
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
