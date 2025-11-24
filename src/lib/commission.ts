/**
 * Polaris Core — commission and affiliate helpers
 * Pure functions to calculate commissions, build event payloads,
 * and apply refunds or chargebacks. No database or HTTP calls here.
 */

import { log } from "./logger";
import type { PlanKey } from "./constants";
import type { Currency } from "./payments";

// ------------------------------ Types ---------------------------------

export interface PaymentEventLike {
  provider: string;
  provider_event_id: string; // unique id from provider
  user_id: string;
  plan_key: PlanKey; // pro_monthly, pro_yearly, vip_monthly, vip_yearly
  amount_cents: number; // minor units of currency
  currency: Currency;
  status: "succeeded" | "refunded" | "chargeback" | "failed" | "canceled";
  created_at: string; // ISO
  /** optional coupon code that may override rates */
  coupon_code?: string | null;
  /** optional affiliate code credited for this payment */
  affiliate_code?: string | null;
  /** true if this is the first successful paid event for the user */
  is_first_paid?: boolean;
}

export interface CommissionPolicy {
  /** default first purchase rate in basis points, for example 3000 is 30% */
  default_first_bps: number;
  /** default recurring rate in basis points */
  default_recurring_bps: number;
  /** optional per plan overrides */
  plan_overrides?: Partial<Record<PlanKey, { first_bps?: number; recurring_bps?: number }>>;
  /** optional coupon overrides by code */
  coupon_overrides?: Record<string, { bps: number; note?: string }>;
  /** optional affiliate overrides by code */
  affiliate_overrides?: Record<string, { first_bps?: number; recurring_bps?: number; note?: string }>;
  /** holding period in days before commissions are approved */
  hold_days: number;
  /** refundable window in days when a full refund voids the commission */
  clawback_days: number;
}

export interface CommissionInput {
  payment: PaymentEventLike;
  policy: CommissionPolicy;
  /** pass a stable id for idempotency, default is provider_event_id */
  idempotency_key?: string;
}

export interface CommissionResult {
  commission_cents: number;
  rate_bps: number;
  rate_source: "coupon" | "affiliate" | "plan" | "default";
  currency: Currency;
  hold_until: string; // ISO
  approved_at?: string; // when hold passes
  idempotency_key: string;
}

export type AffiliateEventType =
  | "commission_pending"
  | "commission_approved"
  | "commission_voided"
  | "commission_reversed"; // chargeback or partial refund after approval

export interface AffiliateEventPayload {
  event_type: AffiliateEventType;
  code?: string | null; // affiliate code
  user_id: string;
  provider: string;
  provider_event_id: string;
  currency: Currency;
  amount_cents: number; // payment amount
  commission_cents: number; // positive for earnings, negative for reversals
  rate_bps: number;
  rate_source: CommissionResult["rate_source"];
  plan_key: PlanKey;
  created_at: string; // ISO when this event is produced
  hold_until?: string; // only for pending
  approved_at?: string; // for approved
  note?: string;
}

// ---------------------------- Defaults --------------------------------

export function defaultCommissionPolicy(): CommissionPolicy {
  const envFirst = Number(process.env.AFFILIATE_DEFAULT_FIRST_BPS || 3000);
  const envRec = Number(process.env.AFFILIATE_DEFAULT_RECURRING_BPS || 2000);
  const hold = Number(process.env.AFFILIATE_HOLD_DAYS || 14);
  const claw = Number(process.env.AFFILIATE_CLAWBACK_DAYS || 30);
  return {
    default_first_bps: envFirst,
    default_recurring_bps: envRec,
    plan_overrides: {
      pro_yearly: { first_bps: envFirst, recurring_bps: envRec },
      vip_yearly: { first_bps: envFirst, recurring_bps: envRec },
    },
    coupon_overrides: {},
    affiliate_overrides: {},
    hold_days: hold,
    clawback_days: claw,
  };
}

// --------------------------- Calculations -----------------------------

