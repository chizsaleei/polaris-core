// src/server/routes/drills/list.ts
/**
 * Drill catalog listing
 *
 * Supports cursor-based pagination (base64 encoded offset) and filtering by coach,
 * difficulty, topic, skill, format, text search, and tags. Only published / active
 * drills are returned (best effort when schema columns differ).
 */

import { Router, type Request, type Response } from "express";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
interface DrillRow {
  id?: string | null;
  drill_id?: string | null;
  slug?: string | null;
  title?: unknown;
  coach_key?: string | null;
  coach_id?: string | null;
  coach?: string | null;
  skill?: unknown;
  topic?: unknown;
  format?: unknown;
  type?: unknown;
  difficulty?: unknown;
  level?: unknown;
  runtime_seconds?: unknown;
  runtime_sec?: unknown;
  duration_sec?: unknown;
  seconds?: unknown;
  minutes?: unknown;
  runtime_minutes?: unknown;
  time_estimate_minutes?: unknown;
  estimated_minutes?: unknown;
  rubric_id?: string | null;
  rubric_key?: string | null;
  tags?: unknown;
  state?: unknown;
  published_at?: string | null;
  updated_at?: string | null;
  modified_at?: string | null;
  created_at?: string | null;
  is_public?: boolean | null;
  active?: boolean | null;
}

router.get(
  "/",
  (req: Request, res: Response) => {
    const contextUserId = req.user?.userId ?? req.header("x-user-id") ?? undefined;
    void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
      try {
        const query = sanitizeQuery(req);
        const supabase = createClient();
        const result = await listDrills(supabase, query);

        return res.status(200).json({
          ok: true,
          data: result,
          correlation_id: getCorrelationId(),
        });
      } catch (error) {
        log.error("drills/list error", { err: safeError(error) });
        const parsed = parseHttpError(error);
        const message = parsed.status === 500 ? "Unable to load drills." : parsed.message;
        return sendError(res, parsed.status, parsed.code, message || "Unable to load drills.");
      }
    });
  },
);

export default router;

// -----------------------------------------------------------------------------
// Listing logic
// -----------------------------------------------------------------------------

interface ListQuery {
  limit: number;
  offset: number;
  coach: string[];
  difficulty: string[];
  topic?: string;
  skill?: string;
  format?: string;
  q?: string;
  tags: string[];
  sort: SortField;
  direction: "asc" | "desc";
}

type SortField = "published_at" | "updated_at" | "created_at";

interface DrillListItem {
  drill_id: string;
  title: string;
  coach_id: string | null;
  skill?: string | null;
  topic?: string | null;
  format?: string | null;
  difficulty?: string | number | null;
  runtime_sec?: number | null;
  rubric_id?: string | null;
  tags?: string[];
  state?: string | null;
  published_at?: string | null;
  updated_at?: string | null;
}

async function listDrills(
  supabase: Supabase,
  query: ListQuery,
): Promise<{ items: DrillListItem[]; next_cursor?: string }> {
  const sortCandidates = dedupe([query.sort, "published_at", "updated_at", "created_at"]);
  const guardCandidates = [true, false];

  type DbError = { message?: string } | null;
  let lastError: DbError = null;

  for (const sortField of sortCandidates) {
    for (const guardPublished of guardCandidates) {
      const { data, error } = await runDrillQuery(supabase, query, sortField as SortField, guardPublished);
      if (error) {
        if (!isMissingColumnError(error)) {
          handleDbError("fetch_drills", error);
        }
        const dbError: DbError = error ? { message: error.message } : null;
        lastError = dbError;
        continue;
      }

      const rows: DrillRow[] = Array.isArray(data) ? data.map((row) => row as DrillRow) : [];
      const hasMore = rows.length > query.limit;
      const slice = hasMore ? rows.slice(0, query.limit) : rows;
      const filtered = guardPublished ? slice : slice.filter(isPublishedRow);

      return {
        items: filtered.map(mapDrillRow),
        next_cursor: hasMore ? encodeCursor(query.offset + query.limit) : undefined,
      };
    }
  }

  handleDbError("fetch_drills", lastError);
}

function runDrillQuery(
  supabase: Supabase,
  query: ListQuery,
  sortField: SortField,
  guardPublished: boolean,
) {
  let builder = supabase.from("drills").select("*");

  if (query.coach.length) builder = builder.in("coach_key", query.coach);
  if (query.difficulty.length) builder = builder.in("difficulty", query.difficulty);
  if (query.topic) builder = builder.ilike("topic", `%${escapeLike(query.topic)}%`);
  if (query.skill) builder = builder.ilike("skill", `%${escapeLike(query.skill)}%`);
  if (query.format) builder = builder.ilike("format", `%${escapeLike(query.format)}%`);
  if (query.q) builder = builder.ilike("title", `%${escapeLike(query.q)}%`);
  if (query.tags.length) builder = builder.contains("tags", query.tags);

  if (guardPublished) {
    builder = builder.or(
      [
        "state.eq.Approved",
        "state.eq.approved",
        "state.eq.Published",
        "state.eq.published",
        "published_at.not.is.null",
        "is_public.eq.true",
        "active.eq.true",
      ].join(","),
    );
  }

  builder = builder
    .order(sortField, { ascending: query.direction === "asc", nullsFirst: query.direction === "asc" })
    .order("id", { ascending: query.direction === "asc" });

  return builder.range(query.offset, query.offset + query.limit);
}

