// src/server/routes/tts/speak.ts
/**
 * POST /api/tts
 *
 * Body:
 * {
 *   "text": "Welcome back!",
 *   "voice": "alloy",
 *   "format": "mp3",
 *   "bucket": "user-media",
 *   "expires_in": 900
 * }
 */

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { authRequired } from "../../middleware/auth";
import { createClient } from "../../../lib/supabase";
import { tts as runTts } from "../../../lib/openai";
import type { TtsOptions } from "../../../lib/openai";
import { BUCKETS } from "../../../lib/constants";
import { log, safeError, getCorrelationId, runWithRequestContext } from "../../../lib/logger";

const router = Router();
const enforceAuth = authRequired();
router.use((req, res, next) => {
  void enforceAuth(req, res, next);
});

const supabase = createClient();
const DEFAULT_EXPIRY = 900;
const ALLOWED_BUCKETS = new Set(Object.values(BUCKETS));

interface SpeakRequestUser {
  userId?: string;
}

interface SpeakRequestBody {
  text?: unknown;
  voice?: unknown;
  format?: unknown;
  bucket?: unknown;
  expires_in?: unknown;
}

type SpeakRequest = Request<Record<string, unknown>, unknown, SpeakRequestBody> & {
  user?: SpeakRequestUser;
};

router.post("/", (req: SpeakRequest, res: Response) => {
  void runWithRequestContext({ headers: req.headers, user_id: req.user?.userId }, async () => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return sendError(res, 401, "unauthorized", "Missing authenticated user.");
      }

      const body = req.body ?? ({} as SpeakRequestBody);
      const text = firstString(body.text);
      if (!text) {
        return sendError(res, 400, "invalid_text", "text is required.");
      }

      const voice = firstString(body.voice);
      const format = sanitizeFormat(firstString(body.format));
      const bucket = normalizeBucket(firstString(body.bucket));
      const expiresIn = clampInt(firstNumber(body.expires_in), 60, 3600, DEFAULT_EXPIRY);

      const result = await runTts({
        input: text,
        voice: voice || undefined,
        format, // typed as TtsOptions["format"]
      });

      const key = buildObjectKey(userId, format);
      await uploadAudio(bucket, key, result.audio, result.contentType);

      const signed = await supabase.storage.from(bucket).createSignedUrl(key, expiresIn);
      if (signed.error || !signed.data?.signedUrl) {
        throw sendableError(500, "signed_url_failed", signed.error?.message || "Unable to sign audio URL.");
      }

      return res.status(200).json({
        ok: true,
        data: {
          audio_url: signed.data.signedUrl,
          expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          bucket,
          key,
          format,
          voice: voice || null,
          length_bytes: result.audio.length,
        },
        correlation_id: getCorrelationId(),
      });
    } catch (error: unknown) {
      log.error("tts/speak error", { err: safeError(error) });
      if (isSendableError(error)) {
        return sendError(res, error.status, error.code, error.message || "Unable to synthesize speech.");
      }
      return sendError(res, 502, "tts_failed", "Unable to synthesize speech.");
    }
  });
});

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function uploadAudio(bucket: string, key: string, audio: Uint8Array, contentType: string) {
  const { error } = await supabase.storage.from(bucket).upload(key, Buffer.from(audio), {
    contentType,
    upsert: true,
  });
  if (error) throw sendableError(500, "upload_audio_failed", error.message);
}

function buildObjectKey(userId: string, format: TtsOptions["format"]) {
  const id = randomUUID();
  return `users/${userId}/tts/${id}.${format}`;
}

function sanitizeFormat(fmt?: string | null): TtsOptions["format"] {
  const allowed = ["mp3", "wav", "flac", "opus"] as const;
  if (!fmt) return "mp3";
  const lower = fmt.toLowerCase();
  if ((allowed as readonly string[]).includes(lower)) return lower as TtsOptions["format"];
  throw sendableError(400, "unsupported_format", "Format must be one of mp3, wav, flac, opus.");
}

function normalizeBucket(value?: string | null) {
  if (!value) return BUCKETS.USER_MEDIA;
  const lower = value.trim();
  if (ALLOWED_BUCKETS.has(lower as (typeof BUCKETS)[keyof typeof BUCKETS])) return lower;
  throw sendableError(400, "unsupported_bucket", "Bucket is not allowed for TTS.");
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
    const normalized = String(value).trim();
    return normalized.length ? normalized : undefined;
  }
  if (value instanceof Date) {
    const normalized = value.toISOString().trim();
    return normalized.length ? normalized : undefined;
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

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  });
}

type SendableError = Error & { status: number; code: string };

function sendableError(status: number, code: string, message: string): SendableError {
  return Object.assign(new Error(message), { status, code });
}

function isSendableError(error: unknown): error is SendableError {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as Partial<SendableError>;
  return typeof candidate.status === "number" && typeof candidate.code === "string";
}
