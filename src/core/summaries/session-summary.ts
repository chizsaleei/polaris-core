// src/core/summaries/session-summary.ts
/**
 * Polaris Core - Session summary builder
 *
 * Inputs: raw model feedback, user transcript, and extracted expression lines
 * Outputs: normalized summary for storage and weekly recap
 *
 * Design goals
 * - Pure and dependency free
 * - Deduplicate expressions per session and against a provided LRU/library set
 * - Flag risky items for private-only use
 * - Produce spaced review due dates at 1d, 3d, 7d, 14d
 */

import { SPACED_REVIEW_DAYS, DISCLAIMERS } from "../../lib/constants";
import type {
  CoachKey,
  SessionDomain,
  SessionSummary,
  SessionSummaryFeedback,
  SessionSummaryExpressionItem,
  SessionSummaryExpressionsPack,
} from "../../types";

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export interface SessionInput {
  sessionId: string;
  userId: string;
  coach: CoachKey;
  rubricId?: string; // caller can set, do not enforce here
  domain?: SessionDomain;
  minutesUsed?: number;
  // Optional raw content
  transcript?: string; // full transcript text
  userText?: string; // user final answer text
  modelText?: string; // model reply text
  // Model feedback, if already available
  feedback?: {
    wins?: string[]; // 3 wins
    fixes?: string[]; // 2 fixes
    next?: string; // 1 next prompt
  };
  // Raw expressions collected during the run
  expressionsRaw?: string[];
  // Reference set of normalized expressions that already exist in the user's library
  existingNormalized?: string[];
  // Session metrics
  metrics?: {
    wpm?: number;
    clarity?: number; // 0..100
    taskSuccess?: number; // 0..100
  };
  // Safety signals from upstream, optional
  safetyFlags?: string[]; // keywords found, model flags, etc
  now?: Date | string; // override clock in tests
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export function buildSessionSummary(input: SessionInput): SessionSummary {
  const now = toDate(input.now);
  const createdAt = now.toISOString();

  const domain = input.domain || inferDomain(input.rubricId, input.coach);
  const minutesUsed = clampNum(input.minutesUsed, 1, 120, 12); // guaranteed number due to overload

  const feedback = normalizeFeedback(input.feedback, input.modelText, input.userText);

  const expressions = buildExpressionsPack({
    raw: input.expressionsRaw || [],
    now,
    existingNormalized: new Set((input.existingNormalized || []).map((s) => normalizeLine(s))),
    safetyFlags: input.safetyFlags || [],
  });

  const { disclaimerShown, disclaimerText } = buildDisclaimer(domain);

  return {
    sessionId: input.sessionId,
    userId: input.userId,
    coach: input.coach,
    rubricId: input.rubricId,
    domain,
    minutesUsed,
    transcript: trimOpt(input.transcript),
    userText: trimOpt(input.userText),
    modelText: trimOpt(input.modelText),
    feedback,
    expressions,
    metrics: sanitizeMetrics(input.metrics),
    disclaimerShown,
    disclaimerText,
    createdAt,
  };
}

// ---------------------------------------------------------------------
// Expressions pack
// ---------------------------------------------------------------------

export function buildExpressionsPack(args: {
  raw: string[];
  now: Date;
  existingNormalized: Set<string>;
  safetyFlags: string[];
}): SessionSummaryExpressionsPack {
  const { raw, now, existingNormalized, safetyFlags } = args;

  const seen = new Set<string>();
  const items: SessionSummaryExpressionItem[] = [];
  let duplicates = 0;
  let risky = 0;

  for (const line of raw) {
    const norm = normalizeLine(line);
    if (!norm) continue;

    // de-dupe inside this pack
    if (seen.has(norm)) {
      duplicates++;
      continue;
    }

    // de-dupe against library
    if (existingNormalized.has(norm)) {
      duplicates++;
      continue;
    }

    const isRisky =
      isRiskyLine(norm) ||
      safetyFlags.some((f) => norm.includes(String(f).toLowerCase()));
    if (isRisky) risky++;

    const id = hashId(`expr:${norm}`);
    const addedAt = now.toISOString();
    const reviewDueAt = spacedDueDates(now);

    items.push({
      id,
      text: toSentenceCase(norm),
      normalized: norm,
      tags: [],
      risky: isRisky,
      publishable: !isRisky,
      addedAt,
      reviewDueAt,
    });

    seen.add(norm);
  }

  return {
    items,
    counts: { total: raw.length, added: items.length, duplicates, risky },
  };
}

function normalizeLine(s?: string): string {
  if (!s) return "";
  // basic normalization
  let t = String(s)
    .replace(/\s+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
  // remove trailing punctuation except meaningful marks
  t = t.replace(/[\s.,;:!?]+$/g, "");
  // collapse spaces before punctuation
  t = t.replace(/\s+([.,;:!?])/g, "$1");
  // avoid overlong lines
  if (t.length > 280) t = t.slice(0, 280);
  return t.toLowerCase();
}

function toSentenceCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function isRiskyLine(norm: string): boolean {
  const riskyTerms = [
    // medical
    "mg",
    "dose",
    "dosing",
    "prescribe",
    "prescription",
    "units insulin",
    "chemotherapy",
    // finance
    "guaranteed return",
    "sure profit",
    "insider",
    "front run",
    "ponzi",
  ];
  return riskyTerms.some((t) => norm.includes(t));
}

function spacedDueDates(start: Date): string[] {
  // 1d, 3d, 7d, 14d (shared ladder)
  return SPACED_REVIEW_DAYS.map((d) => addDaysIso(start, d));
}

// ---------------------------------------------------------------------
// Feedback normalizer
// ---------------------------------------------------------------------

function normalizeFeedback(
  fb: SessionInput["feedback"],
  modelText?: string,
  userText?: string,
): SessionSummaryFeedback {
  const wins = clampArr(cleanList(fb?.wins) || inferWins(modelText, userText), 3);
  const fixes = clampArr(cleanList(fb?.fixes) || inferFixes(modelText, userText), 2);

  // Ensure next is always a string
  const rawNext =
    fb?.next ?? inferNext(modelText, userText) ?? "One more like this on a new topic.";
  const next = singleLine(rawNext) || "One more like this on a new topic.";

  return { wins, fixes, next };
}

function cleanList(v?: string[]): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .map((s) => singleLine(s))
    .filter(Boolean)
    .map((s) => toSentenceCase(s!));
  return out.length ? out : undefined;
}

function singleLine(s?: string): string | undefined {
  if (!s) return undefined;
  const t = String(s).replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > 220 ? t.slice(0, 220) : t;
}

function clampArr(arr: string[], max: number): string[] {
  return arr.slice(0, max);
}

function inferWins(modelText?: string, userText?: string): string[] {
  const src = [modelText, userText].filter(Boolean).join(" \n ").toLowerCase();
  const wins: string[] = [];
  if (/structure|peel|star|sbar|isbar/.test(src)) {
    wins.push("Good structure with a clear framework");
  }
  if (/clarity|clear|coherent|concise/.test(src)) {
    wins.push("Clear and concise delivery");
  }
  if (/example|number|data|percent|%/.test(src)) {
    wins.push("Used a concrete example or number");
  }
  if (!wins.length) {
    wins.push("Stayed on task and completed within time");
  }
  return wins;
}

function inferFixes(modelText?: string, userText?: string): string[] {
  const src = [modelText, userText].filter(Boolean).join(" \n ").toLowerCase();
  const fixes: string[] = [];
  if (/filler|um|uh/.test(src)) {
    fixes.push("Reduce fillers and add a short pause");
  }
  if (/pronunciation|stress/.test(src)) {
    fixes.push("Improve word stress on key terms");
  }
  if (/detail|support|evidence/.test(src)) {
    fixes.push("Add one stronger supporting detail");
  }
  if (!fixes.length) {
    fixes.push("Tighten transitions between points");
  }
  return fixes;
}

function inferNext(modelText?: string, userText?: string): string | undefined {
  const src = [modelText, userText].filter(Boolean).join(" \n ").toLowerCase();
  if (/ielts|toefl/.test(src)) return "Try an IELTS Part 2 card with two follow ups";
  if (/interview|star/.test(src)) return "Run a two minute STAR story on a new scenario";
  if (/sbar|soap/.test(src)) return "Present a new SBAR case with one rule in and rule out";
  return undefined;
}

// ---------------------------------------------------------------------
// Disclaimer helpers
// ---------------------------------------------------------------------

function buildDisclaimer(domain: SessionSummary["domain"]) {
  if (domain === "medical") {
    return {
      disclaimerShown: true,
      disclaimerText: DISCLAIMERS.MEDICAL,
    } as const;
  }
  if (domain === "finance") {
    return {
      disclaimerShown: true,
      disclaimerText: DISCLAIMERS.FINANCE,
    } as const;
  }
  return { disclaimerShown: false, disclaimerText: undefined } as const;
}

function inferDomain(
  rubricId?: string,
  coach?: CoachKey,
): SessionSummary["domain"] {
  const s = `${rubricId || ""}|${coach || ""}`.toLowerCase();
  if (/medical|sbar|soap|physician|icu|osce/.test(s)) return "medical";
  if (/finance|portfolio|market|cfa|frm/.test(s)) return "finance";
  return "general";
}

// ---------------------------------------------------------------------
// Metrics and utilities
// ---------------------------------------------------------------------

type NumericInput = number | string | null | undefined;

function sanitizeMetrics(m?: SessionInput["metrics"]): SessionSummary["metrics"] {
  const out: SessionSummary["metrics"] = {};

  const wpm = clampNum(m?.wpm, 40, 220);
  if (wpm !== undefined) out.wpm = wpm;

  const clarity = clampNum(m?.clarity, 0, 100);
  if (clarity !== undefined) out.clarity = clarity;

  const taskSuccess = clampNum(m?.taskSuccess, 0, 100);
  if (taskSuccess !== undefined) out.taskSuccess = taskSuccess;

  return out;
}

// Overloads ensure precise typing of return value
function clampNum(v: NumericInput, min: number, max: number, d: number): number;
function clampNum(
  v: NumericInput,
  min: number,
  max: number,
  d?: undefined,
): number | undefined;
function clampNum(
  v: NumericInput,
  min: number,
  max: number,
  d?: number,
): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.max(min, Math.min(max, n));
}

function trimOpt(s?: string): string | undefined {
  if (!s) return undefined;
  const t = String(s).trim();
  return t ? t : undefined;
}

function toDate(d?: Date | string): Date {
  if (d instanceof Date) return d;
  return d ? new Date(d) : new Date();
}

function addDaysIso(from: Date, days: number): string {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function hashId(s: string): string {
  const h = hash32(s);
  return `sp_${h.toString(16).padStart(8, "0")}`;
}

// 32-bit hash (mulberry32 inspired one-pass)
export function hash32(str: string): number {
  let t = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    t ^= str.charCodeAt(i);
    t = Math.imul(t, 0x01000193);
    t >>>= 0;
  }
  return t >>> 0;
}
