/**
 * Polaris Grading Endpoint
 *
 * Accepts a session transcript and optional drill metadata, runs the grading prompt,
 * and persists the structured feedback + expressions according to grading.md.
 *
 * Request (JSON):
 * {
 *   session_id: string; // required
 *   drill_id?: string;
 *   coach_key?: string; // defaults from session or drill
 *   transcript: string; // learner answer plain text
 *   rubric_id?: string;
 *   band_target?: string;
 *   metadata?: { duration_sec?: number; words?: number; wpm?: number }
 * }
 *
 * Response:
 * {
 *   ok: true,
 *   data: {
 *     wins: string[],
 *     fixes: string[],
 *     next_prompt: string,
 *     rubric: Record<string, number>,
 *     expressions: Array<ExpressionItem>,
 *     modelAnswer?: string,
 *     attempt_id?: string
 *   }
 * }
 */

import { Router, type Request, type Response } from "express";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import { gradingInstruction } from "../../../core/prompts";
import {
  defaultRubricForCoach,
  scoreRubric,
  type Rubric,
  type CoachKey as RubricCoachKey,
} from "../../../core/scoring/rubric";
import type { ExpressionItem } from "../../../types";
import { chat } from "../../../lib/openai";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type RequestWithUser = Request & { user?: { id?: string | null } };