function mapDrillRow(row: DrillRow): DrillListItem {
  const runtime = pickRuntime(row);
  const drillId = firstString(row.id ?? row.drill_id ?? row.slug) ?? "";
  const coachSource = firstString(row.coach_key ?? row.coach_id ?? row.coach);
  const difficulty =
    normalizeDifficulty(row.difficulty) ??
    normalizeDifficulty(row.level);
  return {
    drill_id: drillId,
    title: firstString(row.title) ?? "Untitled drill",
    coach_id: normalizeCoach(coachSource ?? null),
    skill: asString(row.skill),
    topic: asString(row.topic),
    format: asString(row.format ?? row.type),
    difficulty,
    runtime_sec: runtime,
    rubric_id: asString(row.rubric_id) ?? asString(row.rubric_key),
    tags: toStringArray(row.tags),
    state: asString(row.state),
    published_at: asString(row.published_at),
    updated_at: asString(row.updated_at ?? row.modified_at ?? row.created_at),
  };
}

function pickRuntime(row: DrillRow): number | null {
  const sec =
    toNumber(row.runtime_seconds) ??
    toNumber(row.runtime_sec) ??
    toNumber(row.duration_sec) ??
    toNumber(row.seconds);
  if (Number.isFinite(sec as number)) return sec as number;

  const minutes =
    toNumber(row.minutes) ??
    toNumber(row.runtime_minutes) ??
    toNumber(row.time_estimate_minutes) ??
    toNumber(row.estimated_minutes);
  if (Number.isFinite(minutes as number)) return Math.round((minutes as number) * 60);
  return null;
}

function asString(value: unknown): string | null {
  const str = firstString(value);
  return str ?? null;
}

function normalizeDifficulty(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return asString(value);
}

function isPublishedRow(row: DrillRow): boolean {
  if (typeof row.active === "boolean") return row.active;
  if (typeof row.is_public === "boolean") return row.is_public;
  if (row.published_at) return true;
  const state = firstString(row.state)?.toLowerCase();
  if (state) return state === "approved" || state === "published";
  return true;
}

// -----------------------------------------------------------------------------
// Query parsing and helpers
// -----------------------------------------------------------------------------

function sanitizeQuery(req: Request): ListQuery {
  const limit = clampInt(firstString(req.query.limit), 1, 100, 20);

  const cursor = firstString(req.query.cursor);
  const offset = cursor ? decodeCursor(cursor) : 0;

  const coachRaw = toList(req.query.coach_id ?? req.query.coachId ?? req.query.coach);
  const coach = expandCoachValues(coachRaw);

  const difficulty = toList(req.query.difficulty);
  const tags = toList(req.query.tag ?? req.query.tags);

  const topic = sanitizeSearchTerm(req.query.topic);
  const skill = sanitizeSearchTerm(req.query.skill);
  const format = sanitizeSearchTerm(req.query.format);
  const search = sanitizeSearchTerm(req.query.q ?? req.query.search ?? req.query.query);

  const sort = normalizeSort(firstString(req.query.sort));
  const direction = normalizeDirection(firstString(req.query.direction ?? req.query.dir ?? req.query.order));

  return {
    limit,
    offset,
    coach,
    difficulty,
    tags,
    topic: topic || undefined,
    skill: skill || undefined,
    format: format || undefined,
    q: search || undefined,
    sort,
    direction,
  };
}

function toList(value: unknown): string[] {
  const entries: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) entries.push(...splitCsv(item));
  } else if (value != null) {
    entries.push(...splitCsv(value));
  }
  return entries.map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

function splitCsv(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function expandCoachValues(values: string[]): string[] {
  const out = new Set<string>();
  values.forEach((val) => {
    const lower = val.toLowerCase();
    out.add(lower);
    out.add(lower.replace(/-/g, "_"));
    out.add(lower.replace(/_/g, "-"));
  });
  return Array.from(out).filter(Boolean);
}

function sanitizeSearchTerm(value: unknown): string {
  const str = firstString(value);
  if (!str) return "";
  return str.slice(0, 120);
}

function normalizeSort(value: string | undefined): SortField {
  if (!value) return "published_at";
  const key = value.toLowerCase();
  if (key.startsWith("updated")) return "updated_at";
  if (key.startsWith("created")) return "created_at";
  return "published_at";
}

function normalizeDirection(value: string | undefined): "asc" | "desc" {
  if (!value) return "desc";
  return value.toLowerCase() === "asc" ? "asc" : "desc";
}

function encodeCursor(offset: number): string {
  const base = Buffer.from(String(offset), "utf8").toString("base64");
  return base.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string): number {
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

function escapeLike(value: string) {
  return value.replace(/[%_]/g, (match) => `\\${match}`);
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value as SortField);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Utility helpers
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

function parseHttpError(error: unknown): { status: number; code: string; message?: string } {
  if (error && typeof error === "object") {
    const status = typeof (error as { status?: number }).status === "number" ? (error as { status?: number }).status! : 500;
    const code = typeof (error as { code?: string }).code === "string" ? (error as { code?: string }).code! : "internal_error";
    const message = typeof (error as { message?: string }).message === "string" ? (error as { message?: string }).message : undefined;
    return { status, code, message };
  }
  return { status: 500, code: "internal_error", message: undefined };
}

function handleDbError(label: string, error: { message?: string } | null): never {
  log.error(`drills/list ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function isMissingColumnError(error: { message?: string }) {
  const msg = String(error?.message || "").toLowerCase();
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
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value instanceof Date) {
    const str = String(value).trim();
    return str.length ? str : undefined;
  }
  return undefined;
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number) {
  if (typeof value === "string") {
    const num = Number.parseInt(value, 10);
    if (Number.isFinite(num)) {
      return Math.max(min, Math.min(max, num));
    }
  }
  return fallback;
}

function normalizeCoach(value: string | null | undefined) {
  if (!value) return null;
  return value.toLowerCase().replace(/_/g, "-");
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => firstString(entry))
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 32);
  }
  if (typeof value === "string") return [value];
  return [];
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}
