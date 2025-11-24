// src/server/routes/drills/flashcards.ts
/**
 * Flashcards route
 *
 * Returns ordered flashcard items for a published drill set.
 * Query params:
 *   - setId (required): UUID of drill_set
 *   - limit (optional): 1..200, default 50
 *   - offset (optional): >=0, default 0
 *   - includeRaw (optional): include raw content payloads
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type FlashcardsRequest = Request<ParamsDictionary>;

router.get("/", (req: FlashcardsRequest, res: Response) => {
  void runWithRequestContext({ headers: req.headers, user_id: req.user?.userId }, async () => {
    try {
      const query = sanitizeQuery(req);
      if (!query.setId) {
        sendError(res, 400, "invalid_set", "setId is required and must be a UUID.");
        return;
      }

      const supabase = createClient();
      const setRow = await fetchSet(supabase, query.setId);
      if (!setRow) {
        sendError(res, 404, "set_not_found", "Drill set not found.");
        return;
      }
      if (setRow.state !== "published") {
        sendError(res, 403, "set_not_available", "Drill set is not published.");
        return;
      }

      const { cards, total } = await fetchFlashcards(supabase, query.setId, query.limit, query.offset);
      const dataCards = query.includeRaw ? cards : cards.map(stripRawContent);

      res.status(200).json({
        ok: true,
        data: {
          set: mapSet(setRow),
          cards: dataCards,
          pagination: {
            limit: query.limit,
            offset: query.offset,
            total,
            hasMore: typeof total === "number" ? query.offset + cards.length < total : undefined,
          },
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error) {
      log.error("drills/flashcards error", { err: safeError(error) });
      const httpError = parseHttpError(error);
      const message = httpError.status === 500 ? "Unable to load flashcards." : httpError.message;
      sendError(res, httpError.status, httpError.code, message || "Unable to load flashcards.");
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface DrillSetRow {
  id: string;
  coach_id: string;
  section: string;
  title: string;
  description: string | null;
  tags: string[] | null;
  state: string;
  version: number;
  published_at: string | null;
  updated_at: string;
}

interface FlashcardRow {
  item_id: string;
  position: number;
  weight: number;
  pinned: boolean;
  drill_items: {
    id: string;
    title: string | null;
    kind: string;
    content: Record<string, unknown>;
    answer_key: Record<string, unknown> | null;
    hints: unknown;
    difficulty: string;
    reading_level: string | null;
    exam_mapping: Record<string, unknown> | null;
    source_ref: string | null;
    qa_flags: unknown;
    created_at: string;
    updated_at: string;
  } | null;
}

interface Flashcard {
  id: string;
  position: number;
  weight: number;
  pinned: boolean;
  front: string;
  back: string;
  cues: string[];
  context?: string;
  hint?: string;
  imageUrl?: string;
  audioUrl?: string;
  difficulty?: string;
  readingLevel?: string | null;
  examMapping?: Record<string, unknown> | null;
  updatedAt?: string;
  raw?: Record<string, unknown>;
}

interface FlashcardQuery {
  setId?: string;
  limit: number;
  offset: number;
  includeRaw: boolean;
}

// -----------------------------------------------------------------------------
// Data fetchers
// -----------------------------------------------------------------------------

async function fetchSet(supabase: Supabase, setId: string) {
  const { data, error } = await supabase
    .from("drill_sets")
    .select("id, coach_id, section, title, description, tags, state, version, published_at, updated_at")
    .eq("id", setId)
    .maybeSingle();

  if (error) handleDbError("fetch_set", error);
  return data as DrillSetRow | null;
}

async function fetchFlashcards(supabase: Supabase, setId: string, limit: number, offset: number) {
  const { data, error, count } = await supabase
    .from("set_members")
    .select(
      `
        item_id,
        position,
        weight,
        pinned,
        drill_items:item_id (
          id,
          title,
          kind,
          content,
          answer_key,
          hints,
          difficulty,
          reading_level,
          exam_mapping,
          source_ref,
          qa_flags,
          created_at,
          updated_at
        )
      `,
      { count: "exact" },
    )
    .eq("set_id", setId)
    .eq("drill_items.kind", "flashcard")
    .order("position", { ascending: true })
    .order("item_id", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) handleDbError("fetch_flashcards", error);
  const cards = (data as FlashcardRow[] | null) ?? [];
  return {
    cards: cards.map(mapFlashcard).filter((card): card is Flashcard => Boolean(card)),
    total: typeof count === "number" ? count : undefined,
  };
}

// -----------------------------------------------------------------------------
// Mapping helpers
// -----------------------------------------------------------------------------

function mapSet(row: DrillSetRow) {
  return {
    id: row.id,
    coachId: row.coach_id,
    section: row.section,
    title: row.title,
    description: row.description,
    tags: Array.isArray(row.tags) ? row.tags : [],
    version: row.version,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

function mapFlashcard(row: FlashcardRow): Flashcard | null {
  const item = row.drill_items;
  if (!item) return null;

  const content = isPlainObject(item.content) ? item.content : {};
  const front =
    firstString(content.front ?? content.prompt ?? content.term) ?? item.title ?? "Flashcard";
  const back =
    firstString(content.back ?? content.answer ?? content.definition ?? content.response ?? content.text) ?? "";

  return {
    id: item.id,
    position: row.position ?? 0,
    weight: Number.isFinite(row.weight) ? Number(row.weight) : 1,
    pinned: Boolean(row.pinned),
    front,
    back,
    cues: toStringArray(content.cues ?? content.examples ?? []),
    context: firstString(content.context ?? content.example),
    hint: firstString(content.hint ?? content.mnemonic),
    imageUrl: toHttpUrl(firstString(content.image ?? content.imageUrl)),
    audioUrl: toHttpUrl(firstString(content.audio ?? content.audioUrl)),
    difficulty: item.difficulty ?? undefined,
    readingLevel: item.reading_level ?? undefined,
    examMapping: isPlainObject(item.exam_mapping) ? item.exam_mapping : undefined,
    updatedAt: item.updated_at ?? undefined,
    raw: content,
  };
}

function stripRawContent(card: Flashcard) {
  const { raw: _raw, ...rest } = card;
  return rest;
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

function sanitizeQuery(req: Request): FlashcardQuery {
  const setId = firstString(req.query.setId ?? req.query.set_id);
  const limit = clampInt(firstString(req.query.limit), 1, 200, 50);
  const offset = clampInt(firstString(req.query.offset), 0, 10_000, 0);
  const includeRaw = parseBoolean(req.query.includeRaw ?? req.query.include_raw);
  return {
    setId: setId && isUuid(setId) ? setId : undefined,
    limit,
    offset,
    includeRaw,
  };
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

function handleDbError(label: string, error: { message: string }) {
  log.error(`drills/flashcards ${label} failed`, { err: safeError(error) });
  throw Object.assign(new Error("Database query failed."), { status: 500, code: "db_error" });
}

function parseHttpError(error: unknown): { status: number; code: string; message?: string } {
  if (isPlainObject(error)) {
    const status = typeof error.status === "number" ? error.status : 500;
    const code = typeof error.code === "string" ? error.code : "internal_error";
    const message = typeof error.message === "string" ? error.message : undefined;
    return { status, code, message };
  }
  return { status: 500, code: "internal_error" };
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

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => firstString(entry))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 20);
}

function clampInt(value: string | undefined, min: number, max: number, fallback: number) {
  const num = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function parseBoolean(value: unknown) {
  const str = firstString(value);
  if (!str) return false;
  return ["1", "true", "yes", "on"].includes(str.toLowerCase());
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function toHttpUrl(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
