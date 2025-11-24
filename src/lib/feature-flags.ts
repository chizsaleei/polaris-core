/**
 * Polaris Core — Feature flags and kill switches
 * Server is the source of truth. Flags can be controlled by:
 *  1) Local overrides (tests and emergency toggles)
 *  2) Remote loader (e.g., DB table or KV) registered at runtime
 *  3) Environment variable FEATURE_FLAGS (JSON)
 *  4) Built-in defaults
 *
 * No background threads. Callers can await `getAllFlags` or `isEnabled` which
 * will refresh from the remote loader at most once per TTL window.
 */

// ----------------------------- Types ---------------------------------

export const FEATURE_KEYS = [
  "tool_expressions_pack",
  "tool_pronunciation_mirror",
  "tool_live_chat",
  "payments",
  "practice_engine_v2",
  "tts_provider_alt",
  "stt_provider_alt",
] as const;
export type FeatureKey = typeof FEATURE_KEYS[number];

export type Tier = "free" | "pro" | "vip";

export interface FlagRule {
  /** default on/off when no other rule matches */
  default: boolean;
  /** explicit per env overrides: development, preview, production */
  env?: Partial<Record<EnvName, boolean>>;
  /** explicit per tier overrides */
  tiers?: Partial<Record<Tier, boolean>>;
  /** percentage based rollout gate from 0 to 100 inclusive */
  percentage?: number;
  /** hard kill switch that forces the flag off regardless of other rules */
  kill?: boolean;
  /** optional note to explain why a rule exists */
  note?: string;
  /** ISO date string when the rule was introduced */
  since?: string;
}

export interface GateContext {
  env?: EnvName;
  tier?: Tier;
  /** stable id for hashing in percentage rollouts */
  subjectId?: string; // user_id or account_id
  country?: string;
}

export type EnvName = "development" | "preview" | "production";

export interface FlagEval {
  enabled: boolean;
  reason: string;
  rule?: FlagRule;
}

// ----------------------------- Defaults ------------------------------

const DEFAULTS: Record<FeatureKey, FlagRule> = {
  tool_expressions_pack: {
    default: true,
    note: "Core to learning loop",
    since: "2025-10-16",
  },
  tool_pronunciation_mirror: {
    default: true,
    env: { preview: true, production: true },
    note: "Mirror with stress tips",
  },
  tool_live_chat: {
    default: false,
    env: { development: true, preview: false, production: false },
    note: "Live human chat parked",
  },
  payments: {
    default: true,
    env: { development: true, preview: true, production: true },
  },
  practice_engine_v2: {
    default: true,
    env: { development: true, preview: true, production: true },
    percentage: 100,
    note: "New scoring and pack builder",
  },
  tts_provider_alt: {
    default: false,
    env: { development: true },
    percentage: 10,
    note: "Canary alt TTS provider",
  },
  stt_provider_alt: {
    default: false,
    env: { development: true },
    percentage: 10,
    note: "Canary alt STT provider",
  },
};

// --------------------------- Implementation --------------------------

const localOverrides = new Map<FeatureKey, boolean | FlagRule>();

// Remote loader can be registered by the app to pull flags from DB or KV.
export type RemoteLoader = () => Promise<Partial<Record<FeatureKey, FlagRule>> | null>;
let remoteLoader: RemoteLoader | null = null;
let cache: { flags: Partial<Record<FeatureKey, FlagRule>>; at: number } = {
  flags: {},
  at: 0,
};
const TTL_MS = 30_000; // refresh window

export function registerRemoteLoader(loader: RemoteLoader) {
  remoteLoader = loader;
}

export function setLocalOverride(key: FeatureKey, value: boolean | FlagRule) {
  localOverrides.set(key, value);
}

export function clearLocalOverride(key?: FeatureKey) {
  if (key) localOverrides.delete(key);
  else localOverrides.clear();
}

function getEnvName(): EnvName {
  const vercel = (process.env.VERCEL_ENV || "").toLowerCase();
  if (vercel === "production" || vercel === "preview" || vercel === "development") return vercel as EnvName;
  const node = (process.env.NODE_ENV || "development").toLowerCase();
  if (node === "production") return "production";
  if (node === "test") return "development";
  return "development";
}

function parseEnvFlags(): Partial<Record<FeatureKey, FlagRule>> {
  const raw = process.env.FEATURE_FLAGS;
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Record<FeatureKey, FlagRule>> = {};
    for (const k of FEATURE_KEYS) {
      const v = obj[k];
      if (typeof v === "boolean") out[k] = { default: v };
      else if (v && typeof v === "object") out[k] = v as FlagRule;
    }
    return out;
  } catch (e) {
    console.warn("Invalid FEATURE_FLAGS JSON. Ignoring.", e);
    return {};
  }
}

