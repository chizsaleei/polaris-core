/**
 * Polaris Core — Voice presets and coach mapping
 *
 * Provider agnostic voice presets with simple prosody controls and
 * one default assignment per AI coach. Environment variables can
 * override per-coach selection without code changes.
 *
 * Env overrides (string or JSON):
 *   VOICE_FOR_COACH_CARTER_GOLEMAN="openai:alloy:en-US"
 *   VOICE_FOR_COACH_CHELSEA_LIGHTBOWN='{"provider":"openai","voiceId":"verse","locale":"en-PH"}'
 */

// Keep local CoachKey to avoid cross-module init order issues
export type CoachKey =
  | "chase_krashen"
  | "dr_claire_swales"
  | "carter_goleman"
  | "chelsea_lightbown"
  | "dr_clark_atul"
  | "dr_crystal_benner"
  | "christopher_buffett"
  | "colton_covey"
  | "cody_turing"
  | "chloe_sinek";

export type VoiceProvider = "openai" | "elevenlabs" | "gcp" | "azure" | "other";

export interface VoicePreset {
  provider: VoiceProvider;
  voiceId: string; // provider specific id or name
  locale?: string; // BCP‑47, for example en-US, en-GB, en-PH
  rate?: number; // 1.0 is normal
  pitch?: number; // semitone shift, 0 is normal
  volume?: number; // dB delta, 0 is normal
  style?: string; // optional provider style tag
}

// ---------------------------------------------------------------------
// Base presets
// ---------------------------------------------------------------------

const PRESETS: Record<string, VoicePreset> = {
  neutral_us: { provider: "openai", voiceId: "alloy", locale: "en-US", rate: 1.0, pitch: 0, volume: 0 },
  female_us: { provider: "openai", voiceId: "verse", locale: "en-US", rate: 1.0, pitch: 1, volume: 0 },
  male_us: { provider: "openai", voiceId: "alloy", locale: "en-US", rate: 0.98, pitch: -1, volume: 0 },
  academic_gb: { provider: "openai", voiceId: "sage", locale: "en-GB", rate: 0.98, pitch: 0, volume: 0 },
  warm_ph: { provider: "openai", voiceId: "verse", locale: "en-PH", rate: 1.0, pitch: 1, volume: 0 },
  executive_us: { provider: "openai", voiceId: "atticus", locale: "en-US", rate: 1.02, pitch: 0, volume: 0 },
  calm_us: { provider: "openai", voiceId: "luna", locale: "en-US", rate: 0.98, pitch: 0, volume: 0 },
};

/** Default when no better match exists */
export const DEFAULT_VOICE: VoicePreset = PRESETS.neutral_us;

// ---------------------------------------------------------------------
// Coach → preset mapping (sane defaults)
// ---------------------------------------------------------------------

const COACH_VOICE_PRESET: Record<CoachKey, keyof typeof PRESETS> = {
  // Academic English (PEEL): clear and slightly British
  chase_krashen: "academic_gb",
  // Graduate admissions: calm and clear
  dr_claire_swales: "calm_us",
  // Professional interview: confident executive tone
  carter_goleman: "executive_us",
  // IELTS and ESL: friendly and clear, PH locale for familiarity
  chelsea_lightbown: "warm_ph",
  // Physicians: neutral male
  dr_clark_atul: "male_us",
  // Nursing: warm PH
  dr_crystal_benner: "warm_ph",
  // Finance: neutral US
  christopher_buffett: "neutral_us",
  // Leadership: executive US
  colton_covey: "executive_us",
  // Technical: neutral male US for concise delivery
  cody_turing: "male_us",
  // Personal development: warm calm US
  chloe_sinek: "calm_us",
};

// ---------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------

export function listVoices(): VoicePreset[] {
  return Object.values(PRESETS);
}

export function getVoicePreset(key: keyof typeof PRESETS): VoicePreset {
  return PRESETS[key] || DEFAULT_VOICE;
}

/** Pick a voice for a coach, honoring env overrides. */
export function pickVoiceForCoach(coach: CoachKey): VoicePreset {
  // 1) Env override by full coach key
  const env = readEnvOverride(coach);
  if (env) return env;
  // 2) Default mapping
  const presetKey = COACH_VOICE_PRESET[coach];
  return clonePreset(PRESETS[presetKey] || DEFAULT_VOICE);
}

/** Simple random choice from a list of presets (not seeded). */
export function pickSimple(keys: Array<keyof typeof PRESETS>): VoicePreset {
  const k = keys[Math.floor(Math.random() * keys.length)] || "neutral_us";
  return clonePreset(PRESETS[k]);
}

/** Return a copy with a different locale. */
export function withLocale(v: VoicePreset, locale: string): VoicePreset {
  return { ...v, locale };
}

/** Clamp prosody values into a safe range. */
export function clampProsody(v: VoicePreset): VoicePreset {
  return {
    ...v,
    rate: clampNum(v.rate, 0.8, 1.2, 1.0),
    pitch: clampNum(v.pitch, -3, 3, 0),
    volume: clampNum(v.volume, -6, 6, 0),
  };
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

function clonePreset(v: VoicePreset): VoicePreset {
  return { ...v };
}

function clampNum(v: number | undefined, min: number, max: number, d: number): number {
  if (!Number.isFinite(v as number)) return d;
  return Math.max(min, Math.min(max, Number(v)));
}

function readEnvOverride(coach: CoachKey): VoicePreset | null {
  const key = `VOICE_FOR_COACH_${coach.toUpperCase()}`; // underscores are already present
  const raw = safeEnv(key);
  if (!raw) return null;
  const parsed = parseVoicePresetJSON(raw);
  if (parsed) return parsed;
  // Fallback to provider:id:locale
  const parts = raw.split(":");
  if (parts.length >= 2) {
    const [provider, voiceId, locale] = parts as [VoiceProvider, string, string?];
    return clampProsody({ provider, voiceId, locale, rate: 1.0, pitch: 0, volume: 0 });
  }
  return null;
}

function safeEnv(name: string): string | undefined {
  if (typeof process !== "undefined" && process?.env) {
    return process.env[name];
  }
  return undefined;
}

function parseVoicePresetJSON(raw: string): VoicePreset | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isVoicePresetLike(parsed)) {
      return clampProsody(parsed);
    }
  } catch {
    return null;
  }
  return null;
}

function isVoicePresetLike(value: unknown): value is VoicePreset {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  if (!isVoiceProvider(data.provider) || typeof data.voiceId !== "string") return false;
  if ("locale" in data && typeof data.locale !== "string") return false;
  if ("rate" in data && !isOptionalNumber(data.rate)) return false;
  if ("pitch" in data && !isOptionalNumber(data.pitch)) return false;
  if ("volume" in data && !isOptionalNumber(data.volume)) return false;
  if ("style" in data && typeof data.style !== "string") return false;
  return true;
}

function isOptionalNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isVoiceProvider(value: unknown): value is VoiceProvider {
  return (
    value === "openai" ||
    value === "elevenlabs" ||
    value === "gcp" ||
    value === "azure" ||
    value === "other"
  );
}
