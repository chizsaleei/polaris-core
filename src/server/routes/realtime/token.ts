// src/server/routes/realtime/token.ts
/**
 * Mint short-lived Realtime tokens for the client.
 *
 * Currently supports OpenAI's Realtime (WebRTC) API by issuing an ephemeral
 * client secret via the server-side REST call. Every mint is recorded in the
 * `realtime_tokens` table for observability.
 *
 * Request: GET or POST /api/realtime/token
 *   Optional body/query:
 *     - model  (defaults to OPENAI_REALTIME_MODEL env)
 *     - voice  (defaults to alloy)
 *     - scope  (defaults to "voice")
 *
 * Response:
 * {
 *   "ok": true,
 *   "data": {
 *     "token": "string",
 *     "expires_at": "2025-01-01T00:10:00.000Z",
 *     "model": "gpt-4o-realtime-preview",
 *     "provider": "openai",
 *     "client_secret": { "value": "string", "expires_at": 1730000000 },
 *     "session": { ...full OpenAI session payload... }
 *   },
 *   "correlation_id": "uuid"
 * }
 */

import { Router, type Request, type Response } from "express";
import type { ParamsDictionary } from "express-serve-static-core";
import { authRequired } from "../../middleware/auth";
import { createClient } from "../../../lib/supabase";
import { log, safeError, getCorrelationId, runWithRequestContext } from "../../../lib/logger";
import type { AuthInfo } from "../../middleware/auth";

const router = Router();
const enforceAuth = authRequired();
router.use((req, res, next) => {
  void enforceAuth(req, res, next);
});

const supabase = createClient();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL;
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";
const OPENAI_REALTIME_BASE_URL = (process.env.OPENAI_REALTIME_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/u, "");

type RealtimeRequest = Request<ParamsDictionary> & { user?: AuthInfo };

router.get("/", (req: RealtimeRequest, res: Response) => {
  const contextUserId = req.user?.userId ?? sanitizeHeader(req.header("x-user-id"));
  void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
    await handler(req, res, contextUserId);
  });
});

router.post("/", (req: RealtimeRequest, res: Response) => {
  const contextUserId = req.user?.userId ?? sanitizeHeader(req.header("x-user-id"));
  void runWithRequestContext({ headers: req.headers, user_id: contextUserId }, async () => {
    await handler(req, res, contextUserId);
  });
});

export default router;

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

async function handler(req: Request, res: Response, contextUserId?: string | null) {
  if (!OPENAI_API_KEY) {
    return sendError(res, 500, "openai_not_configured", "OPENAI_API_KEY is not configured on the server.");
  }
  if (!OPENAI_REALTIME_MODEL) {
    return sendError(
      res,
      500,
      "openai_not_configured",
      "OPENAI_REALTIME_MODEL is not configured on the server.",
    );
  }

  try {
    const userId = contextUserId ?? sanitizeHeader(req.header("x-user-id"));
    if (!userId) {
      return sendError(res, 401, "unauthorized", "Missing authenticated user.");
    }

    const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};
    const provider =
      (firstString(req.query.provider) || firstString(body.provider) || "openai").toLowerCase();
    if (provider !== "openai") {
      return sendError(res, 400, "unsupported_provider", "Only provider=openai is supported at this time.");
    }

    const model = firstString(req.query.model) || firstString(body.model) || OPENAI_REALTIME_MODEL || "";
    const voice = firstString(req.query.voice) || firstString(body.voice) || OPENAI_REALTIME_VOICE;
    const scope = sanitizeScope(firstString(req.query.scope) || firstString(body.scope)) || "voice";
    const modalities = sanitizeList(req.query.modalities ?? body.modalities);

    const session = await createOpenAiSession({ model, voice, modalities });
    const clientSecret = firstString(session.client_secret?.value);
    if (!clientSecret) {
      throw new Error("OpenAI session missing client secret");
    }

    const expiresEpoch =
      toNumber(session.client_secret?.expires_at) ??
      toNumber(session.expires_at) ??
      Math.floor(Date.now() / 1000) + 55;
    const expiresAt = epochToIso(expiresEpoch);

    persistRealtimeToken({
      userId,
      provider,
      scope,
      token: clientSecret,
      expiresAt,
      meta: {
        model: firstString(session.model) ?? model,
        session_id: firstString(session.id) ?? null,
        voice,
      },
      req,
    }).catch((error) => {
      log.warn("realtime/token persist failed", { err: safeError(error) });
    });

    return res.status(200).json({
      ok: true,
      data: {
        token: clientSecret,
        expires_at: expiresAt,
        model: firstString(session.model) ?? model,
        provider,
        client_secret: session.client_secret ?? null,
        session,
      },
      correlation_id: getCorrelationId(),
    });
  } catch (error) {
    log.error("realtime/token error", { err: safeError(error) });
    return sendError(res, 502, "realtime_token_failed", "Unable to mint realtime token.");
  }
}

