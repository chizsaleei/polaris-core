// src/server/routes/drills/submit.ts
/**
 * Drill submission endpoint
 *
 * Validates the payload, ensures the session belongs to the caller, generates lightweight
 * heuristic feedback, records an attempt (best-effort to match schema variants),
 * and finishes the session via rpc_finish_session so minutes usage is tracked.
 *
 * Request body shape (flexible casing):
 *   {
 *     session_id: string; // required
 *     drill_id?: string;
 *     answer: string; // required plain text transcript
 *     transcript?: string; // optional longer transcript
 *     attachments?: string[]; // optional audio/file urls
 *     metadata?: {
 *       duration_sec?: number;
 *       words?: number;
 *       wpm?: number;
 *     }
 *   }
 */

import { Router, type Request, type Response } from "express";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();
type Supabase = ReturnType<typeof createClient>;

type RequestWithUser = Request & { user?: { id?: string | null } };

interface SessionRow {
  id: string;
  user_id: string;
  status: string | null;
  coach_key: string | null;
  assignment_id: string | null;
}

router.post("/", (req: Request, res: Response) => {
  const request = req as RequestWithUser;
  const contextUserId = readUserId(request.user?.id) ?? readUserId(req.header("x-user-id"));

  void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
    try {
      const userId = contextUserId ?? readUserId(req.header("x-user-id"));
      if (!userId) {
        return sendError(res, 401, "unauthorized", "Missing user id.");
      }

      const payload = sanitizePayload(req.body);
      if (!payload.sessionId || !isUuid(payload.sessionId)) {
        return sendError(res, 400, "invalid_session", "session_id is required and must be a UUID.");
      }
      if (!payload.answer) {
        return sendError(res, 400, "invalid_answer", "Answer text is required.");
      }

      const supabase = createClient();
      const session = await fetchSession(supabase, payload.sessionId);
      if (!session) {
        return sendError(res, 404, "session_not_found", "Session was not found.");
      }
      if (session.user_id !== userId) {
        return sendError(res, 403, "forbidden", "Session does not belong to the current user.");
      }
      if (session.status && session.status !== "started") {
        return sendError(res, 409, "already_completed", "Session is already completed.");
      }

      if (payload.drillId && !isUuid(payload.drillId)) {
        return sendError(res, 400, "invalid_drill", "drill_id must be a UUID when provided.");
      }

      const coachKey = normalizeCoachKey(session.coach_key);
      const evaluation = evaluateAnswer(payload.answer, coachKey, payload.words ?? wordCount(payload.answer));

      const attemptId = await recordAttempt(supabase, {
        session,
        payload,
        evaluation,
        userId,
      });

      await finishSession(supabase, {
        sessionId: payload.sessionId,
        score: evaluation.score,
        durationSec: payload.durationSec,
        wpm: payload.wpm,
      });

      return res.status(200).json({
        ok: true,
        data: {
          wins: evaluation.wins,
          fixes: evaluation.fixes,
          next_prompt: evaluation.nextPrompt,
          score: evaluation.score,
          rubric: evaluation.rubric,
          pack: evaluation.pack,
          attempt_id: attemptId,
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      log.error("drills/submit error", { err: safeError(error) });
      const httpError = parseHttpError(error, "Unable to submit drill.");
      return sendError(res, httpError.status, httpError.code, httpError.message);
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Data access
// -----------------------------------------------------------------------------

async function fetchSession(supabase: Supabase, sessionId: string): Promise<SessionRow | null> {
  const { data, error } = await supabase
    .from("sessions")
    .select("id, user_id, status, coach_key, coach_id, assignment_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (error && !isMissingRelation(error)) handleDbError("fetch_session", error);
  const record = toRecord(data);
  if (!record) return null;

  const id = readNullableString(record.id);
  const userId = readNullableString(record.user_id);
  if (!id || !userId) return null;

  return {
    id,
    user_id: userId,
    status: readNullableString(record.status),
    coach_key: normalizeCoachKey(readNullableString(record.coach_key) ?? readNullableString(record.coach_id)),
    assignment_id: readNullableString(record.assignment_id),
  };
}

async function recordAttempt(
  supabase: Supabase,
  input: {
    session: SessionRow;
    payload: SubmitPayload;
    evaluation: EvaluationResult;
    userId: string;
  },
): Promise<string | undefined> {
  const nowIso = new Date().toISOString();
  const attempts: Array<Record<string, unknown>> = [];

  // Candidate payload for modern attempts schema with assignment + metrics JSON
  if (input.session.assignment_id) {
    attempts.push({
      assignment_id: input.session.assignment_id,
      user_id: input.userId,
      coach_id: input.session.coach_key ?? null,
      session_id: input.session.id,
      drill_id: input.payload.drillId ?? null,
      started_at: nowIso,
      submitted_at: nowIso,
      duration_seconds: input.payload.durationSec,
      input_payload: {
        answer_preview: input.payload.answer.slice(0, 280),
        transcript: input.payload.transcript ? input.payload.transcript.slice(0, 2000) : undefined,
      },
      transcript: buildTranscriptPayload(input.payload),
      attachments: input.payload.attachments.length ? input.payload.attachments : undefined,
      metrics: sanitizeMetricsJson(input.payload),
      rubric_scores: input.evaluation.rubric,
      score: input.evaluation.score,
      outcome: "pass",
      feedback: {
        wins: input.evaluation.wins,
        fixes: input.evaluation.fixes,
        next_prompt: input.evaluation.nextPrompt,
      },
      created_at: nowIso,
      updated_at: nowIso,
    });
  }

  // Candidate payload for leaner attempts table (session based)
  attempts.push({
    session_id: input.session.id,
    user_id: input.userId,
    coach_key: input.session.coach_key ?? null,
    drill_id: input.payload.drillId ?? null,
    answer_text: input.payload.answer,
    transcript_text: input.payload.transcript,
    attachments: input.payload.attachments,
    wins: input.evaluation.wins,
    fixes: input.evaluation.fixes,
    next_prompt: input.evaluation.nextPrompt,
    score: input.evaluation.score,
    rubric_json: input.evaluation.rubric,
    pack: input.evaluation.pack,
    duration_sec: input.payload.durationSec,
    words_per_minute: input.payload.wpm,
    created_at: nowIso,
  });

  // Minimal fallback for legacy schema (prompt/response/feedback)
  attempts.push({
    session_id: input.session.id,
    drill_id: input.payload.drillId ?? null,
    prompt: (input.payload.prompt || "").slice(0, 400),
    response: input.payload.answer,
    feedback: {
      wins: input.evaluation.wins,
      fixes: input.evaluation.fixes,
      next_prompt: input.evaluation.nextPrompt,
    },
    score: input.evaluation.score,
    created_at: nowIso,
  });

  for (const row of attempts) {
    try {
      const { data, error } = await supabase.from("attempts").insert(row).select("id").maybeSingle();
      const attemptRecord = toRecord(data);
      if (!error && attemptRecord && typeof attemptRecord.id === "string") return attemptRecord.id;
      if (error) {
        if (isMissingRelation(error) || isMissingColumnError(error)) continue;
        handleDbError("insert_attempt", error);
      }
    } catch (err) {
      if (isMissingRelation(err) || isMissingColumnError(err)) continue;
      throw err;
    }
  }

  return undefined;
}

async function finishSession(
  supabase: Supabase,
  input: { sessionId: string; score: number; durationSec?: number; wpm?: number },
) {
  const durationSec = Number.isFinite(input.durationSec) ? input.durationSec : null;
  const wpm = Number.isFinite(input.wpm) ? input.wpm : null;

  const payload = {
    p_session_id: input.sessionId,
    p_score: input.score,
    p_duration_sec: durationSec,
    p_wpm: wpm,
  };

  const { error } = await supabase.rpc("rpc_finish_session", payload);

  if (error && !isMissingRelation(error)) handleDbError("rpc_finish_session", error);
}

// -----------------------------------------------------------------------------
// Evaluation heuristics
// -----------------------------------------------------------------------------

interface EvaluationResult {
  wins: string[];
  fixes: string[];
  nextPrompt: string;
  pack: {
    expressions: Array<{ text: string; notes: string }>;
    pronunciation: Array<{ text: string; hint: string }>;
  };
  rubric: Record<string, number>;
  score: number;
}

function evaluateAnswer(answer: string, coachKey: string | null, wordsFallback: number): EvaluationResult {
  const normalizedCoach = coachKey || "chelsea_lightbown";
  const words = wordsFallback || wordCount(answer);
  const sentences = splitSentences(answer);
  const momentum = clampNumber(words / 120, 0.2, 1);

  const rubricKeys = RUBRIC_DIMENSIONS[normalizedCoach] || RUBRIC_DIMENSIONS.default;
  const rubric: Record<string, number> = {};
  let sum = 0;
  rubricKeys.forEach((key, idx) => {
    const bias = 0.05 * idx;
    const raw = clampNumber(momentum - bias + (sentences.length > idx ? 0.08 : -0.05), 0, 1);
    // Ensure a numeric value with a safe fallback to satisfy TS
    const value = clampInt(Math.round(raw * 5), 1, 5, 3) as number;
    rubric[key] = value;
    sum += value;
  });
  const overall = Math.round((sum / rubricKeys.length) * 20);
  rubric.overall = overall;

  const wins = buildWins(answer);
  const fixes = buildFixes(answer);
  const nextPrompt = buildNextPrompt(normalizedCoach);
  const pack = buildPack(sentences);

  return { wins, fixes, nextPrompt, pack, rubric, score: overall };
}

function buildWins(answer: string): string[] {
  const lines = [
    "Clear opening that framed the situation.",
    "Specific example that showed measurable impact.",
    "Confident tone with natural transitions.",
    "Good pacing that stayed within the time box.",
  ];
  if (/(\d+%|\d+\s?(minutes|min|people|patients|users))/i.test(answer)) {
    lines.unshift("Used concrete numbers to prove the result.");
  }
  return uniqueList(lines).slice(0, 3);
}

function buildFixes(answer: string): string[] {
  const fixes = [
    "Add one concise metric to quantify the outcome.",
    "Tighten the ending with a single takeaway.",
    "Pause for half a beat between sections to avoid fillers.",
  ];
  if (answer.length < 200) fixes.unshift("Expand the middle section with one vivid detail.");
  if (!/[0-9]/.test(answer)) fixes.unshift("Mention a number or threshold to anchor credibility.");
  return uniqueList(fixes).slice(0, 2);
}

function buildNextPrompt(coachKey: string): string {
  if (coachKey === "carter_goleman") return "Run the same story in 90 seconds and close with a hiring manager ask.";
  if (coachKey === "chelsea_lightbown") return "Record a Part 2 card about a recent news event with two follow ups.";
  if (coachKey === "dr_clark_atul") return "Deliver a concise SBAR update that highlights one risk and one clear ask.";
  return "Record a new attempt focusing on sharper structure and one new supporting detail.";
}

function buildPack(sentences: string[]) {
  const expressions = sentences
    .filter(Boolean)
    .slice(0, 3)
    .map((line, idx) => ({
      text: smartTrim(line, 160),
      notes: idx === 0 ? "Keep this as a confident opener." : "Use this upgraded phrasing in your next attempt.",
    }));

  const pronunciation: Array<{ text: string; hint: string }> = [];
  sentences.join(" ").split(/\s+/).forEach((word) => {
    if (PRONUNCIATION_HINTS[word.toLowerCase()] && pronunciation.length < 2) {
      pronunciation.push({ text: word, hint: PRONUNCIATION_HINTS[word.toLowerCase()] });
    }
  });

  return { expressions, pronunciation };
}

// -----------------------------------------------------------------------------
// Payload helpers
// -----------------------------------------------------------------------------

interface SubmitPayload {
  sessionId: string;
  drillId?: string;
  answer: string;
  prompt?: string;
  transcript?: string;
  attachments: string[];
  durationSec?: number;
  words?: number;
  wpm?: number;
}

function sanitizePayload(body: unknown): SubmitPayload {
  const source = toRecord(body) ?? {};
  const sessionId = firstString(source.session_id ?? source.sessionId ?? source.session) || "";
  const drillId = firstString(source.drill_id ?? source.drillId ?? source.drill);
  const answer = sanitizeAnswer(source.answer ?? source.response ?? "");
  const prompt = sanitizeAnswer(source.prompt);
  const transcript = sanitizeAnswer(source.transcript ?? source.full_transcript);
  const attachments = toStringArray(source.attachments).filter(isHttpUrl).slice(0, 5);

  const meta = toRecord(source.metadata) ?? {};
  const durationSec = clampInt(
    firstNumber(meta.duration_sec ?? meta.durationSec ?? meta.duration_seconds ?? source.duration_sec),
    0,
    3600,
    undefined,
  );
  const words = clampInt(firstNumber(meta.words ?? meta.word_count ?? source.words), 0, 5000, undefined);
  const wpm = clampInt(firstNumber(meta.wpm ?? meta.words_per_minute ?? source.wpm), 0, 400, undefined);

  return { sessionId, drillId, answer, prompt, transcript, attachments, durationSec, words, wpm };
}

function sanitizeAnswer(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 6000);
}

function buildTranscriptPayload(payload: SubmitPayload) {
  if (!payload.transcript) return undefined;
  return [{ text: payload.transcript, ts: 0 }];
}

function sanitizeMetricsJson(payload: SubmitPayload) {
  const metrics: Record<string, unknown> = {};
  if (typeof payload.durationSec === "number" && Number.isFinite(payload.durationSec)) {
    metrics.duration_sec = payload.durationSec;
  }
  if (typeof payload.words === "number" && Number.isFinite(payload.words)) {
    metrics.words = payload.words;
  }
  if (typeof payload.wpm === "number" && Number.isFinite(payload.wpm)) {
    metrics.wpm = payload.wpm;
  }
  return metrics;
}

// -----------------------------------------------------------------------------
// Utility helpers
// -----------------------------------------------------------------------------

const RUBRIC_DIMENSIONS: Record<string, string[]> = {
  chase_krashen: ["structure", "evidence", "reasoning", "clarity", "delivery"],
  dr_claire_swales: ["structure", "fit_alignment", "evidence_methods", "clarity_style", "presence_confidence"],
  carter_goleman: ["structure", "relevance", "impact", "clarity", "presence"],
  chelsea_lightbown: ["fluency_coherence", "lexical_resource", "grammar_accuracy", "pronunciation", "topic_development"],
  dr_clark_atul: ["structure", "clinical_reasoning", "safety_recommendations", "clarity_tone", "evidence_guidelines"],
  dr_crystal_benner: ["structure", "accuracy", "clarity", "empathy_tone", "safety"],
  christopher_buffett: ["clarity", "accuracy", "structure", "client_framing", "numeracy"],
  colton_covey: ["clarity", "relevance", "structure", "persuasion", "presence"],
  cody_turing: ["clarity", "technical_accuracy", "structure", "audience_targeting", "brevity_under_stress"],
  chloe_sinek: ["clarity", "specificity_action", "presence_tone", "structure", "follow_through"],
  default: ["clarity", "structure", "evidence", "delivery", "presence"],
};

const PRONUNCIATION_HINTS: Record<string, string> = {
  schedule: "SKEH-jool (US) or SHED-yool (UK)",
  through: "throo",
  develop: "dih-VEL-up",
  negotiate: "nuh-GOH-shee-ate",
};

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
  const message = typeof record.message === "string" && record.message ? record.message : fallback.message;
  return { status, code, message };
}

function handleDbError(label: string, error: unknown) {
  log.error(`drills/submit ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function readErrorMessage(error: unknown): string {
  const record = toRecord(error);
  if (record && typeof record.message === "string") {
    return record.message;
  }
  return "";
}

function isMissingRelation(error: unknown) {
  const msg = readErrorMessage(error).toLowerCase();
  return msg.includes("does not exist") || msg.includes("relation") || msg.includes("missing FROM-clause entry");
}

function isMissingColumnError(error: unknown) {
  const msg = readErrorMessage(error).toLowerCase();
  return msg.includes("column") && msg.includes("does not exist");
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

function firstNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => firstString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 50);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function clampInt(value: number | undefined, min: number, max: number, fallback?: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value as number)));
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeCoachKey(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/-/g, "_");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function wordCount(value: string) {
  if (!value) return 0;
  return value.trim().split(/\s+/).filter(Boolean).length;
}

function splitSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((s) => smartTrim(s, 220))
    .filter(Boolean);
}

function smartTrim(value: string, max: number) {
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function uniqueList(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  items.forEach((item) => {
    const cleaned = smartTrim(item, 200);
    if (!cleaned || seen.has(cleaned.toLowerCase())) return;
    seen.add(cleaned.toLowerCase());
    out.push(cleaned);
  });
  return out;
}

function isHttpUrl(value: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
