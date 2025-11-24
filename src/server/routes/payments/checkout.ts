// src/server/routes/payments/checkout.ts
/**
 * Provider-agnostic checkout endpoint.
 *
 * Body:
 *   {
 *     userId: string,
 *     plan: 'pro_monthly'|'pro_yearly'|'vip_monthly'|'vip_yearly',
 *     provider?: 'paymongo'|'paypal',
 *     country?: string,
 *     locale?: string,
 *     affiliateCode?: string,
 *     successUrl?: string,
 *     cancelUrl?: string
 *   }
 *
 * Response (200):
 *   { ok: true, provider, url, reference, provider_session_id? }
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import {
  createCheckout,
  parseProvider,
  type Provider,
  getActiveProviders,
  getPlanPriceSummary,
} from "../../../lib/payments";
import type { PlanKey } from "../../../lib/constants";
import { ENV } from "../../../config/env";
import type { AuthInfo } from "../../middleware/auth";

const router = Router();
const supabase = createClient();

type CheckoutRequest = Request<ParamsDictionary> & { user?: AuthInfo };

router.post("/", (req: CheckoutRequest, res: Response): void => {
  void handleCheckout(req, res);
});

export default router;

async function handleCheckout(req: CheckoutRequest, res: Response): Promise<void> {
  const headerUser = req.header("x-user-id");
  const contextUserId =
    req.user?.userId ?? (typeof headerUser === "string" ? headerUser.trim() : undefined);

  await runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
    try {
      const payload = sanitizePayload(req.body || {});
      const issues = validatePayload(payload);
      if (issues.length) {
        sendError(res, 400, "invalid_payload", issues.join(" | "));
        return;
      }

      const profile = await loadProfileHints(payload.userId);
      const countryHint = payload.country ?? profile?.country_code ?? undefined;
      const currencyHint = payload.currency ?? profile?.currency_code ?? undefined;
      const priceSummary = getPlanPriceSummary(payload.plan, currencyHint);

      const reference = makeReference(payload.userId, payload.plan);
      const provider = chooseProvider(payload.provider);

      await recordPaymentEvent({
        provider,
        reference,
        status: "pending",
        plan: payload.plan,
        userId: payload.userId,
        currency: currencyHint ?? priceSummary.displayCurrency,
      });

      const checkout = await createCheckout(
        {
          userId: payload.userId,
          planKey: payload.plan,
          successUrl: payload.successUrl ?? defaultSuccessUrl(reference),
          cancelUrl: payload.cancelUrl ?? defaultCancelUrl(),
          affiliateCode: payload.affiliateCode ?? undefined,
          country: countryHint,
          locale: payload.locale,
          currency: currencyHint,
        },
        provider,
      );

      const billingCurrency = checkout.currency ?? priceSummary.displayCurrency;

      res.status(200).json({
        ok: true,
        data: {
          provider: checkout.provider,
          url: checkout.url,
          reference,
          provider_session_id: checkout.provider_session_id ?? null,
          billingCurrency,
          displayCurrency: priceSummary.displayCurrency,
          displayAmount: priceSummary.displayAmount,
          displayFormatted: priceSummary.formatted,
          amountUsd: priceSummary.amountUsd,
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      const status = (error as { status?: number } | undefined)?.status ?? 500;
      const code = (error as { code?: string } | undefined)?.code ?? "internal_error";
      const message =
        status === 500
          ? "Checkout failed."
          : (error as { message?: string } | undefined)?.message || "Checkout failed.";
      if (status >= 500) log.error("payments/checkout error", { err: safeError(error) });
      sendError(res, status, code, message);
    }
  });
}

// -----------------------------------------------------------------------------
// Payload helpers
// -----------------------------------------------------------------------------

interface CheckoutPayload {
  userId: string;
  plan: PlanKey;
  provider?: Provider;
  country?: string;
  locale?: string;
  affiliateCode?: string;
  successUrl?: string;
  cancelUrl?: string;
  currency?: string;
}

function sanitizePayload(body: unknown): CheckoutPayload {
  const raw: Record<string, unknown> = isPlainObject(body) ? body : {};
  const userId =
    firstString(raw.userId) ??
    firstString(raw.user_id) ??
    "";
  const planRaw = firstString(raw.plan) ?? "";
  const plan = isPlanKey(planRaw) ? planRaw : ("pro_monthly" as PlanKey);
  const provider = parseProvider(firstString(raw.provider));
  const country = firstString(raw.country);
  const locale = firstString(raw.locale);
  const affiliateCode =
    firstString(raw.affiliateCode) ??
    firstString(raw.affiliate_code);
  const successUrl = normalizeUrl(
    firstString(raw.successUrl) ?? firstString(raw.success_url),
  );
  const cancelUrl = normalizeUrl(
    firstString(raw.cancelUrl) ?? firstString(raw.cancel_url),
  );
  const currency = firstString(raw.currency);

  return {
    userId,
    plan,
    provider,
    country,
    locale,
    affiliateCode,
    successUrl,
    cancelUrl,
    currency,
  };
}

function validatePayload(payload: CheckoutPayload) {
  const issues: string[] = [];
  if (!payload.userId) issues.push("userId is required");
  if (!payload.plan || !isPlanKey(payload.plan)) issues.push("plan is invalid");
  return issues;
}

function isPlanKey(value: string): value is PlanKey {
  return value === "pro_monthly" || value === "pro_yearly" || value === "vip_monthly" || value === "vip_yearly";
}

function chooseProvider(preferred?: Provider) {
  if (preferred && getActiveProviders().includes(preferred)) return preferred;
  const active = getActiveProviders();
  if (!active.length) throw makeHttpError(503, "no_provider", "No billing providers configured.");
  return active[0];
}

function defaultSuccessUrl(reference: string) {
  const base = ENV.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_BASE_URL || "";
  if (!base) return `/billing/success?ref=${encodeURIComponent(reference)}`;
  return `${base.replace(/\/$/, "")}/billing/success?ref=${encodeURIComponent(reference)}`;
}

function defaultCancelUrl() {
  const base = ENV.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_BASE_URL || "";
  if (!base) return "/billing";
  return `${base.replace(/\/$/, "")}/billing`;
}

// -----------------------------------------------------------------------------
// Persistence helpers
// -----------------------------------------------------------------------------

async function recordPaymentEvent(input: {
  provider?: Provider;
  status: string;
  reference?: string;
  plan?: string;
  userId?: string;
  amountMinor?: number;
  currency?: string;
  raw?: unknown;
}) {
  try {
    await supabase.from("payments_events").insert({
      provider: input.provider ?? null,
      provider_ref: input.reference ?? null,
      status: input.status,
      plan: input.plan ?? null,
      user_id: input.userId ?? null,
      amount_minor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      raw: input.raw ?? null,
    } as any);
  } catch (error) {
    log.warn("recordPaymentEvent failed", { err: safeError(error) });
  }
}

function makeReference(userId: string, plan: string) {
  return `polaris_${userId}_${plan}_${Date.now()}`;
}

interface ProfileHintsRow {
  country_code: string | null;
  currency_code: string | null;
}

async function loadProfileHints(userId: string): Promise<ProfileHintsRow | null> {
  const response = await supabase
    .from("profiles")
    .select("country_code,currency_code")
    .eq("id", userId)
    .maybeSingle();

  if (response.error) {
    log.warn("checkout profile lookup failed", { err: safeError(response.error) });
    return null;
  }
  return asProfileHintsRow(response.data);
}

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------

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

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const str = firstString(entry);
      if (str) return str;
    }
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  return undefined;
}

function normalizeUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.toString();
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asProfileHintsRow(value: unknown): ProfileHintsRow | null {
  if (!isPlainObject(value)) return null;
  const { country_code: country, currency_code: currency } = value;
  const countrySafe = typeof country === "string" || country === null ? country ?? null : null;
  const currencySafe =
    typeof currency === "string" || currency === null ? currency ?? null : null;
  return { country_code: countrySafe, currency_code: currencySafe };
}
