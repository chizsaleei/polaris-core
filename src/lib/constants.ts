/**
 * Polaris Coach - shared constants
 * These values are stable defaults. The server remains the source of truth for runtime gates.
 */

// App metadata
export const APP = {
  NAME: "Polaris Coach",
  VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? "0.1.0",
} as const;

// Tiers and plan keys
export const TIERS = { FREE: "free", PRO: "pro", VIP: "vip" } as const;
export type Tier = typeof TIERS[keyof typeof TIERS];

export const PLAN_KEYS = {
  PRO_MONTHLY: "pro_monthly",
  PRO_YEARLY: "pro_yearly",
  VIP_MONTHLY: "vip_monthly",
  VIP_YEARLY: "vip_yearly",
} as const;
export type PlanKey = typeof PLAN_KEYS[keyof typeof PLAN_KEYS];

// Default capability limits. The database controls final limits per env and plan.
export const DEFAULT_MINUTES_DAILY: Record<Tier, number> = {
  free: 10,
  pro: 30,
  vip: 60, // tune in DB seeds if you prefer
};

export const TOOLS_LIMIT: Record<Tier, number> = {
  free: 1,
  pro: 3,
  vip: Number.POSITIVE_INFINITY,
};

export const COACH_SWITCH_COOLDOWN_HOURS: Record<Tier, number> = {
  free: 72,
  pro: 72,
  vip: 0,
};

// Practice engine timing defaults
export const PRACTICE_TIMERS = {
  STAR_SPRINT_SEC: 120,
  RESEARCH_PITCH_SEC: 180,
  ICU_CASE_SEC: 240,
  MINI_LECTURE_SEC: 60,
} as const;

// Spaced review ladder in days
export const SPACED_REVIEW_DAYS = [1, 3, 7, 14] as const;

// Anti repetition window
export const LRU_HIDE_LAST = 50 as const;

// Payment providers
export const PAYMENT_PROVIDERS = { PAYPAL: "paypal", PAYMONGO: "paymongo" } as const;
export type PaymentProvider = typeof PAYMENT_PROVIDERS[keyof typeof PAYMENT_PROVIDERS];

export const ENABLED_PROVIDERS: PaymentProvider[] = (process.env.BILLING_PROVIDER || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s): s is PaymentProvider => s === "paypal" || s === "paymongo");

// Storage buckets
export const BUCKETS = {
  PUBLIC_ASSETS: "public-assets",
  USER_MEDIA: "user-media",
  EXPORTS: "exports",
  TEMP_UPLOADS: "temp-uploads",
} as const;

// API routes
export const API_ROUTES = {
  PAY_CHECKOUT: "/api/pay/checkout",
  PAY_PORTAL: "/api/pay/portal",
  PAY_WEBHOOKS_PAYPAL: "/api/pay/webhooks/paypal",
  PAY_WEBHOOKS_PAYMONGO: "/api/pay/webhooks/paymongo",
  REALTIME_TOKEN: "/api/realtime/token",
  TRANSCRIBE: "/api/transcribe",
  TTS: "/api/tts",
} as const;

// Analytics event names
export const EVENTS = {
  ONBOARDING_COMPLETED: "onboarding_completed",
  COACH_SELECTED: "coach_selected",
  PRACTICE_STARTED: "practice_started",
  PRACTICE_SUBMITTED: "practice_submitted",
  FEEDBACK_VIEWED: "feedback_viewed",
  VOCAB_SAVED: "vocab_saved",
  DAY_COMPLETED: "day_completed",
  PLAN_UPGRADED: "plan_upgraded",
  PAYMENT_STATUS: "payment_status",
  COACH_SWITCHED: "coach_switched",
  DRILL_OPENED: "drill_opened",
  UPLOAD_STARTED: "upload_started",
  UPLOAD_SUCCEEDED: "upload_succeeded",
  UPLOAD_FAILED: "upload_failed",
} as const;
export type EventName = typeof EVENTS[keyof typeof EVENTS];

// Cron job ids used in logs and locks
export const CRON = {
  WEEKLY_SUMMARY: "cron:weekly-summary",
  RECONCILE_LEDGER: "cron:reconcile-ledger",
  REFRESH_VIEWS: "cron:refresh-views",
  DRIP_DISPATCH: "cron:drip-dispatch",
} as const;

// Coach keys
export const COACH_KEYS = [
  "carter-goleman",
  "chase-krashen",
  "chelsea-lightbown",
  "chloe-sinek",
  "christopher-buffett",
  "claire-swales",
  "clark-atul",
  "crystal-benner",
  "colton-covey",
  "cody-turing",
] as const;
export type CoachKey = typeof COACH_KEYS[number];

// Branding tokens
export const BRAND = {
  PRIMARY: "#07435E",
  SECONDARY: "#042838",
  ACCENT: "#4390BA",
  SURFACE: "#DBF7FF",
  BASE_DARK: "#001C29",
  TEXT: "#000000",
} as const;

// Accessibility
export const WCAG = {
  TARGET: "AA",
} as const;

// Disclaimers that render in medical and finance flows
export const DISCLAIMERS = {
  MEDICAL:
    "Educational only. Not a medical diagnosis or treatment plan. Always consult a licensed clinician for decisions about care.",
  FINANCE:
    "Educational only. Not financial advice. Make decisions with a qualified professional and your own research.",
} as const;

// MIME types allowed for uploads
export const ALLOWED_UPLOAD_MIME = [
  "audio/webm",
  "audio/mpeg",
  "audio/wav",
  "image/webp",
  "image/png",
  "image/jpeg",
  "application/zip",
  "application/json",
] as const;

// Embeddings and NLP config
export const EMBEDDINGS = {
  DIMENSIONS: 768, // match DB default in 0010_embeddings.sql
} as const;

// Utility: guard for Infinity tool limits on client UIs
export function toolsCapFor(tier: Tier): number | "unlimited" {
  const n = TOOLS_LIMIT[tier];
  return n === Number.POSITIVE_INFINITY ? "unlimited" : n;
}

Object.freeze(APP);
