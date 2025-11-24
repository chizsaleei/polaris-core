/**
 * Polaris Core - Payments facade
 *
 * One provider agnostic entry point for checkout, customer portal, and
 * webhook normalization. Provider specific code lives in sibling files:
 *   - ./paypal.ts
 *   - ./paymongo.ts
 *
 * This module defines the cross provider types and lazy loads adapters.
 * Route handlers should only depend on the types and functions exported here.
 */

import { log } from "../logger";
import type { PlanKey } from "../constants";
export {
  getDefaultCurrency,
  getDefaultCurrencyForCountry,
  getFxSpec,
  getSupportedCurrencies,
  normalizeCurrencyCode,
  resolveCurrencyHint,
  resolveProfileCurrency,
  convertUsdToDisplayCurrency,
  currencyForCountry,
  type Currency,
} from "./currency";
export {
  getPlanPriceUsdCents,
  getPlanPriceCents,
  getPlanPriceSummary,
  type PlanPriceSummary,
} from "./prices";

// ------------------------------ Provider list -------------------------

export type Provider = "paypal" | "paymongo";

/**
 * Read allowed providers from env BILLING_PROVIDER (comma list) with fallback
 * to both providers enabled in development.
 */
export function getActiveProviders(): Provider[] {
  const raw = process.env.BILLING_PROVIDER || "";
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Provider => s === "paypal" || s === "paymongo");

  if (list.length) return list;
  // Default to both in dev so local work "just works"
  return ["paymongo", "paypal"];
}

export function isProviderActive(p: Provider): boolean {
  return getActiveProviders().includes(p);
}

// ------------------------------ Shared JSON type ----------------------

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

// ------------------------------ Types ---------------------------------

export type Interval = "month" | "year";

export interface CheckoutParams {
  userId: string;
  planKey: PlanKey;
  successUrl: string;
  cancelUrl: string;
  affiliateCode?: string | null;
  // Optional hints for localized pricing/UX.
  country?: string;
  locale?: string;
  // Optional explicit currency (ISO code) when the caller already decided it.
  currency?: string;
}

export interface CheckoutSession {
  url: string; // where to redirect the user
  provider: Provider;
  provider_session_id?: string; // if applicable
  currency?: string;
}

export interface PortalParams {
  userId: string;
  customerId?: string; // provider customer id if known
  returnUrl: string;
  currency?: string;
}

export interface PortalSession {
  url: string;
  provider: Provider;
  currency?: string;
}

export type NormalizedEventType =
  | "payment_succeeded"
  | "payment_refunded"
  | "subscription_created"
  | "subscription_updated"
  | "subscription_canceled"
  | "unknown";

export interface NormalizedEvent {
  id: string; // provider event id (idempotency key)
  provider: Provider;
  type: NormalizedEventType;
  created_at: string; // ISO
  amount_cents?: number;
  currency?: string;
  customer_id?: string;
  subscription_id?: string;
  invoice_id?: string;
  plan_key?: PlanKey;
  user_hint?: string | null; // optional inferred user id or email if present
  raw: JsonValue | null; // original payload for auditing
  request_id?: string; // optional provider request id
}

/**
 * Shape of a row you can insert into payments_events (or similar) as a ledger.
 * Keep this in sync with your SQL schema.
 */
export interface LedgerEntry {
  provider: Provider;
  provider_event_id: string;
  type: NormalizedEventType;
  amount_cents: number | null;
  currency: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  invoice_id: string | null;
  plan_key: PlanKey | null;
  user_hint: string | null;
  payload: JsonValue | null;
  created_at: string; // ISO
  request_id: string | null;
}

/**
 * Minimal capabilities preview for UI when proposing a plan change.
 * The final truth should come from entitlements after commit.
 */
export interface CapabilitiesPreview {
  tier: "pro" | "vip";
  interval: Interval;
  tools: { all?: boolean; limited?: boolean };
  real_time_minutes: number;
}

/**
 * Shared shape for webhook parsing input.
 */
export interface WebhookInput {
  headers: Headers | Record<string, string | string[]>;
  rawBody: string;
}

