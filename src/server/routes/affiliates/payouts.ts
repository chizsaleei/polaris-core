// polaris-core/src/server/routes/affiliates/payouts.ts

import { Router, type Request, type Response, type NextFunction } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../lib/supabase";
import { log } from "../../../lib/logger";
import {
  normalizeCurrencyCode,
  resolveProfileCurrency,
  type Currency,
} from "../../../lib/payments";

const router = Router();
const supabase = createClient();

type AffiliatePayoutStatus = "pending" | "approved" | "paid" | "canceled";

interface AffiliatePayoutRow {
  id: string | number;
  affiliate_id: string;
  amount_minor: number;
  currency: string;
  status: AffiliatePayoutStatus;
  tx_ref: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  created_by?: string | null;
  paid_by?: string | null;
}

interface AffiliateEventRow {
  id: string | number;
  affiliate_id: string;
  code: string | null;
  event_type: string;
  amount_minor: number | null;
  currency: string | null;
  payout_id: string | number | null;
  status: string | null;
  created_at: string;
  updated_at?: string | null;
}

interface PayoutPreviewBody {
  affiliateId?: unknown;
  since?: unknown;
  until?: unknown;
}

interface PayoutCreateBody {
  affiliateId?: unknown;
  amountMinor?: unknown;
  currency?: unknown;
  notes?: unknown;
  eventIds?: unknown;
}

interface MarkPaidBody {
  txRef?: unknown;
  notes?: unknown;
}

type AdminRequest = Request<ParamsDictionary>;
type RequestWithBody<TBody> = Request<ParamsDictionary, any, TBody>;
type AsyncRoute<Req extends Request = Request> = (req: Req, res: Response) => Promise<void>;

function asyncHandler<Req extends Request = Request>(fn: AsyncRoute<Req>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req as Req, res).catch(next);
  };
}

/**
 * Polaris Core - Affiliate payouts admin API
 *
 * Routes (all require admin):
 *   GET    /affiliates/payouts
 *   POST   /affiliates/payouts/preview
 *   POST   /affiliates/payouts/create
 *   POST   /affiliates/payouts/:id/mark-paid
 */

