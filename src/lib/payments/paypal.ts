/**
 * PayPal adapter (REST v2)
 *
 * - Creates Checkout Orders and returns the approval URL
 * - Verifies webhooks via PayPal's verify endpoint
 * - Normalizes common payment and subscription events
 * - Customer portal: redirect to in app billing (PayPal has no hosted portal)
 */

import {
  CheckoutPaymentIntent,
  Client as PayPalClient,
  Environment as PayPalEnvironment,
  type OAuthToken,
  OrderApplicationContextUserAction,
  OrdersController,
  type OrderRequest,
} from "@paypal/paypal-server-sdk";

import { log, safeError } from "../logger";
import type { PlanKey } from "../constants";
import type { Currency } from "./currency";
import { getPlanPriceCents } from "./prices";
import type {
  CheckoutParams,
  CheckoutSession,
  JsonValue,
  NormalizedEvent,
  ProviderAdapter,
  PortalParams,
  PortalSession,
  WebhookInput,
} from "./index";

// --------------------------- Configuration ----------------------------

const MODE = (process.env.PAYPAL_MODE || "sandbox").toLowerCase(); // "sandbox" | "live"
const API_BASE = MODE === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || ""; // required for webhook verification
const APP_BASE_URL = (process.env.NEXT_PUBLIC_APP_BASE_URL || process.env.APP_BASE_URL || "").replace(/\/$/, "");

if (!CLIENT_ID || !CLIENT_SECRET) log.warn("PAYPAL_CLIENT_ID/SECRET not set. Checkout will fail.");
if (!WEBHOOK_ID) log.warn("PAYPAL_WEBHOOK_ID not set. Webhook verification will fail.");

const paypalClient = new PayPalClient({
  environment: MODE === "live" ? PayPalEnvironment.Production : PayPalEnvironment.Sandbox,
  clientCredentialsAuthCredentials: {
    oAuthClientId: CLIENT_ID,
    oAuthClientSecret: CLIENT_SECRET,
  },
});
const ordersController = new OrdersController(paypalClient);
let cachedOAuthToken: OAuthToken | undefined;

// ----------------------------- Pricing --------------------------------

function planLabel(plan: PlanKey): string {
  switch (plan) {
    case "pro_monthly":
      return "Pro Monthly";
    case "pro_yearly":
      return "Pro Yearly";
    case "vip_monthly":
      return "VIP Monthly";
    case "vip_yearly":
      return "VIP Yearly";
    default:
      return plan;
  }
}

const priceCents = (plan: PlanKey, currency: Currency) => getPlanPriceCents(plan, currency);

// --------------------------- Small helpers ----------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function safeReadJson(res: Response): Promise<unknown> {
  try {
    const data = (await res.json()) as unknown;
    return data;
  } catch {
    return null;
  }
}

function safeParseJson(raw: string): unknown {
  try {
    const data = JSON.parse(raw || "{}") as unknown;
    return data;
  } catch {
    return null;
  }
}

async function paypalAccessToken(): Promise<string> {
  cachedOAuthToken = await paypalClient.clientCredentialsAuthManager.updateToken(cachedOAuthToken);
  return cachedOAuthToken.accessToken;
}

async function paypalApi<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await paypalAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });

  const ct = res.headers.get("content-type") || "";
  let body: unknown;
  if (ct.includes("application/json")) {
    body = await safeReadJson(res);
  } else {
    body = await res.text();
  }

  if (!res.ok) {
    log.error("paypal api error", { path, status: res.status, body });
    throw new Error(`PayPal ${res.status}`);
  }

  return body as T;
}

// ----------------------------- Webhook types --------------------------

interface PaypalAmount {
  value?: string;
  currency_code?: string;
}

interface PaypalSellerReceivableBreakdown {
  gross_amount?: PaypalAmount;
}

interface PaypalPayer {
  payer_id?: string;
}

interface PaypalSubscriber {
  payer_id?: string;
}

interface PaypalSupplementaryRelatedIds {
  order_id?: string;
}

interface PaypalSupplementaryData {
  related_ids?: PaypalSupplementaryRelatedIds;
}