export interface ProviderAdapter {
  name: Provider;
  /**
   * Create a provider specific checkout session and return the redirect URL.
   * The adapter may also persist a mapping of userId -> provider customer id.
   */
  createCheckoutSession(params: CheckoutParams): Promise<CheckoutSession>;
  /**
   * Create a provider specific customer portal session.
   */
  createPortalSession(params: PortalParams): Promise<PortalSession>;
  /**
   * Verify signature and normalize one or more webhook events from the raw HTTP request.
   */
  parseWebhook(input: WebhookInput): Promise<NormalizedEvent[]>;
}

// ------------------------------ Lazy registry -------------------------

async function loadAdapter(p: Provider): Promise<ProviderAdapter> {
  if (p === "paypal") {
    try {
      const mod = await import("./paypal");
      if (!mod || !mod.adapter) {
        throw new Error("paypal adapter missing export adapter");
      }
      return mod.adapter;
    } catch (e) {
      throw new Error(`paypal adapter not implemented: ${String(e)}`);
    }
  }

  if (p === "paymongo") {
    try {
      const mod = await import("./paymongo");
      if (!mod || !mod.adapter) {
        throw new Error("paymongo adapter missing export adapter");
      }
      return mod.adapter;
    } catch (e) {
      throw new Error(`paymongo adapter not implemented: ${String(e)}`);
    }
  }

  // Should be unreachable if Provider union and callers are correct
  throw new Error("Unknown provider");
}

export async function getAdapter(preferred?: Provider): Promise<ProviderAdapter> {
  const active = getActiveProviders();
  const pick = preferred && active.includes(preferred) ? preferred : active[0];
  if (!pick) throw new Error("No active billing providers configured");
  const adapter = await loadAdapter(pick);
  log.info("payments adapter loaded", { provider: pick });
  return adapter;
}

// ------------------------------ Helpers -------------------------------

/**
 * Normalize a provider name from user or env input.
 */
export function parseProvider(v?: string | null): Provider | undefined {
  if (!v) return undefined;
  const s = v.toLowerCase();
  if (s === "paypal" || s === "paymongo") return s;
  return undefined;
}

/**
 * Build a provider agnostic ledger row from a normalized event. The actual
 * database write should happen in your route handler or a service layer.
 */
export function toLedgerEntry(ev: NormalizedEvent): LedgerEntry {
  return {
    provider: ev.provider,
    provider_event_id: ev.id,
    type: ev.type,
    amount_cents: ev.amount_cents ?? null,
    currency: ev.currency ?? null,
    customer_id: ev.customer_id ?? null,
    subscription_id: ev.subscription_id ?? null,
    invoice_id: ev.invoice_id ?? null,
    plan_key: ev.plan_key ?? null,
    user_hint: ev.user_hint ?? null,
    payload: ev.raw ?? null,
    created_at: ev.created_at,
    request_id: ev.request_id ?? null,
  };
}

/**
 * Map plan key to tier and interval for entitlement updates.
 */
export function planMeta(plan: PlanKey): { tier: "pro" | "vip"; interval: Interval } {
  if (plan.includes("vip")) {
    return { tier: "vip", interval: plan.includes("year") ? "year" : "month" };
  }
  return { tier: "pro", interval: plan.includes("year") ? "year" : "month" };
}

/**
 * Build a minimal capabilities preview to show in UI before committing a plan change.
 * The final capabilities should come from your entitlements table after the grant.
 */
export function previewCapabilities(plan: PlanKey): CapabilitiesPreview {
  const { tier, interval } = planMeta(plan);
  // Minutes are examples. The real limits should be read from the limits table.
  const minutes = tier === "vip" ? 30 : 30; // update if you differentiate later
  return {
    tier,
    interval,
    tools: tier === "vip" ? { all: true } : { limited: true },
    real_time_minutes: minutes,
  };
}

// ------------------------------ Facade API ----------------------------

export async function createCheckout(
  params: CheckoutParams,
  provider?: Provider,
): Promise<CheckoutSession> {
  const adapter = await getAdapter(provider);
  return adapter.createCheckoutSession(params);
}

export async function createPortal(
  params: PortalParams,
  provider?: Provider,
): Promise<PortalSession> {
  const adapter = await getAdapter(provider);
  return adapter.createPortalSession(params);
}

export async function parseWebhook(
  input: WebhookInput,
  provider?: Provider,
): Promise<NormalizedEvent[]> {
  const adapter = await getAdapter(provider);
  return adapter.parseWebhook(input);
}