export function computeCommission(input: CommissionInput): CommissionResult {
  const { payment, policy } = input;
  const first = !!payment.is_first_paid;

  const coupon = payment.coupon_code?.trim().toLowerCase() || undefined;
  const aff = payment.affiliate_code?.trim().toLowerCase() || undefined;

  // Coupon takes precedence, then affiliate, then plan override, then default
  let rate_bps: number | undefined;
  let rate_source: CommissionResult["rate_source"] = "default";

  if (coupon && policy.coupon_overrides && policy.coupon_overrides[coupon]) {
    rate_bps = policy.coupon_overrides[coupon].bps;
    rate_source = "coupon";
  }

  if (!rate_bps && aff && policy.affiliate_overrides && policy.affiliate_overrides[aff]) {
    const o = policy.affiliate_overrides[aff];
    rate_bps = first ? o.first_bps ?? policy.default_first_bps : o.recurring_bps ?? policy.default_recurring_bps;
    rate_source = "affiliate";
  }

  if (!rate_bps && policy.plan_overrides && policy.plan_overrides[payment.plan_key]) {
    const o = policy.plan_overrides[payment.plan_key]!;
    rate_bps = first ? o.first_bps ?? policy.default_first_bps : o.recurring_bps ?? policy.default_recurring_bps;
    rate_source = "plan";
  }

  if (!rate_bps) {
    rate_bps = first ? policy.default_first_bps : policy.default_recurring_bps;
    rate_source = "default";
  }

  const commission_cents = Math.max(0, Math.floor((payment.amount_cents * rate_bps) / 10_000));
  const hold_until = plusDays(payment.created_at, policy.hold_days);

  return {
    commission_cents,
    rate_bps,
    rate_source,
    currency: payment.currency,
    hold_until,
    idempotency_key: input.idempotency_key || payment.provider_event_id,
  };
}

// --------------------------- Event builders ---------------------------

export function buildPendingEvent(payment: PaymentEventLike, res: CommissionResult): AffiliateEventPayload {
  return {
    event_type: "commission_pending",
    code: payment.affiliate_code || payment.coupon_code || null,
    user_id: payment.user_id,
    provider: payment.provider,
    provider_event_id: payment.provider_event_id,
    currency: payment.currency,
    amount_cents: payment.amount_cents,
    commission_cents: res.commission_cents,
    rate_bps: res.rate_bps,
    rate_source: res.rate_source,
    plan_key: payment.plan_key,
    created_at: new Date().toISOString(),
    hold_until: res.hold_until,
  };
}

export function buildApprovedEvent(pending: AffiliateEventPayload, approved_at?: string): AffiliateEventPayload {
  if (pending.event_type !== "commission_pending") {
    throw new Error("buildApprovedEvent expects a pending event");
  }
  return {
    ...pending,
    event_type: "commission_approved",
    approved_at: approved_at || new Date().toISOString(),
    note: "Hold elapsed, commission approved",
  };
}

export function buildVoidedEvent(pending: AffiliateEventPayload, reason: string): AffiliateEventPayload {
  if (pending.event_type !== "commission_pending") {
    throw new Error("buildVoidedEvent expects a pending event");
  }
  return {
    ...pending,
    event_type: "commission_voided",
    commission_cents: 0,
    note: reason,
  };
}

export function buildReversalEvent(approved: AffiliateEventPayload, refund_cents: number, note?: string): AffiliateEventPayload {
  if (approved.event_type !== "commission_approved") {
    throw new Error("buildReversalEvent expects an approved event");
  }
  const proportion = Math.min(1, Math.max(0, refund_cents / Math.max(1, approved.amount_cents)));
  const reversal = -Math.floor(approved.commission_cents * proportion);
  return {
    ...approved,
    event_type: "commission_reversed",
    commission_cents: reversal,
    note: note || "Proportional reversal due to refund or chargeback",
    created_at: new Date().toISOString(),
  };
}

// ------------------------------ Policy ops ----------------------------

export interface RefundDecisionInput {
  payment_created_at: string; // ISO when the payment happened
  refund_created_at: string;  // ISO when refund happened
  policy: CommissionPolicy;
}

export function shouldVoidPendingCommission(input: RefundDecisionInput): boolean {
  // If refund happened before hold elapsed, void the pending commission
  const holdUntil = plusDays(input.payment_created_at, input.policy.hold_days);
  return new Date(input.refund_created_at).getTime() < new Date(holdUntil).getTime();
}

export function isWithinClawback(input: RefundDecisionInput): boolean {
  const claw = plusDays(input.payment_created_at, input.policy.clawback_days);
  return new Date(input.refund_created_at).getTime() <= new Date(claw).getTime();
}

// ------------------------------ Utilities -----------------------------

export function plusDays(iso: string | Date, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString();
}

export function safeCommissionFlow(payment: PaymentEventLike, policy: CommissionPolicy) {
  try {
    const res = computeCommission({ payment, policy });
    const pending = buildPendingEvent(payment, res);
    return { result: res, pending };
  } catch (err) {
    log.error("commission compute failed", { err });
    throw err;
  }
}

// Small helper to format basis points for logs and admin UI
export function fmtBps(bps: number) {
  const pct = (bps / 100).toFixed(2);
  return `${pct}%`;
}
