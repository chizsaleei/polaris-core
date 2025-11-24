// src/server/routes/affiliates/qualify.ts
import type { Request, Response } from "express";
import { Router } from "express";
import type { ParamsDictionary } from "express-serve-static-core";

import { PLAN_KEYS, type PlanKey } from "../../../lib/constants";
import {
  computeCommission,
  defaultCommissionPolicy,
  type PaymentEventLike,
} from "../../../lib/commission";
import { normalizeCurrencyCode, type Currency } from "../../../lib/payments/currency";
import { createClient } from "../../../lib/supabase";

const router = Router();
const supabase = createClient();
const commissionPolicy = defaultCommissionPolicy();
const planKeySet = new Set<PlanKey>(Object.values(PLAN_KEYS) as PlanKey[]);

type JsonRecord = Record<string, unknown>;

type QualifyRequestBody = {
  userId?: string;
  amountMinor?: number | string;
  currency?: string;
  plan?: string | null;
  reference?: string | null;
  provider?: string | null;
  affiliateId?: string | number;
  affiliateCode?: string;
};

type QualifyRequest = Request<ParamsDictionary, Record<string, unknown>, QualifyRequestBody>;
type QualifyResponse = Response<Record<string, unknown>>;

interface AffiliateInfo {
  id: string;
  code?: string | null;
}

type ReferralStatus = "pending" | "clicked" | "qualified";

interface AffiliateReferralRow {
  id: string;
  user_id: string;
  affiliate_id: string;
  affiliate_code: string | null;
  status: ReferralStatus;
  created_at: string;
  updated_at: string;
  qualified_at?: string | null;
  last_payment_ref?: string | null;
}

interface AffiliateEventBase {
  affiliate_id: string;
  affiliate_code: string | null;
  user_id: string;
  reference: string | null;
  provider: string | null;
  plan: string | null;
  currency: string;
  created_at: string;
  updated_at: string;
}

interface EventIdRow {
  id: string;
}

type ReferralUpdatePayload = Pick<
  AffiliateReferralRow,
  "status" | "qualified_at" | "last_payment_ref" | "updated_at"
>;
type ReferralInsertPayload = Pick<
  AffiliateReferralRow,
  "user_id" | "affiliate_id" | "status" | "qualified_at" | "last_payment_ref" | "created_at" | "updated_at"
>;

router.post("/", (req, res) => {
  void handleQualifyRoute(req, res);
});

const handleQualifyRoute = async (req: QualifyRequest, res: QualifyResponse) => {
  try {
    const {
      userId,
      amountMinor,
      currency,
      plan,
      reference,
      provider,
      affiliateId: bodyAffiliateId,
      affiliateCode,
    } = req.body ?? {};

    const parsedAmountMinor = Number(amountMinor);

    if (!userId || !Number.isFinite(parsedAmountMinor) || !currency) {
      res.status(400).json({ error: "missing_fields" });
      return;
    }

    // Idempotency
    if (reference) {
      const evTable = await ensureEventsTable();
      if (evTable) {
        const { data: dup, error: dupErr } = await supabase
          .from(evTable)
          .select("id")
          .eq("user_id", userId)
          .eq("reference", reference)
          .eq("event_type", "commission_earned")
          .limit(1)
          .maybeSingle<EventIdRow>();
        if (!dupErr && dup) {
          res.status(200).json({
            ok: true,
            idempotent: true,
            reason: "already_recorded",
            eventId: dup.id,
          });
          return;
        }
      }
    }

    // Resolve affiliate
    const affiliate =
      (await resolveAffiliateFromBody(bodyAffiliateId, affiliateCode)) ??
      (await resolveAffiliateFromReferral(userId));

    if (!affiliate) {
      res.status(200).json({ ok: false, reason: "no_affiliate" });
      return;
    }

    // Mark referral qualified if applicable
    const referral = await qualifyReferralRow(userId, affiliate.id, reference);

    // Compute commission
    const grossMinor = Math.round(parsedAmountMinor);
    const nowIso = new Date().toISOString();
    const currencyCode: Currency = normalizeCurrencyCode(currency);
    const planKey = normalizePlanKey(plan);
    const providerEventId = reference ?? `qualify-${userId}-${Date.now()}`;
    const paymentEvent: PaymentEventLike = {
      provider: provider ?? "manual",
      provider_event_id: providerEventId,
      user_id: userId,
      plan_key: planKey,
      amount_cents: grossMinor,
      currency: currencyCode,
      status: "succeeded",
      created_at: nowIso,
      affiliate_code: affiliate.code ?? null,
      is_first_paid: true,
    };

    const commissionResult = computeCommission({
      payment: paymentEvent,
      policy: commissionPolicy,
      idempotency_key: reference ?? undefined,
    });

    const commissionMinor = commissionResult.commission_cents;
    const rate = commissionResult.rate_bps;
    const rule = commissionResult.rate_source;

    // Write events
    const eventsTable = await ensureEventsTable();
    if (!eventsTable) {
      res.status(500).json({ error: "events_table_missing" });
      return;
    }

    const baseEvent: AffiliateEventBase = {
      affiliate_id: affiliate.id,
      affiliate_code: affiliate.code ?? null,
      user_id: userId,
      reference: reference ?? null,
      provider: provider ?? null,
      plan: plan ?? null,
      currency: currencyCode,
      created_at: nowIso,
      updated_at: nowIso,
    };

    // qualified
    const { data: qEv, error: qErr } = await supabase
      .from(eventsTable)
      .insert({
        ...baseEvent,
        event_type: "qualified",
        amount_minor: grossMinor,
        meta: {
          source: "qualify_api",
          referral_id: referral?.id ?? null,
        } satisfies JsonRecord,
      })
      .select("id")
      .maybeSingle<EventIdRow>();

    if (qErr) {
      res
        .status(500)
        .json({ error: "event_insert_failed", detail: safeMsg(qErr.message) });
      return;
    }

    // commission_earned
    const { data: cEv, error: cErr } = await supabase
      .from(eventsTable)
      .insert({
        ...baseEvent,
        event_type: "commission_earned",
        amount_minor: commissionMinor,
        meta: {
          source: "qualify_api",
          calc: { rate, rule, grossMinor },
          referral_id: referral?.id ?? null,
        } satisfies JsonRecord,
      })
      .select("id")
      .maybeSingle<EventIdRow>();

    if (cErr) {
      res
        .status(500)
        .json({ error: "commission_insert_failed", detail: safeMsg(cErr.message) });
      return;
    }

    res.status(200).json({
      ok: true,
      affiliate: { id: affiliate.id, code: affiliate.code ?? null },
      referralId: referral?.id ?? null,
      events: { qualifiedId: qEv?.id ?? null, commissionId: cEv?.id ?? null },
      commissionMinor,
      currency: currencyCode,
      rate,
      rule,
    });
  } catch (err) {
    console.error("[affiliates/qualify] error", err);
    res.status(500).json({ error: "internal_error" });
  }
};

