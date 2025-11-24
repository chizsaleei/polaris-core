/**
 * PayMongo adapter
 *
 * Minimal implementation using PayMongo Payment Links for checkout and
 * HMAC verification for webhooks. Customer portal falls back to your app's
 * billing page, since PayMongo does not provide a hosted portal.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { log, safeError } from "../logger";
import { PLAN_KEYS, type PlanKey } from "../constants";
import { currencyForCountry, type Currency } from "./currency";
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

const API_BASE = (process.env.PAYMONGO_API_BASE || "https://api.paymongo.com").replace(/\/$/, "");
const SECRET_KEY = process.env.PAYMONGO_SECRET_KEY || ""; // sk_test_* or sk_live_*
const WEBHOOK_SECRET = process.env.PAYMONGO_WEBHOOK_SECRET || ""; // webhook signing secret
const APP_BASE_URL = (process.env.NEXT_PUBLIC_APP_BASE_URL || process.env.APP_BASE_URL || "").replace(
  /\/$/,
  "",
);

const PLAN_KEY_VALUES = Object.values(PLAN_KEYS) as readonly string[];

if (!SECRET_KEY) log.warn("PAYMONGO_SECRET_KEY not set. Checkout will fail.");
if (!WEBHOOK_SECRET) log.warn("PAYMONGO_WEBHOOK_SECRET not set. Webhook verification will fail.");

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

// ----------------------------- PayMongo types -------------------------

// JSON backed utility types aligned with JsonValue
type JsonObject = { [key: string]: JsonValue };

type PayMongoMetadata = JsonObject & {
  plan_key?: string;
  user_id?: string;
  affiliate_code?: string | null;
  success_url?: string | null;
  cancel_url?: string | null;
  provider?: string | null;
};

type PayMongoPaymentAttributes = JsonObject & {
  amount?: number | string;
  currency?: string;
  status?: string;
  metadata?: PayMongoMetadata;
  customer_id?: string;
  description?: string;
  remarks?: string;
};

type PayMongoEventAttributes = JsonObject & {
  type?: string;
  created_at?: number | string;
  data?: PayMongoResource<PayMongoPaymentAttributes>;
  status?: string;
  metadata?: PayMongoMetadata;
  request_id?: string;
};

type PayMongoResource<TAttrs extends JsonObject = JsonObject> = JsonObject & {
  id?: string;
  type?: string;
  attributes?: TAttrs;
};

type PayMongoWebhookPayload = JsonObject & {
  data?: PayMongoResource<PayMongoEventAttributes | PayMongoPaymentAttributes>;
};

// Payment link response shape (minimal)
interface PayMongoLinkAttributes {
  checkout_url?: string;
  short_url?: string;
}

interface PayMongoLinkResponse {
  data?: {
    attributes?: PayMongoLinkAttributes;
  };
}

// ------------------------------ HTTP ----------------------------------

async function httpJson<T>(path: string, body: unknown): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${btoa(`${SECRET_KEY}:`)}`,
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => null)) as unknown;

  if (!res.ok) {
    log.error("paymongo http error", { status: res.status, url, json });
    throw new Error(`PayMongo error ${res.status}`);
  }

  return json as T;
}

// --------------------------- Adapter API ------------------------------

async function createCheckoutSession(params: CheckoutParams): Promise<CheckoutSession> {
  const resolvedCurrency: Currency = currencyForCountry(params.country);
  // PayMongo only processes PHP reliably; fall back to USD for everyone else.
  const billingCurrency: Currency = resolvedCurrency === "PHP" ? "PHP" : "USD";
  const amount_cents = getPlanPriceCents(params.planKey, billingCurrency);
  const description = `Polaris Coach - ${planLabel(params.planKey)}`;

  const payload = {
    data: {
      attributes: {
        amount: amount_cents,
        currency: billingCurrency,
        description,
        remarks: `user:${params.userId} plan:${params.planKey}`,
        metadata: {
          user_id: params.userId,
          plan_key: params.planKey,
          affiliate_code: params.affiliateCode ?? null,
          success_url: params.successUrl ?? null,
          cancel_url: params.cancelUrl ?? null,
          provider: "paymongo",
        } satisfies PayMongoMetadata,
      } satisfies PayMongoPaymentAttributes,
    },
  };

  const data = await httpJson<PayMongoLinkResponse>("/v1/links", payload);
  const attrs = data?.data?.attributes;
  const url = attrs?.checkout_url || attrs?.short_url;

  if (!url) throw new Error("PayMongo link did not return a URL");

  return { url, provider: "paymongo", currency: billingCurrency };
}

function createPortalSession(_params: PortalParams): Promise<PortalSession> {
  // PayMongo has no hosted customer portal. Send user to your in app billing page.
  const base = APP_BASE_URL || "";
  if (!base) log.warn("APP_BASE_URL not set. Returning relative portal path.");
  const url = base ? `${base}/account/billing` : "/account/billing";
  return Promise.resolve({ url, provider: "paymongo" });
}

function parseWebhook(input: WebhookInput): Promise<NormalizedEvent[]> {
  verifySignature(input.headers, input.rawBody);

  const payload = JSON.parse(input.rawBody || "{}") as PayMongoWebhookPayload;
  const ev = normalizeEvent(payload);

  return Promise.resolve(ev ? [ev] : []);
}

// ---------------------------- Normalization ---------------------------

function normalizeEvent(payload: PayMongoWebhookPayload): NormalizedEvent | null {
  try {
    const data = payload.data;
    if (!data) {
      log.warn("paymongo webhook payload missing data");
      return null;
    }

    const attrs = data.attributes;
    if (!attrs) {
      log.warn("paymongo webhook payload missing attributes");
      return null;
    }

    const eventAttrs = isEventAttributes(attrs) ? attrs : undefined;
    const paymentAttrs = extractPaymentAttributes(attrs);
    if (!paymentAttrs) {
      log.warn("paymongo webhook payload missing payment attributes");
      return null;
    }

    const createdRaw = eventAttrs?.created_at;
    const eventType = eventAttrs?.type;

    const amount_cents = num(paymentAttrs.amount);
    const currency = str(paymentAttrs.currency);

    const meta = paymentAttrs.metadata;

    const plan_key = isPlanKey(meta?.plan_key) ? meta.plan_key : undefined;

    const user_hint = typeof meta?.user_id === "string" ? meta.user_id : undefined;

    const status = typeof paymentAttrs.status === "string" ? paymentAttrs.status : undefined;
    const normType = mapType(eventType ?? "", status);

    const request_id =
      typeof eventAttrs?.request_id === "string"
        ? eventAttrs.request_id
        : typeof data.attributes?.request_id === "string"
          ? data.attributes.request_id
          : undefined;

    const id = (typeof data.id === "string" && data.id) || request_id || "";

    return {
      id,
      provider: "paymongo",
      type: normType,
      created_at: tsToIso(createdRaw),
      amount_cents,
      currency: currency || undefined,
      customer_id: str(paymentAttrs.customer_id) || undefined,
      subscription_id: undefined,
      invoice_id: undefined,
      plan_key,
      user_hint,
      raw: payload,
      request_id,
    };
  } catch (e) {
    log.error("paymongo normalize failed", { err: safeError(e) });
    return null;
  }
}

function isEventAttributes(
  attrs: PayMongoEventAttributes | PayMongoPaymentAttributes,
): attrs is PayMongoEventAttributes {
  return "request_id" in attrs || "created_at" in attrs || "data" in attrs || "type" in attrs;
}

function extractPaymentAttributes(
  attrs: PayMongoEventAttributes | PayMongoPaymentAttributes,
): PayMongoPaymentAttributes | undefined {
  if (isEventAttributes(attrs)) {
    return attrs.data?.attributes;
  }
  return attrs;
}

function isPlanKey(value: unknown): value is PlanKey {
  return typeof value === "string" && PLAN_KEY_VALUES.includes(value);
}

function mapType(type: string, status?: string): NormalizedEvent["type"] {
  const t = type.toLowerCase();
  if (t.includes("refund")) return "payment_refunded";
  if (t.includes("paid") || status === "paid") return "payment_succeeded";
  if (t.includes("payment_intent.succeeded")) return "payment_succeeded";
  if (t.includes("payment_intent.payment_failed")) return "unknown";
  return "unknown";
}

// --------------------------- Signature check --------------------------

function verifySignature(headers: Headers | Record<string, string | string[]>, rawBody: string): void {
  const h = lowerHeaders(headers);
  const sig = h.get("paymongo-signature");
  if (!sig) throw new Error("Missing PayMongo-Signature");

  // format: t=timestamp,v1=signature
  const parts = new Map<string, string>();
  for (const piece of sig.split(",")) {
    const [k, v] = piece.split("=").map((s) => s.trim());
    if (k && v) parts.set(k, v);
  }

  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) throw new Error("Invalid signature header");

  const payload = `${t}.${rawBody}`;
  const calc = hmacSha256Hex(WEBHOOK_SECRET, payload);
  if (!timingSafeEqualHex(v1, calc)) throw new Error("Signature verification failed");
}

// ------------------------------- Utils --------------------------------

function lowerHeaders(h: Headers | Record<string, string | string[]>): Map<string, string> {
  const map = new Map<string, string>();

  if (!h) return map;

  if (typeof Headers !== "undefined") {
    const init = h as HeadersInit;
    const hh = h instanceof Headers ? h : new Headers(init);
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

function tsToIso(ts: number | string | undefined): string {
  if (typeof ts === "number") {
    const ms = ts < 2_000_000_000 ? ts * 1000 : ts;
    return new Date(ms).toISOString();
  }
  if (typeof ts === "string") {
    const n = Number(ts);
    if (Number.isFinite(n)) return tsToIso(n);
  }
  return new Date().toISOString();
}

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "hex");
  const bBuf = Buffer.from(b, "hex");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// Node btoa polyfill
function btoa(str: string): string {
  return Buffer.from(str, "utf8").toString("base64");
}

// ------------------------------ Export --------------------------------

export const adapter: ProviderAdapter = {
  name: "paymongo",
  createCheckoutSession,
  createPortalSession,
  parseWebhook,
};