interface PaypalResource {
  id?: string;
  amount?: PaypalAmount;
  seller_receivable_breakdown?: PaypalSellerReceivableBreakdown;
  custom_id?: string;
  invoice_id?: string;
  custom?: string;
  payer?: PaypalPayer;
  subscriber?: PaypalSubscriber;
  subscription_id?: string;
  supplementary_data?: PaypalSupplementaryData;
}

interface PaypalWebhookPayload {
  id?: string;
  event_type?: string;
  create_time?: string;
  resource?: PaypalResource;
}

function isPaypalWebhookPayload(value: unknown): value is PaypalWebhookPayload {
  return isRecord(value);
}

// --------------------------- Adapter API ------------------------------

async function createCheckoutSession(params: CheckoutParams): Promise<CheckoutSession> {
  const billingCurrency: Currency = "USD";
  const amount_cents = priceCents(params.planKey, billingCurrency);
  const amount_value = (amount_cents / 100).toFixed(2);
  const description = `Polaris Coach - ${planLabel(params.planKey)}`;
  const custom = buildCustomMeta(params.userId, params.planKey);

  const orderRequest: OrderRequest = {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [
      {
        referenceId: `user_${params.userId}`.slice(0, 35),
        description,
        customId: custom.slice(0, 127),
        amount: { currencyCode: billingCurrency, value: amount_value },
      },
    ],
    applicationContext: {
      brandName: "Polaris Coach",
      userAction: OrderApplicationContextUserAction.PayNow,
      returnUrl: params.successUrl,
      cancelUrl: params.cancelUrl,
    },
  };

  const { result } = await ordersController.createOrder({
    body: orderRequest,
    prefer: "return=representation",
  });

  const approve = result.links?.find((l) => l.rel === "approve")?.href;
  if (!approve) throw new Error("PayPal did not return an approval link");
  return {
    url: approve,
    provider: "paypal",
    provider_session_id: result.id,
    currency: billingCurrency,
  };
}

function createPortalSession(_params: PortalParams): Promise<PortalSession> {
  // No hosted portal. Send to your own billing page.
  const base = APP_BASE_URL || "";
  if (!base) log.warn("APP_BASE_URL not set. Returning relative portal path.");
  const url = base ? `${base}/account/billing` : "/account/billing";
  return Promise.resolve({ url, provider: "paypal" });
}

async function parseWebhook(input: WebhookInput): Promise<NormalizedEvent[]> {
  const verified = await verifyWebhook(input);
  if (!verified) throw new Error("PayPal webhook verification failed");

  const payloadUnknown = safeParseJson(input.rawBody);
  if (!isPaypalWebhookPayload(payloadUnknown)) {
    log.error("paypal webhook payload not in expected shape");
    return [];
  }

  const ev = normalizeEvent(payloadUnknown);
  return ev ? [ev] : [];
}

// --------------------------- Webhook verify ---------------------------