router.post("/", (req: Request, res: Response) => {
  const request = req as RequestWithUser;
  const contextUserId = readUserId(request.user?.id) ?? readUserId(req.header("x-user-id"));

  void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
    try {
      const userId = contextUserId ?? readUserId(req.header("x-user-id"));
      if (!userId) return sendError(res, 401, "unauthorized", "Missing user id.");

      const payload = sanitizePayload(req.body);
      const issues = validatePayload(payload);
      if (issues.length) return sendError(res, 400, "invalid_payload", issues.join(" | "));

      const supabase = createClient();
      const session = await fetchSession(supabase, payload.sessionId);
      if (!session) return sendError(res, 404, "session_not_found", "Session not found.");
      if (session.user_id !== userId) return sendError(res, 403, "forbidden", "Session does not belong to user.");

      const drillId = payload.drillId ?? session.drill_id ?? null;
      const drill = drillId ? await fetchDrill(supabase, drillId) : null;
      const coachKey = normalizeCoach(payload.coachKey ?? session.coach_key ?? drill?.coach_key);

      const rubricId = payload.rubricId ?? drill?.rubric_id ?? defaultRubricIdForCoach(coachKey);
      const bandTarget = payload.bandTarget ?? drill?.band_target ?? undefined;

      const gradingPrompt = gradingInstruction(rubricId, bandTarget);
      const modelResponse = await runGrader({
        prompt: gradingPrompt.system,
        answer: payload.transcript,
        settings: gradingPrompt.settings,
      });

      const evaluation = normalizeEvaluation(modelResponse, coachKey);
      const attemptId = await storeGradingResult(supabase, {
        session,
        drillId,
        userId,
        payload,
        evaluation,
      });

      return res.status(200).json({
        ok: true,
        data: {
          wins: evaluation.wins,
          fixes: evaluation.fixes,
          next_prompt: evaluation.nextPrompt,
          rubric: evaluation.rubric,
          expressions: evaluation.expressions,
          model_answer: evaluation.modelAnswer,
          attempt_id: attemptId,
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      const httpError = parseHttpError(error, "Grading failed.");
      if (httpError.status >= 500) log.error("grading/grade error", { err: safeError(error) });
      return sendError(res, httpError.status, httpError.code, httpError.message);
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Data fetching / persistence
// -----------------------------------------------------------------------------

interface SessionRow {
  id: string;
  user_id: string;
  drill_id?: string | null;
  coach_key?: string | null;
  status?: string | null;
}

interface DrillRow {
  id: string;
  coach_key?: string | null;
  rubric_id?: string | null;
  band_target?: string | null;
}

async function fetchSession(supabase: Supabase, sessionId: string): Promise<SessionRow | null> {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, user_id, drill_id, coach_key, status")
    .eq("id", sessionId)
    .maybeSingle<Record<string, unknown>>();

  if (error) handleDbError("fetch_session", error);
  const record = toRecord(data);
  if (!record) return null;
  const id = readNullableString(record.id);
  const userId = readNullableString(record.user_id);
  if (!id || !userId) return null;
  return {
    id,
    user_id: userId,
    drill_id: readNullableString(record.drill_id),
    coach_key: readNullableString(record.coach_key),
    status: readNullableString(record.status),
  };
}

async function fetchDrill(supabase: Supabase, drillId: string): Promise<DrillRow | null> {
  const { data, error } = await supabase
    .from("drills")
    .select("id, coach_key, rubric_id, band_target")
    .eq("id", drillId)
    .maybeSingle<Record<string, unknown>>();
  if (error && !isMissingRelation(error)) handleDbError("fetch_drill", error);
  const record = toRecord(data);
  if (!record) return null;
  const id = readNullableString(record.id);
  if (!id) return null;
  return {
    id,
    coach_key: readNullableString(record.coach_key),
    rubric_id: readNullableString(record.rubric_id),
    band_target: readNullableString(record.band_target),
  };
}

async function storeGradingResult(
  supabase: Supabase,
  input: {
    session: SessionRow;
    drillId: string | null;
    userId: string;
    payload: GradePayload;
    evaluation: EvaluationResult;
  },
) {
  const now = new Date().toISOString();
  const attempts: Array<Record<string, unknown>> = [
    {
      session_id: input.session.id,
      user_id: input.userId,
      drill_id: input.drillId,
      coach_key: normalizeCoach(input.session.coach_key),
      transcript_text: input.payload.transcript,
      answer_text: input.payload.transcript,
      rubric_json: input.evaluation.rubric,
      wins: input.evaluation.wins,
      fixes: input.evaluation.fixes,
      next_prompt: input.evaluation.nextPrompt,
      expressions: input.evaluation.expressions,
      score: input.evaluation.rubric.overall,
      created_at: now,
    },
  ];

  for (const row of attempts) {
    try {
      const { data, error } = await supabase
        .from("attempts")
        .insert(row)
        .select("id")
        .maybeSingle<{ id: string }>();
      const record = toRecord(data);
      if (!error && record && typeof record.id === "string") return record.id;
      if (error) {
        if (isMissingRelation(error) || isMissingColumnError(error)) continue;
        handleDbError("insert_attempt", error);
      }
    } catch (attemptError) {
      if (isMissingRelation(attemptError) || isMissingColumnError(attemptError)) continue;
      throw attemptError;
    }
  }

  return undefined;
}

// -----------------------------------------------------------------------------
// Grading helpers
// -----------------------------------------------------------------------------

interface EvaluationResult {
  modelAnswer?: string;
  wins: string[];
  fixes: string[];
  nextPrompt: string;
  expressions: ExpressionItem[];
  rubric: Record<string, number>;
}

async function runGrader(input: {
  prompt: string;
  answer: string;
  settings: { temperature?: number; maxOutputTokens?: number };
}): Promise<Record<string, unknown>> {
  const messages = [
    { role: "system" as const, content: input.prompt },
    { role: "user" as const, content: input.answer },
  ];

  const result = await chat({
    messages,
    system: input.prompt,
    temperature: input.settings.temperature ?? 0.1,
    maxTokens: input.settings.maxOutputTokens ?? 400,
  });

  const text = result.text?.trim();
  if (!text) throw makeHttpError(502, "grader_no_output", "Grader returned no text.");
  return parseGradingJson(text);
}

function parseGradingJson(text: string): Record<string, unknown> {
  const jsonMatch = text.match(/\{[\s\S]*\}$/m);
  const body = jsonMatch ? jsonMatch[0] : text;
  try {
    const parsed: unknown = JSON.parse(body);
    const record = toRecord(parsed);
    if (!record) throw new Error("grader json not object");
    return record;
  } catch {
    log.warn("grading/grade invalid JSON", { text });
    throw makeHttpError(502, "grader_invalid_json", "Grader returned invalid JSON.");
  }
}

function normalizeEvaluation(raw: Record<string, unknown>, coachKey: string | null): EvaluationResult {
  const wins = toStrArray(raw.wins).slice(0, 3);
  const fixes = toStrArray(raw.fixes).slice(0, 2);
  const nextPrompt =
    firstString(raw.nextPrompt ?? raw.next_prompt ?? raw.next) || "Run the drill again with one new detail.";
  const pack = toRecord(raw.pack);
  const expressionCandidates = Array.isArray(raw.expressions)
    ? raw.expressions
    : Array.isArray(pack?.expressions)
      ? (pack?.expressions as unknown[])
      : [];
  const expressions = normalizeExpressions(expressionCandidates);

  const rubricSource = toRecord(raw.rubric) ?? {};
  const rubric = normalizeRubric(coachKey, rubricSource);
  const modelAnswer = firstString(raw.modelAnswer ?? raw.model_answer ?? raw.answer);

  return { wins, fixes, nextPrompt, expressions, rubric, modelAnswer: modelAnswer ?? undefined };
}

function normalizeExpressions(items: unknown[]): ExpressionItem[] {
  if (!Array.isArray(items)) return [];
  const out: ExpressionItem[] = [];
  for (const entry of items) {
    const record = toRecord(entry);
    if (!record) continue;
    const original = firstString(record.text_original ?? record.original) || "";
    const upgraded = firstString(record.text_upgraded ?? record.upgrade) || "";
    if (!original || !upgraded) continue;
    const pronunciationRecord = toRecord(record.pronunciation);
    const pronunciation =
      pronunciationRecord && typeof pronunciationRecord.word === "string"
        ? {
            word: pronunciationRecord.word,
            hint: firstString(pronunciationRecord.hint) || "",
          }
        : undefined;
    out.push({
      text_original: original,
      text_upgraded: upgraded,
      collocations: toStrArray(record.collocations ?? record.phrases).slice(0, 4),
      pronunciation,
      examples: toStrArray(record.examples).slice(0, 2),
    });
  }
  return out;
}

function normalizeRubric(coachKey: string | null, rubricData: Record<string, unknown>) {
  const rubric: Record<string, number> = {};
  // grading/scoring uses underscore CoachKey, so ensure underscore format and type it from the rubric module
  const fallback: RubricCoachKey = "chelsea_lightbown";
  const underscoreKey = coachKey ? coachKey : fallback;
  const coach = (underscoreKey ?? fallback) as RubricCoachKey;

  const template: Rubric = defaultRubricForCoach(coach);
  const evidence: Record<string, number> = {};
  template.criteria.forEach((criterion) => {
    const key = criterion.id;
    const val = toNumber(rubricData?.[key]);
    evidence[key] = typeof val === "number" && Number.isFinite(val) ? val / 5 : 0.6;
  });
  const scored = scoreRubric(template, evidence);
  scored.criteria.forEach((crit) => {
    rubric[crit.id] = Math.round(crit.raw * 5);
  });
  rubric.overall = Math.round(scored.total * 100);
  return rubric;
}

function defaultRubricIdForCoach(coach?: string | null) {
  if (!coach) return undefined;
  const key = coach.replace(/_/g, "-");
  const map: Record<string, string> = {
    "carter-goleman": "interview_star_v1",
    "chase-krashen": "academic_peel_v1",
    "chelsea-lightbown": "ielts_speaking_v1",
    "clark-atul": "medical_sbar_v1",
    "crystal-benner": "nursing_isbar_v1",
    "christopher-buffett": "finance_client_v1",
    "colton-covey": "leadership_business_v1",
    "cody-turing": "technical_incident_arch_v1",
    "chloe-sinek": "personal_values_v1",
  };
  return map[key] ?? "speaking_general_v1";
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

interface GradePayload {
  sessionId: string;
  drillId?: string;
  coachKey?: string;
  transcript: string;
  rubricId?: string;
  bandTarget?: string;
  metadata?: {
    durationSec?: number;
    words?: number;
    wpm?: number;
  };
}

function sanitizePayload(body: unknown): GradePayload {
  const source = toRecord(body) ?? {};
  const sessionId = firstString(source.session_id ?? source.sessionId ?? source.session);
  const drillId = firstString(source.drill_id ?? source.drillId ?? source.drill);
  const coachKey = firstString(source.coach_key ?? source.coachKey ?? source.coach);
  const transcript = sanitizeText(source.transcript ?? source.answer ?? source.text);
  const rubricId = firstString(source.rubric_id ?? source.rubricId);
  const bandTarget = firstString(source.band_target ?? source.bandTarget);
  const metadata = sanitizeMetadata(source.metadata ?? source.metrics);
  return { sessionId: sessionId || "", drillId, coachKey, transcript, rubricId, bandTarget, metadata };
}

function validatePayload(payload: GradePayload) {
  const issues: string[] = [];
  if (!payload.sessionId || !isUuid(payload.sessionId)) issues.push("session_id is required");
  if (!payload.transcript) issues.push("transcript is required");
  if (payload.drillId && !isUuid(payload.drillId)) issues.push("drill_id must be a UUID");
  return issues;
}

function sanitizeMetadata(meta: unknown) {
  const source = toRecord(meta);
  if (!source) return undefined;
  const durationSec = toNumber(source.duration_sec ?? source.durationSec);
  const words = toNumber(source.words);
  const wpm = toNumber(source.wpm ?? source.words_per_minute);
  return {
    durationSec: typeof durationSec === "number" && Number.isFinite(durationSec) ? durationSec : undefined,
    words: typeof words === "number" && Number.isFinite(words) ? words : undefined,
    wpm: typeof wpm === "number" && Number.isFinite(wpm) ? wpm : undefined,
  };
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  });
}

function makeHttpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

interface HttpErrorShape {
  status: number;
  code: string;
  message: string;
}

function parseHttpError(error: unknown, fallbackMessage: string): HttpErrorShape {
  const fallback: HttpErrorShape = { status: 500, code: "internal_error", message: fallbackMessage };
  const record = toRecord(error);
  if (!record) return fallback;
  const status = typeof record.status === "number" ? record.status : fallback.status;
  const code = typeof record.code === "string" && record.code ? record.code : fallback.code;
  if (status === 500) return { status, code, message: fallback.message };
  const message = readErrorMessage(record) || fallback.message;
  return { status, code, message };
}

function handleDbError(label: string, error: unknown) {
  log.error(`grading/grade ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const str = firstString(entry);
      if (str) return str;
    }
    return undefined;
  }
  if (value == null) return undefined;
  if (typeof value === "string") {
    const str = value.trim();
    return str.length ? str : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  return undefined;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sanitizeText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 6000);
}

// normalize to underscore for grading/scoring keys
function normalizeCoach(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/-/g, "_");
}

function toStrArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => firstString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function toNumber(value: unknown) {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

// Accept unknown so try/catch `error` can be passed without casts
function isMissingRelation(error: unknown) {
  const msg = readErrorMessage(error).toLowerCase();
  return msg.includes("does not exist") || msg.includes("relation") || msg.includes("undefined table");
}

function isMissingColumnError(error: unknown) {
  const msg = readErrorMessage(error).toLowerCase();
  return msg.includes("column") && msg.includes("does not exist");
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return null;
}

function readNullableString(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function readErrorMessage(error: unknown): string {
  const record = toRecord(error);
  if (record && typeof record.message === "string") {
    return record.message;
  }
  return "";
}