// -----------------------------------------------------------------------------
// OpenAI helper
// -----------------------------------------------------------------------------

interface OpenAiSession {
  id?: string | null;
  model?: string | null;
  client_secret?: {
    value?: string | null;
    expires_at?: number | string | null;
  } | null;
  expires_at?: number | string | null;
  [key: string]: unknown;
}

async function createOpenAiSession(input: { model: string; voice?: string; modalities?: string[] }): Promise<OpenAiSession> {
  const url = `${OPENAI_REALTIME_BASE_URL}/realtime/sessions`;
  const body: Record<string, unknown> = {
    model: input.model,
  };
  if (input.voice) body.voice = input.voice;
  if (Array.isArray(input.modalities) && input.modalities.length) body.modalities = input.modalities;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Beta": "realtime=v1",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    log.error("openai realtime session failed", { status: res.status, body: text });
    throw new Error(`OpenAI realtime error ${res.status}`);
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      return parsed as OpenAiSession;
    }
    throw new Error("invalid_session_payload");
  } catch (error) {
    log.error("openai realtime parse error", { err: safeError(error) });
    throw new Error("Invalid OpenAI realtime response");
  }
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

async function persistRealtimeToken(input: {
  userId: string;
  provider: string;
  scope: string;
  token: string;
  expiresAt: string;
  meta?: Record<string, unknown>;
  req: Request;
}) {
  const ip = firstString(input.req.header("x-forwarded-for")) ?? input.req.socket.remoteAddress ?? null;
  const ipAddr = ip ? ip.split(",")[0].trim() : null;
  const ua = firstString(input.req.header("user-agent")) ?? null;

  await supabase.from("realtime_tokens").insert({
    user_id: input.userId,
    scope: input.scope,
    provider: input.provider,
    token: input.token,
    expires_at: input.expiresAt,
    meta: input.meta ?? {},
    ip_address: ipAddr,
    user_agent: ua,
  } as any);
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

function toNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeScope(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const lowered = value.toLowerCase();
  const allowed = new Set(["chat", "voice", "video", "realtime", "screen", "data"]);
  return allowed.has(lowered) ? lowered : undefined;
}

function sanitizeScope(value?: string | null) {
  return normalizeScope(value);
}

function sanitizeList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((entry) => firstString(entry)).filter(Boolean) as string[];
    return items.length ? items.slice(0, 5) : undefined;
  }
  const str = firstString(value);
  if (!str) return undefined;
  const parts = str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts.slice(0, 5) : undefined;
}

function epochToIso(epochSeconds: number | undefined): string {
  if (!epochSeconds || !Number.isFinite(epochSeconds)) {
    return new Date(Date.now() + 55_000).toISOString();
  }
  const ms = epochSeconds > 1_000_000_000_000 ? epochSeconds : epochSeconds * 1000;
  return new Date(ms).toISOString();
}

function sanitizeHeader(value: string | string[] | undefined | null): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = sanitizeHeader(entry);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
