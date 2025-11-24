// src/core/scheduler/daily-deterministic.ts
/**
 * Polaris Core - Daily deterministic picker
 * Portable, no external imports.
 */

import { formatYmdInTimezone } from "../../lib/timezone";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export enum Tier {
  FREE = "free",
  PRO = "pro",
  VIP = "vip",
}

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

export type ItemFormat = string;

export interface CatalogItem {
  id: string;
  coach: CoachKey;
  skill?: string;
  topic?: string;
  format?: ItemFormat;
  difficulty?: 1 | 2 | 3 | 4 | 5;
  language?: string;
  minutes?: number;
  tags?: string[];
  active?: boolean;
}

export interface PickerFilters {
  coach?: CoachKey[];
  topic?: string[];
  skill?: string[];
  format?: string[];
  difficultyMin?: number;
  difficultyMax?: number;
  language?: string;
}

export interface PickerOptions {
  userId: string;
  date?: Date | string;
  timezone?: string;
  tier: Tier;
  items: CatalogItem[];
  lru?: string[];
  count?: number;
  filters?: PickerFilters;
  lastSelected?: CatalogItem | null;
  avoid?: {
    repeatSkill?: boolean;
    repeatTopic?: boolean;
    repeatFormat?: boolean;
  };
}

export interface PickerResult {
  items: CatalogItem[];
  meta: {
    rng: "mulberry32";
    seed: string;
    seedInt: number;
    userId: string;
    date: string;
    appliedFilters: Required<PickerFilters> | Record<string, unknown>;
    excluded: { lru: number; inactive: number; gatedByTier: number; guardrails: number };
    candidates: number;
    relaxed: {
      guardrails: boolean;
      lru: boolean;
    };
    sampleIds: string[];
    reason: string[];
  };
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export function pickDailyItems(opts: PickerOptions): PickerResult {
  const {
    userId,
    timezone = "UTC",
    tier,
    items,
    lru = [],
    count = 1,
    filters = {},
    lastSelected = null,
    avoid = { repeatSkill: true, repeatTopic: true, repeatFormat: true },
  } = opts;

  const dateStr = toYmd(opts.date, timezone);
  const seed = dailySeed(userId, dateStr);
  const seedInt = hash32(seed);
  const rng = mulberry32(seedInt);

  const reason: string[] = [];

  // 1) Base sanitization and inactive removal
  const inactiveRemoved = items.filter((it) => it && (it.active ?? true));
  const numInactive = items.length - inactiveRemoved.length;

  // 2) Tier gating
  const tierOk = inactiveRemoved.filter((it) => allowedByTier(it, tier));
  const numTier = inactiveRemoved.length - tierOk.length;

  // 3) Apply user filters
  const filtered = applyFilters(tierOk, filters);

  // 4) LRU exclusion
  const lruSet = new Set(lru);
  const afterLru = filtered.filter((it) => !lruSet.has(it.id));
  let lruExcluded = filtered.length - afterLru.length;

  // 5) Guardrails
  const guard = normalizeAvoid(avoid);
  let afterGuard = applyGuardrails(afterLru, lastSelected, guard);
  let guardExcluded = afterLru.length - afterGuard.length;

  reason.push(`seeded for ${userId} on ${dateStr} (${timezone})`);

  // Relaxation if empty
  let relaxedGuard = false;
  let relaxedLru = false;

  if (afterGuard.length === 0 && afterLru.length > 0) {
    afterGuard = afterLru;
    guardExcluded = 0;
    relaxedGuard = true;
    reason.push("relaxed guardrails due to empty candidate set");
  }
  if (afterGuard.length === 0 && filtered.length > 0) {
    afterGuard = filtered;
    lruExcluded = 0;
    relaxedLru = true;
    reason.push("relaxed LRU due to empty candidate set");
  }
  if (afterGuard.length === 0) {
    afterGuard = tierOk;
    reason.push("fallback to tier-only candidates");
  }

  const taken = takeDeterministic(afterGuard, count, rng);

  return {
    items: taken,
    meta: {
      rng: "mulberry32",
      seed,
      seedInt,
      userId,
      date: dateStr,
      appliedFilters: {
        coach: filters.coach ?? [],
        topic: filters.topic ?? [],
        skill: filters.skill ?? [],
        format: filters.format ?? [],
        difficultyMin: filters.difficultyMin ?? 1,
        difficultyMax: filters.difficultyMax ?? 5,
        language: filters.language ?? "",
      },
      excluded: {
        lru: lruExcluded,
        inactive: numInactive,
        gatedByTier: numTier,
        guardrails: guardExcluded,
      },
      candidates: afterGuard.length,
      relaxed: { guardrails: relaxedGuard, lru: relaxedLru },
      sampleIds: afterGuard.slice(0, 10).map((i) => i.id),
      reason,
    },
  };
}

/** Seed as `${userId}:${YYYY-MM-DD}` to guarantee a stable daily pick per user. */
export function dailySeed(userId: string, ymd: string): string {
  return `${String(userId)}:${ymd}`;
}

// ---------------------------------------------------------------------
// Filtering and guardrails
// ---------------------------------------------------------------------

function applyFilters(items: CatalogItem[], f: PickerFilters): CatalogItem[] {
  const coachSet = f.coach ? new Set(f.coach) : null;
  const topicSet = f.topic ? new Set(f.topic.map((s) => s.toLowerCase())) : null;
  const skillSet = f.skill ? new Set(f.skill.map((s) => s.toLowerCase())) : null;
  const formatSet = f.format ? new Set(f.format.map((s) => s.toLowerCase())) : null;
  const min = f.difficultyMin ?? 1;
  const max = f.difficultyMax ?? 5;
  const lang = f.language?.toLowerCase();

  return items.filter((it) => {
    if (coachSet && !coachSet.has(it.coach)) return false;
    if (topicSet && it.topic && !topicSet.has(it.topic.toLowerCase())) return false;
    if (skillSet && it.skill && !skillSet.has(it.skill.toLowerCase())) return false;
    if (formatSet && it.format && !formatSet.has(String(it.format).toLowerCase())) return false;
    if (it.difficulty && (it.difficulty < min || it.difficulty > max)) return false;
    if (lang && it.language && it.language.toLowerCase() !== lang) return false;
    return true;
  });
}

function normalizeAvoid(a?: PickerOptions["avoid"]): Required<NonNullable<PickerOptions["avoid"]>> {
  return {
    repeatSkill: a?.repeatSkill ?? true,
    repeatTopic: a?.repeatTopic ?? true,
    repeatFormat: a?.repeatFormat ?? true,
  } as const;
}

function applyGuardrails(items: CatalogItem[], last: CatalogItem | null, avoid: ReturnType<typeof normalizeAvoid>): CatalogItem[] {
  if (!last) return items.slice();
  const lastSkill = last.skill?.toLowerCase();
  const lastTopic = last.topic?.toLowerCase();
  const lastFormat = String(last.format ?? "").toLowerCase();

  return items.filter((it) => {
    if (avoid.repeatSkill && lastSkill && it.skill && it.skill.toLowerCase() === lastSkill) return false;
    if (avoid.repeatTopic && lastTopic && it.topic && it.topic.toLowerCase() === lastTopic) return false;
    if (avoid.repeatFormat && lastFormat && it.format && String(it.format).toLowerCase() === lastFormat) return false;
    return true;
  });
}

/** Tag-based tier gating. Use tags: "pro_only", "vip_only". */
function allowedByTier(it: CatalogItem, tier: Tier): boolean {
  const tags = new Set((it.tags || []).map((t) => t.toLowerCase()));
  if (tags.has("vip_only") && tier !== Tier.VIP) return false;
  if (tags.has("pro_only") && tier === Tier.FREE) return false;
  return true;
}

// ---------------------------------------------------------------------
// Deterministic selection
// ---------------------------------------------------------------------

function takeDeterministic<T>(arr: T[], n: number, rng: () => number): T[] {
  if (n <= 0) return [];
  if (arr.length <= n) return arr.slice();
  const cloned = arr.slice();
  shuffleInPlace(cloned, rng);
  return cloned.slice(0, n);
}

function shuffleInPlace<T>(a: T[], rng: () => number): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ---------------------------------------------------------------------
// RNG and hashing
// ---------------------------------------------------------------------

/** 32-bit hash of a string. */
export function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
    h >>>= 0;
  }
  return h >>> 0;
}

/** Mulberry32 PRNG. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------

export function toYmd(d?: Date | string, timezone?: string): string {
  return formatYmdInTimezone(d, timezone);
}
