// src/server/routes/search/sessions.ts
/**
 * Session search endpoint
 *
 * GET /api/search/sessions?q=IELTS&from=2025-01-01&to=2025-02-01&cursor=abc
 * Returns a cursor-based list of the user's past sessions filtered
 * by text, date window, coach, or topic.
 */

import { Router, type Request, type Response } from "express";
import { createClient } from "../../../lib/supabase";
import { authRequired } from "../../middleware/auth";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();
const enforceAuth = authRequired();
router.use((req, res, next) => {
  void enforceAuth(req, res, next);
});

type Supabase = ReturnType<typeof createClient>;

router.get("/", (req: Request, res: Response) => {
  const userId = req.user?.userId ?? readUserId(req.header("x-user-id"));
  void runWithRequestContext({ headers: req.headers, user_id: userId }, async () => {
    try {
      if (!userId) return sendError(res, 401, "unauthorized", "Missing authenticated user.");

      const query = sanitizeQuery(req);
      const supabase = createClient();
      const result = await searchSessions(supabase, userId, query);

      return res.status(200).json({
        ok: true,
        data: result,
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      log.error("search/sessions error", { err: safeError(error) });
      const parsed = parseHttpError(error);
      const message = parsed.status === 500 ? "Unable to search sessions." : parsed.message;
      return sendError(res, parsed.status, parsed.code, message || "Unable to search sessions.");
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Logic
// -----------------------------------------------------------------------------

interface SessionSearchQuery {
  q?: string;
  limit: number;
  offset: number;
  from?: string;
  to?: string;
  coach: string[];
  topic?: string;
}

interface SessionRow {
  id: string;
  started_at?: string | null;
  ended_at?: string | null;
  coach_key?: string | null;
  topic?: string | null;
  notes?: string | null;
  score?: number | null;
  words_per_minute?: number | null;
  status?: string | null;
}

interface SessionResultItem {
  session_id: string;
  started_at: string | null;
  ended_at: string | null;
  coach_id: string | null;
  topic: string | null;
  score: number | null;
  words_per_minute: number | null;
  status: string | null;
  summary: string | null;
}

async function searchSessions(
  supabase: Supabase,
  userId: string,
  query: SessionSearchQuery,
): Promise<{ items: SessionResultItem[]; next_cursor?: string }> {
  let builder = supabase
    .from("sessions")
    .select("id, started_at, ended_at, coach_key, topic, notes, score, words_per_minute, status")
    .eq("user_id", userId)
    // Remove unsupported nullsLast option
    .order("started_at", { ascending: false })
    .order("id", { ascending: false })
    .range(query.offset, query.offset + query.limit);

  if (query.from) builder = builder.gte("started_at", query.from);
  if (query.to) builder = builder.lte("started_at", query.to);
  if (query.coach.length) builder = builder.in("coach_key", query.coach);
  if (query.topic) builder = builder.ilike("topic", `%${escapeLike(query.topic)}%`);

  if (query.q) {
    const like = `%${escapeLike(query.q)}%`;
    builder = builder.or(["topic.ilike." + like, "notes.ilike." + like].join(","));
  }

  const { data, error } = await builder;
  if (error) handleDbError("fetch_sessions", error);

  const rows = Array.isArray(data) ? (data as SessionRow[]) : [];
  const hasMore = rows.length > query.limit;
  const slice = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: slice.map(mapSessionRow),
    next_cursor: hasMore ? encodeCursor(query.offset + query.limit) : undefined,
  };
}

function mapSessionRow(row: SessionRow): SessionResultItem {
  return {
    session_id: String(row.id),
    started_at: row.started_at ?? null,
    ended_at: row.ended_at ?? null,
    coach_id: formatCoach(row.coach_key),
    topic: row.topic ?? null,
    score: toNumber(row.score) ?? null,
    words_per_minute: toNumber(row.words_per_minute) ?? null,
    status: row.status ?? null,
    summary: summarizeNotes(row.notes),
  };
}

// -----------------------------------------------------------------------------
// Query parsing
// -----------------------------------------------------------------------------

function sanitizeQuery(req: Request): SessionSearchQuery {
  const q = sanitizeSearchTerm(req.query.q ?? req.query.query);
  const limit = clampInt(firstNumber(req.query.limit), 1, 50, 20);
  const coach = toList(req.query.coach ?? req.query.coach_id)
    .map(normalizeCoachKey)
    .filter((v): v is string => Boolean(v));
  const topic = sanitizeSearchTerm(req.query.topic);
  const from = normalizeDate(firstString(req.query.from));
  const to = normalizeDate(firstString(req.query.to));
  const offset = decodeCursor(firstString(req.query.cursor));

  return {
    q: q || undefined,
    limit,
    offset,
    from,
    to,
    coach,
    topic: topic || undefined,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  });
}

function handleDbError(label: string, error: { message?: string }) {
  log.error(`search/sessions ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function makeHttpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function parseHttpError(error: unknown): { status: number; code: string; message?: string } {
  if (error && typeof error === "object") {
    const status = typeof (error as { status?: number }).status === "number" ? (error as { status?: number }).status! : 500;
    const code = typeof (error as { code?: string }).code === "string" ? (error as { code?: string }).code! : "internal_error";
    const message = typeof (error as { message?: string }).message === "string" ? (error as { message?: string }).message : undefined;
    return { status, code, message };
  }
  return { status: 500, code: "internal_error", message: undefined };
}

function sanitizeSearchTerm(value: unknown): string {
  const str = firstString(value);
  if (!str) return "";
  return str.slice(0, 120).trim();
}

function normalizeDate(value?: string | null) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function summarizeNotes(notes: unknown): string | null {
  const text = firstString(notes);
  if (!text) return null;
  return text.slice(0, 240);
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
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  return undefined;
}

function firstNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return undefined;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const normalized = cursor.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
    const decoded = Buffer.from(normalized + padding, "base64").toString("utf8");
    const value = Number.parseInt(decoded, 10);
    if (!Number.isFinite(value) || value < 0) throw new Error("invalid");
    return value;
  } catch {
    throw makeHttpError(400, "invalid_cursor", "Cursor is invalid or expired.");
  }
}

function encodeCursor(offset: number): string {
  const base = Buffer.from(String(offset), "utf8").toString("base64");
  return base.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function escapeLike(value: string) {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((entry) => String(entry ?? "").split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

function formatCoach(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/_/g, "-");
}

function normalizeCoachKey(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/-/g, "_");
}

function toNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function readUserId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}
