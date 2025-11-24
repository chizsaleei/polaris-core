// src/server/routes/library/random.ts
/**
 * Returns a random sample of expressions from the user's private library.
 *
 * Query params:
 *   - limit?: number (1..5, default 3)
 *   - includeExamples?: boolean (false) => include stored examples/collocations
 *   - publicOnly?: boolean (false) => if true, pulls from published exemplars instead of user's private entries
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import type { PostgrestError } from "@supabase/supabase-js";
import { createClient } from "../../../lib/supabase";
import { runWithRequestContext, log, safeError, getCorrelationId } from "../../../lib/logger";
import type { AuthInfo } from "../../middleware/auth";

const router = Router();
type Supabase = ReturnType<typeof createClient>;
type RandomRequest = Request<ParamsDictionary> & { user?: AuthInfo };

router.get("/", (req: RandomRequest, res: Response) => {
  const headerUser = req.header("x-user-id");
  const contextUserId =
    req.user?.userId ?? (typeof headerUser === "string" ? headerUser.trim() : undefined);

  void runWithRequestContext(
    { headers: req.headers, user_id: contextUserId },
    async () => {
      try {
        const userId = contextUserId ?? "";
        if (!userId) {
          sendError(res, 401, "unauthorized", "Missing user id.");
          return;
        }

        const query = sanitizeQuery(req);
        const supabase = createClient();

        const items = await fetchExpressions(supabase, userId, query);

        res.status(200).json({
          ok: true,
          data: { items },
          correlation_id: getCorrelationId(),
        });
      } catch (error: unknown) {
        const parsed = parseHttpError(error);
        const message =
          parsed.status === 500 ? "Unable to load expressions." : parsed.message ?? "Unable to load expressions.";
        if (parsed.status >= 500) log.error("library/random error", { err: safeError(error) });
        sendError(res, parsed.status, parsed.code, message);
      }
    },
  );
});

export default router;

// -----------------------------------------------------------------------------
// Data fetching
// -----------------------------------------------------------------------------

interface RandomQuery {
  limit: number;
  includeExamples: boolean;
  publicOnly: boolean;
}

type KeyExpressionRow = Record<string, unknown>;

async function fetchExpressions(supabase: Supabase, userId: string, query: RandomQuery) {
  let builder = supabase
    .from("key_expressions")
    .select(
      [
        "id",
        "text_original",
        "text_upgrade",
        "collocations",
        "pronunciation",
        "examples",
        "coach_id",
        "state",
        "created_at",
      ].join(","),
    )
    .limit(query.limit * 4);

  if (query.publicOnly) {
    builder = builder.eq("state", "published_exemplar").eq("is_exemplar", true);
  } else {
    builder = builder.eq("user_id", userId).eq("state", "private_user");
  }

  const { data, error } = await builder;
  const dbError: PostgrestError | null = error;
  if (dbError) {
    if (isMissingRelation(dbError)) {
      throw makeHttpError(501, "not_supported", "key_expressions table not available.");
    }
    handleDbError("fetch_expressions", dbError);
  }

  const rows: KeyExpressionRow[] = asExpressionRows(data);
  const list = shuffle(rows).slice(0, query.limit);

  return list.map((row) => ({
    id: firstString(row["id"]) ?? "",
    text_original: firstString(row["text_original"]) ?? firstString(row["text"]) ?? "",
    text_upgraded:
      firstString(row["text_upgrade"]) ??
      firstString(row["text_upgraded"]) ??
      firstString(row["upgraded"]) ??
      "",
    collocations: toStringArray(row["collocations"]),
    pronunciation: firstString(row["pronunciation"]) ?? null,
    examples: query.includeExamples ? toStringArray(row["examples"]) : undefined,
    coach_id: firstString(row["coach_id"]) ?? null,
    state: firstString(row["state"]) ?? null,
    created_at: firstString(row["created_at"]) ?? null,
  }));
}

// -----------------------------------------------------------------------------
// Query + utility helpers
// -----------------------------------------------------------------------------

function sanitizeQuery(req: Request): RandomQuery {
  const limit = clampInt(parseNumber(req.query.limit), 1, 5, 3);
  const includeExamples = parseBoolean(req.query.includeExamples ?? req.query.examples);
  const publicOnly = parseBoolean(req.query.publicOnly ?? req.query.catalog);
  return { limit, includeExamples, publicOnly };
}

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

function handleDbError(label: string, error: { message?: string }) {
  log.error(`library/random ${label} failed`, { err: safeError(error) });
  throw makeHttpError(500, "db_error", "Database query failed.");
}

function clampInt(value: number | null, min: number, max: number, fallback: number) {
  if (value === null || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function parseBoolean(value: unknown) {
  const str = firstString(value);
  if (!str) return false;
  return ["1", "true", "yes", "on"].includes(str.toLowerCase());
}

function shuffle<T>(arr: T[]) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function toStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((v) => firstString(v)).filter((v): v is string => Boolean(v));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
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

function parseNumber(value: unknown): number | null {
  const str = firstString(value);
  if (!str) return null;
  const parsed = Number.parseFloat(str);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMissingRelation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const maybeMessage = "message" in error ? (error as { message?: unknown }).message : undefined;
  const msg = typeof maybeMessage === "string" ? maybeMessage.toLowerCase() : "";
  return msg.includes("does not exist") || msg.includes("undefined table");
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asExpressionRows(value: unknown): KeyExpressionRow[] {
  if (!Array.isArray(value)) return [];
  const out: KeyExpressionRow[] = [];
  for (const entry of value) {
    if (isRecord(entry)) {
      out.push(entry);
    }
  }
  return out;
}