export default router;

// -----------------------------------------------------------------------------
// Resolution helpers
// -----------------------------------------------------------------------------

async function resolveAffiliateFromBody(
  affiliateId?: string | number,
  affiliateCode?: string,
): Promise<AffiliateInfo | null> {
  if (affiliateId) return { id: String(affiliateId), code: null };

  if (affiliateCode) {
    const table = await ensureAffiliatesTable();
    if (!table) return null;
    const { data, error } = await supabase
      .from(table)
      .select("id, code")
      .eq("code", affiliateCode)
      .limit(1)
      .maybeSingle<{ id: string; code: string | null }>();
    if (!error && data) return { id: data.id, code: data.code };
  }
  return null;
}

async function resolveAffiliateFromReferral(userId: string): Promise<AffiliateInfo | null> {
  const refTable = await ensureReferralsTable();
  if (!refTable) return null;

  const { data, error } = await supabase
    .from(refTable)
    .select("id, affiliate_id, affiliate_code, status, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<AffiliateReferralRow>();

  if (error || !data) return null;
  return {
    id: data.affiliate_id,
    code: data.affiliate_code ?? undefined,
  };
}

async function qualifyReferralRow(
  userId: string,
  affiliateId: string,
  reference?: string | null,
): Promise<AffiliateReferralRow | null> {
  const refTable = await ensureReferralsTable();
  if (!refTable) return null;

  const { data: pending } = await supabase
    .from(refTable)
    .select("*")
    .eq("user_id", userId)
    .eq("affiliate_id", affiliateId)
    .in("status", ["pending", "clicked"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<AffiliateReferralRow>();

  const nowIso = new Date().toISOString();

  if (pending) {
    const updatePayload: ReferralUpdatePayload = {
      status: "qualified",
      qualified_at: nowIso,
      last_payment_ref: reference ?? null,
      updated_at: nowIso,
    };
    const { data, error } = await supabase
      .from(refTable)
      .update(updatePayload)
      .eq("id", pending.id)
      .select("*")
      .maybeSingle<AffiliateReferralRow>();
    return error ? null : data;
  }

  const insertPayload: ReferralInsertPayload = {
    user_id: userId,
    affiliate_id: affiliateId,
    status: "qualified",
    qualified_at: nowIso,
    last_payment_ref: reference ?? null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  const { data, error } = await supabase
    .from(refTable)
    .insert(insertPayload)
    .select("*")
    .maybeSingle<AffiliateReferralRow>();

  return error ? null : data;
}

// -----------------------------------------------------------------------------
// Table discovery helpers
// -----------------------------------------------------------------------------

async function ensureEventsTable(): Promise<string | null> {
  const candidates = ["affiliate_events", "affiliates_events"];
  for (const t of candidates) {
    try {
      const { error } = await supabase
        .from(t)
        .select("*", { head: true, count: "exact" })
        .limit(0);
      if (!error) return t;
    } catch {
      // continue
    }
  }
  return null;
}

async function ensureReferralsTable(): Promise<string | null> {
  const candidates = ["affiliate_referrals", "affiliates_referrals", "referrals_affiliates"];
  for (const t of candidates) {
    try {
      const { error } = await supabase
        .from(t)
        .select("*", { head: true, count: "exact" })
        .limit(0);
      if (!error) return t;
    } catch {
      // continue
    }
  }
  return null;
}

async function ensureAffiliatesTable(): Promise<string | null> {
  const candidates = ["affiliates", "affiliate_accounts"];
  for (const t of candidates) {
    try {
      const { error } = await supabase
        .from(t)
        .select("*", { head: true, count: "exact" })
        .limit(0);
      if (!error) return t;
    } catch {
      // continue
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Misc utils
// -----------------------------------------------------------------------------

function safeMsg(msg?: string) {
  return String(msg || "").replace(/\s+/g, " ").slice(0, 200);
}

function normalizePlanKey(plan?: string | null): PlanKey {
  if (!plan) return PLAN_KEYS.PRO_MONTHLY;
  const normalized = plan.trim().toLowerCase() as PlanKey;
  return planKeySet.has(normalized) ? normalized : PLAN_KEYS.PRO_MONTHLY;
}
