/**
 * Polaris Core — Rubric types, registry, and scoring helpers
 *
 * Updated to align with quiz-to-coach keys and coach defaults.
 * Adds coach→rubric mapping so onboarding and grading stay consistent.
 */

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

export type RubricId =
  | "speaking_general_v1"
  | "ielts_speaking_v1"
  | "interview_star_v1"
  | "medical_sbar_v1"
  | "nursing_isbar_v1"
  | "academic_peel_v1"
  | "admissions_research_pitch_v1"
  | "finance_client_v1"
  | "leadership_business_v1"
  | "technical_incident_arch_v1"
  | "personal_values_v1";

// Keep a local CoachKey to avoid import ordering issues
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

export interface RubricCriterionLevel {
  key: string; // e.g., "band7" or "good"
  label: string;
  score: number; // 0..1
  description?: string;
}

export interface RubricCriterion {
  id: string; // stable id for evidence map
  label: string;
  weight: number; // relative weight; normalized across criteria
  levels?: RubricCriterionLevel[]; // when absent, evidence must be numeric 0..1
  invert?: boolean; // lower is better when true (rare)
  hint?: string;
}

export interface RubricBandSpec {
  scale: "ielts_speaking" | "percent";
}

export interface Rubric {
  id: RubricId;
  title: string;
  description?: string;
  version?: string;
  criteria: RubricCriterion[];
  band?: RubricBandSpec;
}

export type EvidenceValue = number | string | undefined | null;
export type Evidence = Record<string, EvidenceValue>;

export interface CriterionScore {
  id: string;
  label: string;
  weight: number; // normalized weight
  raw: number; // 0..1
  weighted: number; // raw * weight
  chosenLevelKey?: string;
}

export interface RubricScore {
  total: number; // 0..1
  bandLabel?: string; // e.g., "IELTS 6.5" or "82%"
  bandValue?: number | string; // numeric band value when useful
  criteria: CriterionScore[];
}

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/** Score a rubric with evidence. Evidence can be a number 0..1 or a level key. */
export function scoreRubric(rubric: Rubric, evidence: Evidence, opts?: {
  taskSuccess?: number; // optional multiplier 0..1
  decimals?: number; // band formatting precision
}): RubricScore {
  const crits = normalizeWeights(rubric.criteria);
  const parts: CriterionScore[] = [];

  for (const c of crits) {
    const ev = evidence[c.id];
    const { raw, chosenLevelKey } = resolveEvidence(c, ev);
    const rawClamped = clamp01(c.invert ? 1 - raw : raw);
    const weighted = rawClamped * c.weight;
    parts.push({ id: c.id, label: c.label, weight: c.weight, raw: rawClamped, weighted, chosenLevelKey });
  }

  let total = parts.reduce((s, p) => s + p.weighted, 0);
  if (typeof opts?.taskSuccess === "number") total = clamp01(total * clamp01(opts.taskSuccess));

  const band = rubric.band?.scale || "percent";
  const decimals = Number.isFinite(opts?.decimals) ? Number(opts?.decimals) : 1;

  let bandLabel: string | undefined;
  let bandValue: number | string | undefined;

  if (band === "ielts_speaking") {
    const { label, value } = ieltsBandFromUnit(total);
    bandLabel = label;
    bandValue = value;
  } else {
    const pct = round(total * 100, decimals);
    bandLabel = `${pct}%`;
    bandValue = pct;
  }

  const rounded = parts.map((p) => ({ ...p, raw: round(p.raw, 3), weighted: round(p.weighted, 3) }));
  return { total: round(total, 3), bandLabel, bandValue, criteria: rounded };
}

export function getRubric(id: RubricId): Rubric | undefined {
  return RUBRICS[id];
}

export function listRubrics(): Rubric[] {
  return Object.values(RUBRICS);
}

// Coach→default rubric mapping for onboarding and grading
export const DEFAULT_COACH_RUBRIC: Record<CoachKey, RubricId> = {
  chase_krashen: "academic_peel_v1",
  dr_claire_swales: "admissions_research_pitch_v1",
  carter_goleman: "interview_star_v1",
  chelsea_lightbown: "ielts_speaking_v1",
  dr_clark_atul: "medical_sbar_v1",
  dr_crystal_benner: "nursing_isbar_v1",
  christopher_buffett: "finance_client_v1",
  colton_covey: "leadership_business_v1",
  cody_turing: "technical_incident_arch_v1",
  chloe_sinek: "personal_values_v1",
};

export function defaultRubricIdForCoach(coach: CoachKey): RubricId {
  return DEFAULT_COACH_RUBRIC[coach] || "speaking_general_v1";
}

export function defaultRubricForCoach(coach: CoachKey): Rubric {
  return RUBRICS[defaultRubricIdForCoach(coach)] || RUBRICS.speaking_general_v1;
}

// ---------------------------------------------------------------------
// Evidence resolution
// ---------------------------------------------------------------------

