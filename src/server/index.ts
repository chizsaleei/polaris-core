/**
 * Polaris Core - HTTP server entry
 *
 * Responsibilities
 *  - CORS, basic rate limit, health
 *  - Adaptive: next-item, update-profile
 *  - Payments: checkout, portal, webhooks (PayMongo, PayPal)
 *  - Entitlements write-through and ledger events
 *
 * Note: we intentionally avoid optional deps (helmet, compression, morgan)
 * so this compiles with your current package.json. Add them later if you like.
 */

import express from "express";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { ParamsDictionary, Query as ExpressQuery } from "express-serve-static-core";
import rateLimit from "express-rate-limit";
import cors from "cors";

import { ENV } from "../config/env";
import { corsConfig } from "../config/cors";
import { createClient } from "../lib/supabase";
import { log, safeError } from "../lib/logger";

// Payments adapters
import { adapter as paymongo } from "../lib/payments/paymongo";
import { adapter as paypal } from "../lib/payments/paypal";

import type { PlanKey } from "../lib/constants";
import type { CheckoutParams, PortalParams } from "../lib/payments";
import { Tier } from "../types";

// -----------------------------------------------------------------------------
// Shared API contracts - export so UI and API can share types
// -----------------------------------------------------------------------------

export type PaymentProvider = "paymongo" | "paypal";

export interface CheckoutRequestBody {
  userId: string;
  planKey?: PlanKey;
  /** Legacy field; same values as planKey */
  plan?: PlanKey;
  provider: PaymentProvider;
  successUrl?: string;
  cancelUrl?: string;
  affiliateCode?: string;
  country?: string;
  currency?: string;
}

export interface CheckoutSuccessBody {
  provider: PaymentProvider;
  url: string;
  provider_session_id?: string | null;
  currency?: string | null;
}

export interface PortalRequestBody {
  userId: string;
  provider?: PaymentProvider;
  customerId?: string;
  returnUrl?: string;
  currency?: string;
}

export interface PortalSuccessBody {
  url: string;
  provider: PaymentProvider | "app";
  currency?: string | null;
}

export interface ErrorBody {
  error: string;
}

// -----------------------------------------------------------------------------
// Feature routes
// -----------------------------------------------------------------------------

import nextItem from "./routes/adaptive/next-item";
import updateProfile from "./routes/adaptive/update-profile";
import realtimeToken from "./routes/realtime/token";
import searchCards from "./routes/search/cards";
import searchSessions from "./routes/search/sessions";
import transcribeRun from "./routes/transcribe/run";
import transcribeUpload from "./routes/transcribe/upload";
import ttsSpeak from "./routes/tts/speak";
import uploadRoute from "./routes/upload/index";
import ticketsRoute from "./routes/tickets/index";
import ticketMessagesRoute from "./routes/tickets/messages";
import accountExport from "./routes/account/export";
import accountProfile from "./routes/account/profile";
import adminAudit from "./routes/admin/audit";
import adminMessages from "./routes/admin/messages";
import adminMetrics from "./routes/admin/metrics";
import drillsStart from "./routes/drills/start";
import gradingGrade from "./routes/grading/grade";

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

const supabase = createClient();
const app = express();

const APP_BASE_URL = (ENV.APP_BASE_URL || "https://app.example.com").replace(/\/$/, "");
const DEFAULT_CHECKOUT_SUCCESS_URL = `${APP_BASE_URL}/account/billing?state=success`;
const DEFAULT_CHECKOUT_CANCEL_URL = `${APP_BASE_URL}/account/billing?state=cancel`;
const DEFAULT_PORTAL_RETURN_URL = `${APP_BASE_URL}/account/billing`;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors(corsConfig()));

