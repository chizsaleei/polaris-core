/**
 * Polaris Env - public and server helpers
 * Matches .env.example for PayMongo and PayPal. No Adyen.
 */

import dotenv from "dotenv";

// Load local env when running in Node (dev) before anything else.
// Prefer .env.local if present, then fall back to .env.
dotenv.config({ path: ".env.local" });
dotenv.config();

export const isServer = typeof window === "undefined";
export const NODE_ENV = process.env.NODE_ENV || "development";
type DeploymentEnv = "development" | "preview" | "production";
const FALLBACK_VERCEL_ENV: DeploymentEnv =
  NODE_ENV === "production" ? "production" : "development";
function coerceDeploymentEnv(value?: string | null): DeploymentEnv {
  if (
    value === "development" ||
    value === "preview" ||
    value === "production"
  ) {
    return value;
  }
  return FALLBACK_VERCEL_ENV;
}
export const VERCEL_ENV: DeploymentEnv = coerceDeploymentEnv(
  process.env.VERCEL_ENV,
);
export const isProd = VERCEL_ENV === "production";
export const isPreview = VERCEL_ENV === "preview";
export const isDev = !isProd && !isPreview;

function assertPresent(
  name: string,
  value: string | undefined,
): asserts value is string {
  if (!value || String(value).trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
}

function list(v?: string) {
  return (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Public env for client code.
 * Only expose NEXT_PUBLIC_* values.
 */
export function publicEnv() {
  const NEXT_PUBLIC_APP_BASE_URL = process.env.NEXT_PUBLIC_APP_BASE_URL;
  const NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const NEXT_PUBLIC_SUPABASE_ANON_KEY =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const NEXT_PUBLIC_APP_VERSION =
    process.env.NEXT_PUBLIC_APP_VERSION || "0.0.0";

  assertPresent("NEXT_PUBLIC_APP_BASE_URL", NEXT_PUBLIC_APP_BASE_URL);
  assertPresent("NEXT_PUBLIC_SUPABASE_URL", NEXT_PUBLIC_SUPABASE_URL);
  assertPresent(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  return {
    APP_BASE_URL: NEXT_PUBLIC_APP_BASE_URL,
    SUPABASE_URL: NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: NEXT_PUBLIC_SUPABASE_ANON_KEY,
    APP_VERSION: NEXT_PUBLIC_APP_VERSION,
    ENV: VERCEL_ENV,
  };
}

/**
 * Server-only env for API routes, workers, or Node services.
 * Never import this from client components.
 */
export function serverEnv() {
  if (!isServer) throw new Error("serverEnv() was called on the client");

  // Port and base URL
  const PORT = Number(process.env.PORT || 8787);
  const APP_BASE_URL =
    process.env.APP_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_BASE_URL ||
    "http://localhost:3000";
  const CORE_API_KEY = process.env.CORE_API_KEY || "";

  // Supabase (server)
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";

  assertPresent("SUPABASE_URL", SUPABASE_URL);
  assertPresent("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY);

  // Billing providers
  const rawProviders = process.env.BILLING_PROVIDER || "";
  const providers = list(rawProviders).map((p) => p.toLowerCase());
  const allowed = new Set(["paymongo", "paypal"]);
  const enabled = providers.filter((p): p is "paymongo" | "paypal" =>
    allowed.has(p),
  );
  if (enabled.length === 0) {
    throw new Error("BILLING_PROVIDER must include at least one of: paymongo, paypal");
  }

  // PayMongo (required if enabled)
  const PAYMONGO_SECRET_KEY = enabled.includes("paymongo")
    ? process.env.PAYMONGO_SECRET_KEY
    : "";
  const PAYMONGO_PUBLIC_KEY = enabled.includes("paymongo")
    ? process.env.PAYMONGO_PUBLIC_KEY
    : "";
  const PAYMONGO_WEBHOOK_SECRET = enabled.includes("paymongo")
    ? process.env.PAYMONGO_WEBHOOK_SECRET
    : "";

  if (enabled.includes("paymongo")) {
    assertPresent("PAYMONGO_SECRET_KEY", PAYMONGO_SECRET_KEY);
    assertPresent("PAYMONGO_PUBLIC_KEY", PAYMONGO_PUBLIC_KEY);
    assertPresent("PAYMONGO_WEBHOOK_SECRET", PAYMONGO_WEBHOOK_SECRET);
  }

  // PayPal (required if enabled)
  const PAYPAL_CLIENT_ID = enabled.includes("paypal")
    ? process.env.PAYPAL_CLIENT_ID
    : "";
  const PAYPAL_CLIENT_SECRET = enabled.includes("paypal")
    ? process.env.PAYPAL_CLIENT_SECRET
    : "";
  const PAYPAL_MODE = enabled.includes("paypal")
    ? ((process.env.PAYPAL_MODE || "sandbox").toLowerCase() as
        | "sandbox"
        | "live")
    : ("sandbox" as "sandbox" | "live");
  const PAYPAL_WEBHOOK_ID = enabled.includes("paypal")
    ? process.env.PAYPAL_WEBHOOK_ID
    : "";

  if (enabled.includes("paypal")) {
    assertPresent("PAYPAL_CLIENT_ID", PAYPAL_CLIENT_ID);
    assertPresent("PAYPAL_CLIENT_SECRET", PAYPAL_CLIENT_SECRET);
    assertPresent("PAYPAL_MODE", PAYPAL_MODE);
    assertPresent("PAYPAL_WEBHOOK_ID", PAYPAL_WEBHOOK_ID);
  }

  // CORS and misc
  const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
  const CORS_ADDITIONAL_ORIGINS =
    process.env.CORS_ADDITIONAL_ORIGINS || "";
  const LOG_LEVEL = process.env.LOG_LEVEL || "info";
  const APP_VERSION = process.env.npm_package_version || "0.1.0";
  const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

  return {
    PORT,
    APP_BASE_URL,
    CORE_API_KEY,

    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET,

    BILLING_PROVIDER: enabled,

    // PayMongo
    PAYMONGO_SECRET_KEY,
    PAYMONGO_PUBLIC_KEY,
    PAYMONGO_WEBHOOK_SECRET,

    // PayPal
    PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET,
    PAYPAL_MODE,
    PAYPAL_WEBHOOK_ID,

    // CORS and misc
    CORS_ORIGIN,
    CORS_ADDITIONAL_ORIGINS,
    LOG_LEVEL,
    APP_VERSION,
    ADMIN_API_KEY,
  };
}

/**
 * Single ENV object used by the server.
 * Keeps earlier imports working: `import { ENV } from "../config/env"`
 */
export const ENV = {
  NODE_ENV,
  VERCEL_ENV,
  isProd,
  isPreview,
  isDev,
  ...serverEnv(),
};

/**
 * Allowed origins builder for middleware or API routes.
 */
export function allowedOrigins() {
  const extra = list(process.env.CORS_ADDITIONAL_ORIGINS);
  const set = new Set<string>([
    // Prefer server APP_BASE_URL, fall back to NEXT_PUBLIC if present
    ENV.APP_BASE_URL,
    ...extra,
  ]);

  const vercelUrl = process.env.VERCEL_URL;
  if (vercelUrl) set.add(`https://${vercelUrl}`);

  if (isDev) {
    ["http://localhost:3000", "http://localhost:3001", "http://localhost:5173"].forEach(
      (o) => set.add(o),
    );
  }

  return Array.from(set);
}

export function mask(value: string | null | undefined, show = 4) {
  if (!value) return "";
  const head = value.slice(0, show);
  return `${head}***`;
}