function resolveEvidence(c: RubricCriterion, v: EvidenceValue): { raw: number; chosenLevelKey?: string } {
  if (v == null) return { raw: 0 };
  if (typeof v === "number" && Number.isFinite(v)) return { raw: clamp01(v) };
  if (typeof v === "string" && c.levels && c.levels.length) {
    const key = v.trim().toLowerCase();
    const hit = c.levels.find((l) => l.key.toLowerCase() === key);
    if (hit) return { raw: clamp01(hit.score), chosenLevelKey: hit.key };
  }
  if (typeof v === "string" && c.levels && c.levels.length) {
    const lc = v.trim().toLowerCase();
    const hit = c.levels.find((l) => l.key.toLowerCase().includes(lc) || l.label.toLowerCase().includes(lc));
    if (hit) return { raw: clamp01(hit.score), chosenLevelKey: hit.key };
  }
  return { raw: 0 };
}

// ---------------------------------------------------------------------
// Weight normalization and helpers
// ---------------------------------------------------------------------

function normalizeWeights(criteria: RubricCriterion[]): RubricCriterion[] {
  const sum = criteria.reduce((s, c) => s + (Number.isFinite(c.weight) ? Math.max(0, c.weight) : 0), 0);
  if (sum <= 0) return criteria.map((c) => ({ ...c, weight: 1 / Math.max(1, criteria.length) }));
  return criteria.map((c) => ({ ...c, weight: (Math.max(0, c.weight) || 0) / sum }));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function round(v: number, dp = 2): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

// ---------------------------------------------------------------------
// Band helpers
// ---------------------------------------------------------------------

export function ieltsBandFromUnit(u: number): { value: number; label: string } {
  const raw = clamp01(u) * 9; // 0..9
  const half = Math.round(raw * 2) / 2; // nearest 0.5
  const value = Math.max(0, Math.min(9, half));
  return { value, label: `IELTS ${value}` };
}

// ---------------------------------------------------------------------
// Default registry
// ---------------------------------------------------------------------

export const RUBRICS: Record<RubricId, Rubric> = {
  // Generic
  speaking_general_v1: {
    id: "speaking_general_v1",
    title: "General Speaking Rubric v1",
    description: "Balanced weights for clarity, coherence, vocabulary, and task completion.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "clarity", label: "Clarity and pronunciation", weight: 0.25 },
      { id: "coherence", label: "Coherence and structure", weight: 0.25 },
      { id: "vocabulary", label: "Vocabulary and range", weight: 0.25 },
      { id: "task_completion", label: "Task completion", weight: 0.25 },
    ],
  },

  // IELTS
  ielts_speaking_v1: {
    id: "ielts_speaking_v1",
    title: "IELTS Speaking rubric v1",
    description: "Four official criteria mapped to 0..9 band.",
    version: "1",
    band: { scale: "ielts_speaking" },
    criteria: [
      {
        id: "fluency_coherence",
        label: "Fluency and coherence",
        weight: 0.3,
        levels: [
          { key: "band9", label: "Band 9", score: 1.0 },
          { key: "band8", label: "Band 8", score: 0.88 },
          { key: "band7", label: "Band 7", score: 0.77 },
          { key: "band6", label: "Band 6", score: 0.66 },
          { key: "band5", label: "Band 5", score: 0.55 },
          { key: "band4", label: "Band 4", score: 0.44 }
        ],
      },
      {
        id: "lexical_resource",
        label: "Lexical resource",
        weight: 0.25,
        levels: [
          { key: "band9", label: "Band 9", score: 1.0 },
          { key: "band8", label: "Band 8", score: 0.88 },
          { key: "band7", label: "Band 7", score: 0.77 },
          { key: "band6", label: "Band 6", score: 0.66 },
          { key: "band5", label: "Band 5", score: 0.55 },
          { key: "band4", label: "Band 4", score: 0.44 }
        ],
      },
      {
        id: "grammar_range_accuracy",
        label: "Grammatical range and accuracy",
        weight: 0.25,
        levels: [
          { key: "band9", label: "Band 9", score: 1.0 },
          { key: "band8", label: "Band 8", score: 0.88 },
          { key: "band7", label: "Band 7", score: 0.77 },
          { key: "band6", label: "Band 6", score: 0.66 },
          { key: "band5", label: "Band 5", score: 0.55 },
          { key: "band4", label: "Band 4", score: 0.44 }
        ],
      },
      {
        id: "pronunciation",
        label: "Pronunciation",
        weight: 0.2,
        levels: [
          { key: "band9", label: "Band 9", score: 1.0 },
          { key: "band8", label: "Band 8", score: 0.88 },
          { key: "band7", label: "Band 7", score: 0.77 },
          { key: "band6", label: "Band 6", score: 0.66 },
          { key: "band5", label: "Band 5", score: 0.55 },
          { key: "band4", label: "Band 4", score: 0.44 }
        ],
      },
    ],
  },

  // Interview
  interview_star_v1: {
    id: "interview_star_v1",
    title: "Interview STAR rubric v1",
    description: "Structure, impact, clarity, and role relevance.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "structure_star", label: "STAR structure", weight: 0.3 },
      { id: "impact", label: "Impact and metrics", weight: 0.3 },
      { id: "clarity", label: "Clarity and delivery", weight: 0.2 },
      { id: "relevance", label: "Role relevance", weight: 0.2 },
    ],
  },

  // Medical physician
  medical_sbar_v1: {
    id: "medical_sbar_v1",
    title: "Medical SBAR rubric v1",
    description: "Structured case talk with safety forward language.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "structure_sbar", label: "Structure SBAR or SOAP", weight: 0.3 },
      { id: "clinical_reasoning", label: "Clinical reasoning and differentials", weight: 0.3 },
      { id: "safety_language", label: "Safety language and handoff", weight: 0.2 },
      { id: "clarity", label: "Clarity and compassion", weight: 0.2 },
    ],
  },

  // Nursing
  nursing_isbar_v1: {
    id: "nursing_isbar_v1",
    title: "Nursing ISBAR rubric v1",
    description: "ISBAR structure, patient teaching, and safe escalation.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "structure_isbar", label: "ISBAR structure", weight: 0.3 },
      { id: "patient_teaching", label: "Layperson teaching and teach-back", weight: 0.3 },
      { id: "escalation_safety", label: "Escalation and safety language", weight: 0.2 },
      { id: "clarity", label: "Clarity and compassion", weight: 0.2 },
    ],
  },

  // Academic PEEL
  academic_peel_v1: {
    id: "academic_peel_v1",
    title: "Academic PEEL rubric v1",
    description: "Point, Evidence, Explain, Link with academic tone and timing.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "point_clarity", label: "Clear Point statement", weight: 0.25 },
      { id: "evidence_relevance", label: "Relevant Evidence with numbers", weight: 0.25 },
      { id: "explain_depth", label: "Explain depth and logic", weight: 0.25 },
      { id: "linking_cohesion", label: "Linking and cohesion", weight: 0.25 },
    ],
  },

  // Graduate admissions research pitch
  admissions_research_pitch_v1: {
    id: "admissions_research_pitch_v1",
    title: "Research pitch rubric v1",
    description: "Motivation, question, method, impact, and program fit.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "motivation_clarity", label: "Motivation clarity", weight: 0.2 },
      { id: "question_focus", label: "Focused research question", weight: 0.25 },
      { id: "method_clarity", label: "Method clarity for non-experts", weight: 0.2 },
      { id: "impact_framing", label: "Impact and contribution framing", weight: 0.2 },
      { id: "fit_to_program", label: "Fit to target lab or program", weight: 0.15 },
    ],
  },

  // Finance client
  finance_client_v1: {
    id: "finance_client_v1",
    title: "Finance client communication rubric v1",
    description: "Plain English, numbers, risk, and suitability.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "plain_english", label: "Plain English explanations", weight: 0.25 },
      { id: "numbers_kpis", label: "Numbers and KPIs", weight: 0.25 },
      { id: "risk_mitigation", label: "Risk and mitigation", weight: 0.25 },
      { id: "client_alignment", label: "Client alignment and suitability", weight: 0.25 },
    ],
  },

  // Leadership business
  leadership_business_v1: {
    id: "leadership_business_v1",
    title: "Leadership and business communication rubric v1",
    description: "Executive clarity, structure, persuasion, and next steps.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "exec_clarity", label: "Executive clarity", weight: 0.25 },
      { id: "structure", label: "Structure and flow", weight: 0.25 },
      { id: "persuasion", label: "Persuasion and framing", weight: 0.25 },
      { id: "next_steps", label: "Concrete next steps", weight: 0.25 },
    ],
  },

  // Technical incident and architecture
  technical_incident_arch_v1: {
    id: "technical_incident_arch_v1",
    title: "Technical incident and architecture rubric v1",
    description: "Accuracy under stress, clear architecture, tradeoffs, and incident voice.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "accuracy_under_stress", label: "Accuracy under stress", weight: 0.25 },
      { id: "architecture_clarity", label: "Architecture clarity", weight: 0.25 },
      { id: "tradeoffs", label: "Tradeoffs and constraints", weight: 0.25 },
      { id: "incident_voice", label: "Incident communication and metrics", weight: 0.25 },
    ],
  },

  // Personal development
  personal_values_v1: {
    id: "personal_values_v1",
    title: "Personal values and commitments rubric v1",
    description: "Values clarity, boundary language, actionability, and tone.",
    version: "1",
    band: { scale: "percent" },
    criteria: [
      { id: "values_clarity", label: "Values clarity", weight: 0.25 },
      { id: "boundary_language", label: "Boundary language", weight: 0.25 },
      { id: "actionability", label: "Actionability and time cue", weight: 0.25 },
      { id: "tone_empathy", label: "Tone and empathy", weight: 0.25 },
    ],
  },
};

// ---------------------------------------------------------------------
// Example usage (commented)
// ---------------------------------------------------------------------
/*
import { scoreRubric, defaultRubricForCoach } from "./rubric";

const rub = defaultRubricForCoach("chelsea_lightbown");
const evidence = {
  fluency_coherence: "band7",
  lexical_resource: "band6",
  grammar_range_accuracy: 0.7,
  pronunciation: "band6",
};
const res = scoreRubric(rub, evidence, { taskSuccess: 1 });
console.log(res.bandLabel, res.total, res.criteria);
*/