// 60 req/min per IP
app.use(
  rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// Health
app.get("/health", (_req, res) =>
  res.status(200).json({ ok: true, version: process.env.npm_package_version }),
);

// Root info route to avoid confusing 404s on /
app.get("/", (_req, res) =>
  res.status(200).json({
    ok: true,
    service: "polaris-core",
    version: process.env.npm_package_version,
    docs: "See ops/docs/setup.md for available endpoints.",
  }),
);

// Optional API key guard (set CORE_API_KEY to enable)
app.use((req, res, next) => {
  if (!ENV.CORE_API_KEY) return next();
  if (req.path === "/health") return next();
  if (req.headers["x-api-key"] === ENV.CORE_API_KEY) return next();
  return res.status(401).json({ error: "unauthorized" });
});

// Bridge x-user-id from the web proxy
app.use((req, _res, next) => {
  const uid = req.header("x-user-id");
  if (uid) {
    req.user = {
      userId: String(uid),
      email: req.user?.email ?? null,
      tier: req.user?.tier ?? Tier.FREE,
      roles: req.user?.roles ?? [],
    };
  }
  next();
});

// -----------------------------------------------------------------------------
// Adaptive routes
// -----------------------------------------------------------------------------

app.use("/adaptive/next-item", nextItem);
app.use("/adaptive/update-profile", updateProfile);
app.use("/api/realtime/token", realtimeToken);
app.use("/api/search/cards", searchCards);
app.use("/api/search/sessions", searchSessions);
app.use("/api/transcribe", transcribeRun);
app.use("/api/transcribe", transcribeUpload);
app.use("/api/tts", ttsSpeak);
app.use("/api/upload", uploadRoute);
app.use("/api/tickets", ticketsRoute);
app.use("/api/tickets", ticketMessagesRoute);
app.use("/account/export", accountExport);
app.use("/account/profile", accountProfile);
app.use("/admin/audit", adminAudit);
app.use("/admin/messages", adminMessages);
app.use("/admin/metrics", adminMetrics);
app.use("/drills/start", drillsStart);
app.use("/grading/grade", gradingGrade);

// -----------------------------------------------------------------------------
// Payments - Checkout & Portal
// -----------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-misused-promises */

/**
 * POST /api/pay/checkout
 * Body: CheckoutRequestBody
 *
 * Returns provider specific session data and also writes a pending ledger row.
 */
const checkoutRoute = asyncHandler<
  unknown,
  CheckoutSuccessBody | ErrorBody,
  CheckoutRequestBody
>(async (req, res) => {
  try {
    const { userId, provider } = req.body;
    const planKey = normalizePlanKey(req.body.planKey ?? req.body.plan);

    if (!userId || !planKey) {
      return res.status(400).json({ error: "Missing userId or planKey" });
    }

    if (provider !== "paymongo" && provider !== "paypal") {
      return res.status(400).json({ error: "Unsupported provider" });
    }

    const reference = makeReference(userId, planKey); // polaris_<uid>_<plan>_<ts>

    // Write pending event
    await recordPaymentEvent({
      provider,
      reference,
      status: "pending",
      plan: planKey,
      userId,
    });

    const successUrl = req.body.successUrl ?? DEFAULT_CHECKOUT_SUCCESS_URL;
    const cancelUrl = req.body.cancelUrl ?? DEFAULT_CHECKOUT_CANCEL_URL;

    const baseParams: CheckoutParams = {
      userId,
      planKey,
      successUrl,
      cancelUrl,
      affiliateCode: req.body.affiliateCode,
      country: req.body.country,
      currency: req.body.currency,
    };

    if (provider === "paymongo") {
      const out = await paymongo.createCheckoutSession(baseParams);
      const { provider: _drop, ...rest } = out; // avoid duplicate key
      return res.status(200).json({ provider, ...rest });
    }

    if (provider === "paypal") {
      const out = await paypal.createCheckoutSession(baseParams);
      const { provider: _drop, ...rest } = out; // avoid duplicate key
      return res.status(200).json({ provider, ...rest });
    }

    return res.status(400).json({ error: "Unsupported provider" });
  } catch (err) {
    log.error("checkout error", { err: safeError(err) });
    return res.status(500).json({ error: "internal_error" });
  }
});
app.post("/api/pay/checkout", checkoutRoute);

/**
 * POST /api/pay/portal
 * Body: PortalRequestBody
 * Reply with a URL to your own account page or the provider specific portal if supported.
 */
const portalRoute = asyncHandler<unknown, PortalSuccessBody | ErrorBody, PortalRequestBody>(
  async (req, res) => {
    const { userId, provider } = req.body;
    if (!userId) return res.status(400).json({ error: "Missing userId" });

    try {
      const returnUrl = req.body.returnUrl ?? DEFAULT_PORTAL_RETURN_URL;
      const basePortalParams: PortalParams = {
        userId,
        returnUrl,
        customerId: req.body.customerId,
        currency: req.body.currency,
      };

      if (provider === "paymongo") {
        const out = await paymongo.createPortalSession(basePortalParams);
        return res.status(200).json({ url: out.url, provider: "paymongo" });
      }
      if (provider === "paypal") {
        const out = await paypal.createPortalSession(basePortalParams);
        return res.status(200).json({ url: out.url, provider: "paypal" });
      }
    } catch (err) {
      log.error("portal session error", {
        err: safeError(err),
        provider,
        userId,
      });
      // fall through to default URL
    }

    const url = `${APP_BASE_URL}/account/billing?user=${encodeURIComponent(userId)}`;
    return res.status(200).json({ url, provider: provider || "app" });
  },
);
app.post("/api/pay/portal", portalRoute);

// -----------------------------------------------------------------------------
// Webhooks - PayMongo and PayPal
// Both use raw JSON body so the adapters can verify signatures correctly.
// -----------------------------------------------------------------------------

// PayMongo
app.post(
  "/api/pay/webhooks/paymongo",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    try {
      const rawBody =
        typeof req.body === "string"
          ? req.body
          : (req.body as Buffer).toString("utf8");
      const headers = headersToRecord(req.headers);

      const events = await paymongo.parseWebhook({ headers, rawBody });

      for (const ev of events) {
        const userHint = ev.user_hint ?? undefined; // coerce null to undefined

        await recordPaymentEvent({
          provider: "paymongo",
          status: ev.type,
          reference: ev.request_id || ev.id,
          plan: ev.plan_key,
          userId: userHint,
          amountMinor: ev.amount_cents,
          currency: ev.currency,
          raw: ev.raw ?? parseJson(rawBody),
        });

        if (ev.type === "payment_succeeded") {
          await grantEntitlement(userHint, ev.plan_key, "paymongo", ev.id);
        } else if (ev.type === "payment_refunded") {
          await revokeEntitlement(userHint, "paymongo", ev.id);
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      log.error("paymongo webhook error", { err: safeError(err) });
      return res.status(500).json({ error: "internal_error" });
    }
  }),
);

// PayPal
app.post(
  "/api/pay/webhooks/paypal",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    try {
      const rawBody =
        typeof req.body === "string"
          ? req.body
          : (req.body as Buffer).toString("utf8");
      const headers = headersToRecord(req.headers);

      const events = await paypal.parseWebhook({ headers, rawBody });

      for (const ev of events) {
        const userHint = ev.user_hint ?? undefined;

        await recordPaymentEvent({
          provider: "paypal",
          status: ev.type,
          reference: ev.request_id || ev.id,
          plan: ev.plan_key,
          userId: userHint,
          amountMinor: ev.amount_cents,
          currency: ev.currency,
          raw: ev.raw ?? parseJson(rawBody),
        });

        if (ev.type === "payment_succeeded" || ev.type === "subscription_created") {
          await grantEntitlement(userHint, ev.plan_key, "paypal", ev.id);
        } else if (ev.type === "payment_refunded" || ev.type === "subscription_canceled") {
          await revokeEntitlement(userHint, "paypal", ev.id);
        }
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      log.error("paypal webhook error", { err: safeError(err) });
      return res.status(500).json({ error: "internal_error" });
    }
  }),
);