router.get(
  "/",
  asyncHandler(async (req: AdminRequest, res: Response) => {
    const uid = getUserId(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
    const status = normalizeStatus(statusParam);

    const affiliateIdParam =
      typeof req.query.affiliateId === "string" ? req.query.affiliateId : undefined;
    const affiliateId = safeId(affiliateIdParam);

    const limit = clampLimit(req.query.limit, 50, 200);

    const table = await ensurePayoutTable();
    if (!table) {
      res.status(404).json({ error: "payouts_table_not_found" });
      return;
    }

    let query = supabase.from(table).select("*").order("created_at", { ascending: false }).limit(limit);

    if (status) query = query.eq("status", status);
    if (affiliateId) query = query.eq("affiliate_id", affiliateId);

    const { data, error } = await query;
    if (error) {
      log.error("[affiliates/payouts] list failed", { err: error.message });
      res
        .status(500)
        .json({ error: "query_failed", detail: safeMsg(error.message) });
      return;
    }

    const payouts = (data ?? []) as AffiliatePayoutRow[];
    res.status(200).json({ ok: true, payouts });
  }),
);

router.post(
  "/preview",
  asyncHandler<RequestWithBody<PayoutPreviewBody>>(async (req, res) => {
    const uid = getUserId(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body = req.body ?? {};
    const affiliateId = safeId(typeof body.affiliateId === "string" ? body.affiliateId : undefined);
    if (!affiliateId) {
      res.status(400).json({ error: "missing_affiliateId" });
      return;
    }

    const since = parseDate(body.since);
    const until = parseDate(body.until);

    const evTable = await ensureEventsTable();
    if (!evTable) {
      res.status(404).json({ error: "events_table_not_found" });
      return;
    }

    let q = supabase
      .from(evTable)
      .select("id, event_type, amount_minor, currency, payout_id, status, created_at")
      .eq("affiliate_id", affiliateId);

    if (since) q = q.gte("created_at", since);
    if (until) q = q.lte("created_at", until);

    const { data, error } = await q;
    if (error) {
      log.error("[affiliates/payouts] preview failed", { err: error.message });
      res
        .status(500)
        .json({ error: "preview_failed", detail: safeMsg(error.message) });
      return;
    }

    const rows: AffiliateEventRow[] = Array.isArray(data) ? (data as AffiliateEventRow[]) : [];
    const eligible = rows.filter((r) => {
      const type = String(r.event_type || "").toLowerCase();
      const settled = r.payout_id != null || String(r.status || "").toLowerCase() === "paid";
      return !settled && (type === "qualified" || type === "commission_earned");
    });

    const affiliateCurrency = await fetchAffiliateCurrency(affiliateId);
    const currency = pickCurrency(eligible, affiliateCurrency);

    const totalMinor = eligible.reduce((sum, r) => {
      const n = typeof r.amount_minor === "number" ? r.amount_minor : Number(r.amount_minor);
      return Number.isFinite(n) ? sum + n : sum;
    }, 0);

    res.status(200).json({
      ok: true,
      affiliateId,
      since,
      until,
      currency,
      totalMinor,
      eventCount: eligible.length,
      eventIds: eligible.map((r) => r.id),
    });
  }),
);

router.post(
  "/create",
  asyncHandler<RequestWithBody<PayoutCreateBody>>(async (req, res) => {
    const uid = getUserId(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const body = req.body ?? {};
    const affiliateId = safeId(typeof body.affiliateId === "string" ? body.affiliateId : undefined);
    const amountMinorRaw = body.amountMinor;
    const amountMinor =
      typeof amountMinorRaw === "number" ? amountMinorRaw : Number(amountMinorRaw);
    const requestedCurrency = safeCurrency(body.currency);
    const notes = safeNotes(body.notes);
    const eventIds: Array<string | number> = Array.isArray(body.eventIds)
      ? body.eventIds.map((v) => String(v))
      : [];

    if (!affiliateId || !Number.isFinite(amountMinor)) {
      res.status(400).json({ error: "missing_fields" });
      return;
    }

    const defaultCurrency = await fetchAffiliateCurrency(affiliateId);
    const currency = requestedCurrency ?? defaultCurrency;

    const table = await ensurePayoutTable();
    if (!table) {
      res.status(404).json({ error: "payouts_table_not_found" });
      return;
    }

    const nowIso = new Date().toISOString();

    const insertPayload: Partial<AffiliatePayoutRow> = {
      affiliate_id: affiliateId,
      amount_minor: Math.round(amountMinor),
      currency,
      status: "pending",
      notes,
      created_by: uid || null,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const insertResult = await supabase
      .from(table)
      .insert(insertPayload)
      .select("*")
      .maybeSingle();

    if (insertResult.error || !insertResult.data) {
      log.error("[affiliates/payouts] create failed", { err: insertResult.error?.message });
      res
        .status(500)
        .json({ error: "create_failed", detail: safeMsg(insertResult.error?.message) });
      return;
    }

    const payout = asAffiliatePayoutRow(insertResult.data);
    if (!payout) {
      log.error("[affiliates/payouts] create returned invalid shape");
      res.status(500).json({ error: "invalid_payout_record" });
      return;
    }

    if (eventIds.length) {
      const evTable = await ensureEventsTable();
      if (evTable) {
        const payoutIdValue =
          payout.id ?? (payout as { payout_id?: string | number | null }).payout_id ?? null;

        await supabase
          .from(evTable)
          .update({ payout_id: payoutIdValue, updated_at: nowIso })
          .in("id", eventIds)
          .is("payout_id", null);
      }
    }

    res.status(201).json({ ok: true, payout });
  }),
);

router.post(
  "/:id/mark-paid",
  asyncHandler<RequestWithBody<MarkPaidBody>>(async (req, res) => {
    const uid = getUserId(req);
    if (!(await isAdminUser(uid))) {
      res.status(403).json({ error: "forbidden" });
      return;
    }

    const id = String(req.params.id || "").trim();
    if (!id) {
      res.status(400).json({ error: "missing_id" });
      return;
    }

    const body = req.body ?? {};
    const txRef = typeof body.txRef === "string" ? body.txRef.slice(0, 255) : null;
    const notes = safeNotes(body.notes);

    const table = await ensurePayoutTable();
    if (!table) {
      res.status(404).json({ error: "payouts_table_not_found" });
      return;
    }

    const nowIso = new Date().toISOString();
    const updatePayload: Partial<AffiliatePayoutRow> = {
      status: "paid",
      tx_ref: txRef,
      notes: notes || null,
      paid_at: nowIso,
      updated_at: nowIso,
      paid_by: uid || null,
    };

    const updateResult = await supabase
      .from(table)
      .update(updatePayload)
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (updateResult.error || !updateResult.data) {
      log.error("[affiliates/payouts] mark-paid failed", { err: updateResult.error?.message });
      res
        .status(500)
        .json({ error: "update_failed", detail: safeMsg(updateResult.error?.message) });
      return;
    }

    const payout = asAffiliatePayoutRow(updateResult.data);
    if (!payout) {
      res.status(500).json({ error: "invalid_payout_record" });
      return;
    }

    res.status(200).json({ ok: true, payout });
  }),
);

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getUserId(req: Request): string | undefined {
  const fromCtx = req.user?.userId;
  const fromHeader = req.header("x-user-id");
  return fromCtx || (fromHeader ? String(fromHeader) : undefined);
}

async function isAdminUser(userId?: string): Promise<boolean> {
  if (!userId) return false;

  const allow = String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.includes(userId)) return true;

  try {
    const rpc = await supabase.rpc("is_admin", { p_user_id: userId }).single();
    if (!rpc.error) {
      if (rpc.data === true) return true;
      const adminRow = asProfileAdminRow(rpc.data);
      if (adminRow?.is_admin) return true;
    }
  } catch {
    // ignore
  }

  try {
    const { data } = await supabase
      .from("profiles")
      .select("is_admin")
      .eq("id", userId)
      .maybeSingle();
    const adminRow = asProfileAdminRow(data);
    if (adminRow?.is_admin) return true;
  } catch {
    // ignore
  }

  return false;
}

async function ensurePayoutTable(): Promise<string | null> {
  const candidates = ["affiliate_payouts", "affiliates_payouts", "payouts_affiliates"];
  for (const table of candidates) {
    try {
      const { error } = await supabase.from(table).select("*", { head: true, count: "exact" }).limit(0);
      if (!error) return table;
    } catch {
      // continue
    }
  }
  return null;
}

async function ensureEventsTable(): Promise<string | null> {
  const candidates = ["affiliate_events", "affiliates_events"];
  for (const table of candidates) {
    try {
      const { error } = await supabase.from(table).select("*", { head: true, count: "exact" }).limit(0);
      if (!error) return table;
    } catch {
      // continue
    }
  }
  return null;
}

function normalizeStatus(s?: string): AffiliatePayoutStatus | null {
  if (!s) return null;
  const key = s.toLowerCase();
  if (key === "pending" || key === "approved" || key === "paid" || key === "canceled") {
    return key as AffiliatePayoutStatus;
  }
  return null;
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.round(n)));
}

function safeId(v?: string): string | null {
  if (!v) return null;
  const s = v.trim();
  return s.length ? s : null;
}

function safeCurrency(v: unknown): Currency | null {
  if (!v || typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(s)) return null;
  return normalizeCurrencyCode(s);
}

function safeNotes(v: unknown): string | null {
  if (!v || typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed.slice(0, 2000) : null;
}
function pickCurrency(events: AffiliateEventRow[], fallback: Currency): Currency {
  for (const row of events) {
    if (typeof row.currency === "string" && row.currency) {
      const normalized = safeCurrency(row.currency);
      if (normalized) return normalized;
    }
  }
  return fallback;
}

function asAffiliatePayoutRow(value: unknown): AffiliatePayoutRow | null {
  if (!isRecord(value)) return null;
  const {
    id,
    affiliate_id: affiliateId,
    amount_minor: amountMinor,
    currency,
    status,
    tx_ref: txRef,
    notes,
    created_at: createdAt,
    updated_at: updatedAt,
    paid_at: paidAt,
    created_by: createdBy,
    paid_by: paidBy,
  } = value;

  if (
    (typeof id !== "string" && typeof id !== "number") ||
    typeof affiliateId !== "string" ||
    typeof amountMinor !== "number" ||
    typeof currency !== "string" ||
    typeof status !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id,
    affiliate_id: affiliateId,
    amount_minor: amountMinor,
    currency,
    status: normalizeStatus(status) ?? "pending",
    tx_ref: typeof txRef === "string" ? txRef : null,
    notes: typeof notes === "string" ? notes : null,
    created_at: createdAt,
    updated_at: updatedAt,
    paid_at: typeof paidAt === "string" ? paidAt : null,
    created_by: typeof createdBy === "string" ? createdBy : null,
    paid_by: typeof paidBy === "string" ? paidBy : null,
  };
}

function parseDate(v: unknown): string | null {
  if (!v || typeof v !== "string") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function safeMsg(msg?: string) {
  return String(msg || "").replace(/\s+/g, " ").slice(0, 200);
}

async function fetchAffiliateCurrency(affiliateId: string): Promise<Currency> {
  try {
    const { data } = await supabase
      .from("profiles")
      .select("currency_code, country_code")
      .eq("id", affiliateId)
      .maybeSingle();

    const row = asProfileCurrencyRow(data);

    return resolveProfileCurrency({
      currency_code: row?.currency_code ?? null,
      country_code: row?.country_code ?? null,
    });
  } catch (error) {
    log.warn("fetchAffiliateCurrency failed", { affiliateId, err: (error as Error).message });
    return resolveProfileCurrency();
  }
}

function asProfileAdminRow(value: unknown): AdminProfileRow | null {
  if (!isRecord(value)) return null;
  const { is_admin: isAdmin } = value;
  if (isAdmin === null || typeof isAdmin === "boolean") {
    return { is_admin: isAdmin ?? null };
  }
  return null;
}

function asProfileCurrencyRow(
  value: unknown,
): { currency_code: string | null; country_code: string | null } | null {
  if (!isRecord(value)) return null;
  const { currency_code: currencyCode, country_code: countryCode } = value;
  const safeCurrency =
    currencyCode === null || typeof currencyCode === "string" ? currencyCode : null;
  const safeCountry =
    countryCode === null || typeof countryCode === "string" ? countryCode : null;
  return { currency_code: safeCurrency, country_code: safeCountry };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface AdminProfileRow {
  is_admin: boolean | null;
}
