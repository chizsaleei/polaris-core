// src/server/routes/search/cards.ts
/**
 * Card search endpoint
 *
 * GET /api/search/cards?q=IELTS&coach_id=chelsea-lightbown&cursor=abc
 * Returns cursor-based list of published drills matching the query.
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { PostgrestError } from "@supabase/supabase-js";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type SearchRequest = Request<ParamsDictionary> & { user?: { userId?: string | null } };

router.get("/", (req: SearchRequest, res: Response) => {
  const headerUser = req.header("x-user-id");
  const contextUserId =
    req.user?.userId ?? (typeof headerUser === "string" ? headerUser.trim() : undefined);

  void runWithRequestContext(
    { headers: req.headers, user_id: contextUserId },
    async () => {
      try {
        const query = sanitizeQuery(req);
        const supabase = createClient();
        const result = await searchCards(supabase, query);

        res.status(200).json({
          ok: true,
          data: result,
          correlation_id: getCorrelationId(),
        });
      } catch (error: unknown) {
        log.error("search/cards error", { err: safeError(error) });
        const parsed = parseHttpError(error);
        const message =
          parsed.status === 500 ? "Unable to search cards." : parsed.message ?? "Unable to search cards.";
        sendError(res, parsed.status, parsed.code, message);
      }
    },
  );
});

export default router;

// -----------------------------------------------------------------------------
// Core search logic
// -----------------------------------------------------------------------------

interface SearchQuery {
  q: string;
  limit: number;
  offset: number;
  coach: string[];
}

interface DrillCard {
  drill_id: string;
  title: string;
  coach_id: string | null;
  topic?: string | null;
  skill?: string | null;
  format?: string | null;
  difficulty?: string | number | null;
  minutes?: number | null;
  tags?: string[];
  summary?: string | null;
  updated_at?: string | null;
}

interface DrillRow {
  id?: string | number | null;
  drill_id?: string | number | null;
  title?: string | null;
  coach_key?: string | null;
  coach_id?: string | null;
  topic?: string | null;
  skill?: string | null;
  format?: string | null;
  difficulty?: string | number | null;
  tags?: unknown;
  minutes?: number | null;
  runtime_minutes?: number | null;
  runtime_seconds?: number | null;
  estimated_minutes?: number | null;
  time_estimate_minutes?: number | null;
  duration_sec?: number | null;
  summary?: string | null;
  prompt?: string | null;
  updated_at?: string | null;
  published_at?: string | null;
  state?: string | null;
  active?: unknown;
  is_public?: unknown;
}

async function searchCards(
  supabase: Supabase,
  query: SearchQuery,
): Promise<{ items: DrillCard[]; next_cursor?: string }> {
  let builder = supabase
    .from("drills")
    .select(
      "id, title, coach_key, coach_id, topic, skill, format, difficulty, tags, minutes, runtime_minutes, summary, prompt, updated_at, published_at, active, is_public, state",
    )
    // Remove unsupported nullsLast option
    .order("published_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: false })
    .range(query.offset, query.offset + query.limit);

  if (query.coach.length) builder = builder.in("coach_key", query.coach);

  const like = `%${escapeLike(query.q)}%`;
  builder = builder.or(
    ["title.ilike." + like, "prompt.ilike." + like, "topic.ilike." + like, "skill.ilike." + like].join(","),
  );

  builder = builder.in("state", ["Approved", "approved", "Published", "published"]);

  const response = await builder;
  const dbError: PostgrestError | null = response.error;
  if (dbError) handleDbError("fetch_drills", dbError);

  const rows: DrillRow[] = Array.isArray(response.data) ? (response.data as DrillRow[]) : [];
  const hasMore = rows.length > query.limit;
  const slice = hasMore ? rows.slice(0, query.limit) : rows;

  return {
    items: slice.map(mapDrillRow),
    next_cursor: hasMore ? encodeCursor(query.offset + query.limit) : undefined,
  };
}

function mapDrillRow(row: DrillRow): DrillCard {
  return {
    drill_id: firstString(row.id) ?? firstString(row.drill_id) ?? "",
    title: firstString(row.title) ?? "Untitled drill",
    coach_id: formatCoach(firstString(row.coach_key) ?? firstString(row.coach_id)),
    topic: firstString(row.topic) ?? null,
    skill: firstString(row.skill) ?? null,
    format: firstString(row.format) ?? null,
    difficulty: pickDifficulty(row),
    minutes: pickMinutes(row),
    tags: Array.isArray(row.tags)
      ? row.tags
          .map((tag) => firstString(tag))
          .filter((tag): tag is string => Boolean(tag))
      : [],
    summary: summarize(row),
    updated_at: firstString(row.updated_at) ?? firstString(row.published_at) ?? null,
  };
}

function summarize(row: DrillRow): string | null {
  const summary = firstString(row.summary);
  if (summary) return summary.slice(0, 240);
  const prompt = firstString(row.prompt);
  if (prompt) return prompt.slice(0, 240);
  return null;
}

// -----------------------------------------------------------------------------
// Query parsing
// -----------------------------------------------------------------------------

function sanitizeQuery(req: Request): SearchQuery {
  const q = sanitizeSearchTerm(req.query.q ?? req.query.query ?? req.query.term);
  if (!q || q.length < 2) {
    throw makeHttpError(400, "missing_query", "Search query must be at least 2 characters.");
  }

  const limit = clampInt(firstNumber(req.query.limit), 1, 50, 20);
  const coach = toList(req.query.coach ?? req.query.coach_id)
    .map(normalizeCoachKey)
    .filter((v): v is string => Boolean(v));
  const offset = decodeCursor(firstString(req.query.cursor));

  return { q, limit, offset, coach };
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

function handleDbError(label: string, error: { message?: string } | PostgrestError) {
  log.error(`search/cards ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function makeHttpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

function sanitizeSearchTerm(value: unknown): string {
  const str = firstString(value);
  if (!str) return "";
  return str.slice(0, 120).trim();
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const str = firstString(entry);
      if (str) return str;
    }
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
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

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value as number)));
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

function escapeLike(value: string) {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

function pickMinutes(row: DrillRow): number | null {
  const minutes =
    toNumber(row.minutes) ??
    toNumber(row.runtime_minutes) ??
    toNumber(row.estimated_minutes) ??
    toNumber(row.time_estimate_minutes);
  if (Number.isFinite(minutes)) return Math.max(1, Math.round(minutes as number));
  const seconds = toNumber(row.runtime_seconds) ?? toNumber(row.duration_sec);
  if (Number.isFinite(seconds)) return Math.max(1, Math.round((seconds as number) / 60));
  return null;
}

function pickDifficulty(row: DrillRow): string | number | null | undefined {
  const value = row.difficulty;
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}

function normalizeCoachKey(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/-/g, "_");
}

function formatCoach(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/_/g, "-");
}

function toNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function parseHttpError(error: unknown): { status: number; code: string; message?: string } {
  if (isRecord(error)) {
    const status = typeof error.status === "number" ? error.status : 500;
    const code = typeof error.code === "string" ? error.code : "internal_error";
    const message = typeof error.message === "string" ? error.message : undefined;
    return { status, code, message };
  }
  return { status: 500, code: "internal_error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export {};