async function verifyWebhook(input: WebhookInput): Promise<boolean> {
  const h = lowerHeaders(input.headers);
  const transmission_id = h.get("paypal-transmission-id") || "";
  const transmission_time = h.get("paypal-transmission-time") || "";
  const cert_url = h.get("paypal-cert-url") || "";
  const transmission_sig = h.get("paypal-transmission-sig") || "";
  const auth_algo = h.get("paypal-auth-algo") || "";

  if (!WEBHOOK_ID) throw new Error("Missing PAYPAL_WEBHOOK_ID");

  const webhook_event = safeParseJson(input.rawBody);

  const body = {
    auth_algo,
    cert_url,
    transmission_id,
    transmission_sig,
    transmission_time,
    webhook_id: WEBHOOK_ID,
    webhook_event,
  };

  type VerifyRes = { verification_status?: "SUCCESS" | "FAILURE" };

  try {
    const res = await paypalApi<VerifyRes>("/v1/notifications/verify-webhook-signature", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return res.verification_status === "SUCCESS";
  } catch (e) {
    log.error("paypal verify failed", { err: safeError(e) });
    return false;
  }
}

// ---------------------------- Normalization ---------------------------

function mapPaypalTypeToNormalized(type: string): NormalizedEvent["type"] {
  switch (type) {
    case "PAYMENT.CAPTURE.COMPLETED":
    case "CHECKOUT.ORDER.APPROVED":
      return "payment_succeeded";
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.SALE.REFUNDED":
      return "payment_refunded";
    case "BILLING.SUBSCRIPTION.ACTIVATED":
      return "subscription_created";
    case "BILLING.SUBSCRIPTION.UPDATED":
      return "subscription_updated";
    case "BILLING.SUBSCRIPTION.CANCELLED":
      return "subscription_canceled";
    default:
      return "unknown";
  }
}

function normalizeEvent(p: PaypalWebhookPayload): NormalizedEvent | null {
  try {
    const type = typeof p.event_type === "string" ? p.event_type : "";
    const created_at =
      typeof p.create_time === "string" && p.create_time.length > 0
        ? p.create_time
        : new Date().toISOString();

    const resource = p.resource;

    const amountSource =
      resource?.amount || resource?.seller_receivable_breakdown?.gross_amount;
    const amount_value = amountSource?.value;
    const currency_code = amountSource?.currency_code;

    const amountNumber = toNumber(amount_value);

    const customId =
      (resource?.custom_id ?? resource?.invoice_id ?? resource?.custom) || "";
    const meta = parseCustom(typeof customId === "string" ? customId : "");

    const norm = mapPaypalTypeToNormalized(type);

    const payer = resource?.payer;
    const subscriber = resource?.subscriber;

    const customerId =
      (payer && typeof payer.payer_id === "string" && payer.payer_id) ||
      (subscriber && typeof subscriber.payer_id === "string" && subscriber.payer_id) ||
      undefined;

    const subscription_id =
      (resource &&
        typeof resource.subscription_id === "string" &&
        resource.subscription_id) ||
      (resource && typeof resource.id === "string" && resource.id) ||
      undefined;

    const invoice_id =
      resource && typeof resource.invoice_id === "string" ? resource.invoice_id : undefined;

    let request_id: string | undefined;
    const supp = resource?.supplementary_data;
    if (supp && supp.related_ids && typeof supp.related_ids.order_id === "string") {
      request_id = supp.related_ids.order_id;
    }

    const id =
      (typeof p.id === "string" && p.id) ||
      (resource && typeof resource.id === "string" && resource.id) ||
      "";

    const event: NormalizedEvent = {
      id,
      provider: "paypal",
      type: norm,
      created_at,
      amount_cents: amountNumber != null ? Math.round(amountNumber * 100) : undefined,
      currency: typeof currency_code === "string" && currency_code ? currency_code : undefined,
      customer_id: customerId,
      subscription_id,
      invoice_id,
      plan_key: meta.plan_key,
      user_hint: meta.user_id,
      raw: p as unknown as JsonValue,
      request_id,
    };

    return event;
  } catch (e) {
    log.error("paypal normalize failed", { err: safeError(e) });
    return null;
  }
}

// --------------------------- Helpers ----------------------------------

function parseCustom(custom: string): { user_id?: string; plan_key?: PlanKey } {
  // custom format: "user:<uid>|plan:<plan_key>|provider:paypal"
  const out: { user_id?: string; plan_key?: PlanKey } = {};
  if (!custom) return out;

  const parts = custom.split("|");
  for (const piece of parts) {
    const [k, v] = piece.split(":", 2);
    if (!k || !v) continue;
    const key = k.trim().toLowerCase();
    const val = v.trim();
    if (key === "user") out.user_id = val;
    if (key === "plan") out.plan_key = val as PlanKey;
  }
  return out;
}

function buildCustomMeta(userId: string, plan: PlanKey): string {
  return `user:${userId}|plan:${plan}|provider:paypal`;
}

function lowerHeaders(h: Headers | Record<string, string | string[]>): Map<string, string> {
  const map = new Map<string, string>();
  if (!h) return map;

  if (typeof Headers !== "undefined") {
    const init = h as HeadersInit;
    const hh: Headers = h instanceof Headers ? h : new Headers(init);
    hh.forEach((value, key) => map.set(key.toLowerCase(), value));
    return map;
  }

  const obj = h as Record<string, string | string[]>;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    map.set(k.toLowerCase(), Array.isArray(v) ? String(v[0]) : String(v));
  }
  return map;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

// ------------------------------- Export --------------------------------

export const adapter: ProviderAdapter = {
  name: "paypal",
  createCheckoutSession,
  createPortalSession,
  parseWebhook,
};