/* eslint-enable @typescript-eslint/no-misused-promises */

// -----------------------------------------------------------------------------
// 404 and error handlers
// -----------------------------------------------------------------------------

app.use((req, res) => res.status(404).json({ error: "not_found", path: req.path }));

app.use(
  (
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    log.error("[core] error", { err: safeError(err) });
    res.status(500).json({ error: "internal_error" });
  },
);

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

app.listen(ENV.PORT, () => {
  log.info(`polaris-core listening on http://localhost:${ENV.PORT}`);
});

// -----------------------------------------------------------------------------
// Helpers - ledger, entitlements, headers, utility
// -----------------------------------------------------------------------------

function asyncHandler<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = ExpressQuery,
  Locals extends Record<string, any> = Record<string, any>,
>(
  fn: RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals>,
): RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals> {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

async function recordPaymentEvent(input: {
  provider?: PaymentProvider;
  status: string;
  reference?: string;
  plan?: PlanKey;
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
    });
  } catch (e) {
    log.error("recordPaymentEvent failed", { err: safeError(e) });
  }
}

async function grantEntitlement(
  userId?: string,
  plan?: PlanKey,
  source?: PaymentProvider,
  reference?: string,
) {
  if (!userId || !plan) return;

  // Prefer RPC if you created it; otherwise upsert directly
  try {
    const { error } = await supabase.rpc("grant_entitlement", {
      p_user_id: userId,
      p_tier: plan.startsWith("vip") ? "vip" : "pro",
      p_source: source,
      p_reference: reference,
    });

    if (!error) return;
  } catch {
    // fall through to direct upsert
  }

  await supabase.from("entitlements").upsert(
    {
      user_id: userId,
      plan,
      active: true,
      source: source ?? null,
      reference: reference ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,plan" },
  );
}

async function revokeEntitlement(
  userId?: string,
  source?: PaymentProvider,
  reference?: string,
) {
  if (!userId) return;

  try {
    const { error } = await supabase.rpc("revoke_entitlement", {
      p_user_id: userId,
      p_source: source,
      p_reference: reference,
    });
    if (!error) return;
  } catch {
    // fall through
  }

  await supabase
    .from("entitlements")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
}

function makeReference(userId: string, plan: PlanKey) {
  return `polaris_${userId}_${plan}_${Date.now()}`;
}

function headersToRecord(
  headers: Request["headers"],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string" || Array.isArray(v)) {
      out[k] = v;
    }
  }
  return out;
}

function normalizePlanKey(raw?: string | null): PlanKey | undefined {
  if (!raw) return undefined;
  const key = raw.trim() as PlanKey;
  if (
    key === "pro_monthly" ||
    key === "pro_yearly" ||
    key === "vip_monthly" ||
    key === "vip_yearly"
  ) {
    return key;
  }
  return undefined;
}

function parseJson(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