function mergeFlags(): Record<FeatureKey, FlagRule> {
  const envFlags = parseEnvFlags();
  const merged: Record<FeatureKey, FlagRule> = { ...DEFAULTS } as Record<FeatureKey, FlagRule>;
  for (const k of FEATURE_KEYS) {
    // remote
    const r = cache.flags[k];
    if (r) merged[k] = { ...merged[k], ...r };
    // env
    const e = envFlags[k];
    if (e) merged[k] = { ...merged[k], ...e };
    // local override boolean or rule
    const o = localOverrides.get(k);
    if (typeof o === "boolean") merged[k] = { ...merged[k], default: o };
    else if (o && typeof o === "object") merged[k] = { ...merged[k], ...o };
  }
  return merged;
}

function fnv1a32(str: string): number {
  // Simple FNV-1a hash for stable percentage rollouts
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function inPercentageGate(subjectId: string | undefined, pct: number | undefined): boolean {
  if (!pct || pct >= 100) return true;
  if (pct <= 0) return false;
  const id = subjectId || "global";
  const n = fnv1a32(id) % 100;
  return n < Math.floor(pct);
}

export function evaluateFlag(key: FeatureKey, ctx?: GateContext): FlagEval {
  const env = ctx?.env || getEnvName();
  const rules = mergeFlags();
  const rule = rules[key];
  if (!rule) return { enabled: false, reason: "missing", rule };

  if (rule.kill) return { enabled: false, reason: "kill", rule };

  // env override
  if (rule.env && env in rule.env && typeof rule.env[env] === "boolean") {
    const v = !!rule.env[env];
    // apply percentage after env if provided
    if (v && rule.percentage != null) {
      return {
        enabled: inPercentageGate(ctx?.subjectId, rule.percentage),
        reason: `env:${env}+pct:${rule.percentage}`,
        rule,
      };
    }
    return { enabled: v, reason: `env:${env}` , rule};
  }

  // tier override
  if (ctx?.tier && rule.tiers && ctx.tier in rule.tiers && typeof rule.tiers[ctx.tier] === "boolean") {
    const v = !!rule.tiers[ctx.tier];
    if (v && rule.percentage != null) {
      return {
        enabled: inPercentageGate(ctx?.subjectId, rule.percentage),
        reason: `tier:${ctx.tier}+pct:${rule.percentage}`,
        rule,
      };
    }
    return { enabled: v, reason: `tier:${ctx.tier}`, rule };
  }

  // percentage rollout on top of default
  if (rule.percentage != null) {
    return {
      enabled: rule.default && inPercentageGate(ctx?.subjectId, rule.percentage),
      reason: `default:${rule.default}+pct:${rule.percentage}`,
      rule,
    };
  }

  return { enabled: !!rule.default, reason: `default:${rule.default}`, rule };
}

export async function refreshFlags(force = false): Promise<void> {
  const now = Date.now();
  if (!remoteLoader) return; // nothing to do
  if (!force && now - cache.at < TTL_MS) return;
  try {
    const res = await remoteLoader();
    if (res) {
      cache = { flags: res, at: now };
    } else {
      cache.at = now; // mark checked
    }
  } catch (e) {
    console.warn("feature-flags: remote loader failed", e);
  }
}

export async function isEnabled(key: FeatureKey, ctx?: GateContext): Promise<boolean> {
  await refreshFlags(false);
  return evaluateFlag(key, ctx).enabled;
}

export async function getAllFlags(ctx?: GateContext): Promise<Record<FeatureKey, boolean>> {
  await refreshFlags(false);
  const out = {} as Record<FeatureKey, boolean>;
  for (const k of FEATURE_KEYS) out[k] = evaluateFlag(k, ctx).enabled;
  return out;
}

// Handy helper for building capability JSONs across services
export interface CapabilityInput {
  tier: Tier;
  userId?: string;
  env?: EnvName;
}

export async function buildCapabilities(input: CapabilityInput) {
  const env = input.env || getEnvName();
  const ctx: GateContext = { env, tier: input.tier, subjectId: input.userId };
  const flags = await getAllFlags(ctx);

  return {
    tier: input.tier,
    env,
    tools: {
      expressions_pack: flags.tool_expressions_pack,
      pronunciation_mirror: flags.tool_pronunciation_mirror,
      live_chat: flags.tool_live_chat,
    },
    payments: flags.payments,
    variants: {
      practice_engine_v2: flags.practice_engine_v2,
      tts_alt: flags.tts_provider_alt,
      stt_alt: flags.stt_provider_alt,
    },
    // The caller can merge entitlements and limits on top of this.
    source: "feature-flags",
    at: new Date().toISOString(),
  } as const;
}
