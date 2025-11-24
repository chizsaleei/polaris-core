// src/server/routes/transcribe/upload.ts
/**
 * POST /api/transcribe/upload
 *
 * Generates a signed upload URL for audio files (webm/wav/mp3/ogg) so the client can
 * upload directly to Supabase Storage before calling /api/transcribe.
 *
 * Body (JSON):
 * {
 *   "filename": "answer.webm",
 *   "content_type": "audio/webm",
 *   "bucket": "temp-uploads",
 *   "expires_in": 900
 * }
 */

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { authRequired } from "../../middleware/auth";
import { createClient } from "../../../lib/supabase";
import { BUCKETS } from "../../../lib/constants";
import { log, safeError, getCorrelationId, runWithRequestContext } from "../../../lib/logger";

const router = Router();
const enforceAuth = authRequired();
router.use((req, res, next) => {
  void enforceAuth(req, res, next);
});

const supabase = createClient();
const ALLOWED_BUCKETS = new Set(Object.values(BUCKETS));
const DEFAULT_EXPIRY = 900; // 15 minutes

interface UploadRequestUser {
  userId?: string;
}

interface UploadRequestBody {
  bucket?: unknown;
  storage_bucket?: unknown;
  filename?: unknown;
  content_type?: unknown;
  mime?: unknown;
  expires_in?: unknown;
}

type UploadRequest = Request<Record<string, unknown>, unknown, UploadRequestBody> & {
  user?: UploadRequestUser;
};

router.post(
  "/upload",
  (req: UploadRequest, res: Response) => {
    void runWithRequestContext({ headers: req.headers, user_id: req.user?.userId }, async () => {
      try {
        const userId = req.user?.userId;
        if (!userId) {
          return sendError(res, 401, "unauthorized", "Missing authenticated user.");
        }

        const body = req.body ?? ({} as UploadRequestBody);
        const bucket = normalizeBucket(firstString(body.bucket) ?? firstString(body.storage_bucket));
        const filename = sanitizeFilename(firstString(body.filename) ?? `audio-${Date.now()}.webm`);
        const contentType = sanitizeContentType(firstString(body.content_type) ?? firstString(body.mime));
        const expiresIn = clampInt(firstNumber(body.expires_in), 60, 3600, DEFAULT_EXPIRY);

        const key = buildObjectKey(userId, filename);

        // Storage v2: createSignedUploadUrl accepts 1 or 2 args, not 3
        // Expiry is controlled by the server default; client should upload promptly
        const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(key);

        if (error || !data) {
          throw sendableError(500, "signed_upload_failed", error?.message || "Unable to create upload URL.");
        }

        return res.status(200).json({
          ok: true,
          data: {
            bucket,
            key,
            upload_url: data.signedUrl,
            token: data.token ?? null,
            // Best effort expiry hint for the client
            expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
            content_type: contentType,
          },
          correlation_id: getCorrelationId(),
        });
      } catch (error: unknown) {
        log.error("transcribe/upload error", { err: safeError(error) });
        if (isSendableError(error)) {
          return sendError(res, error.status, error.code, error.message || "Unable to prepare upload.");
        }
        return sendError(res, 500, "upload_prepare_failed", "Unable to prepare audio upload.");
      }
    });
  },
);

export default router;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function buildObjectKey(userId: string, filename: string) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `users/${userId}/audio/${randomUUID()}-${safeName}`;
}

function normalizeBucket(value?: string | null) {
  if (!value) return BUCKETS.TEMP_UPLOADS;
  const lower = value.trim();
  if (ALLOWED_BUCKETS.has(lower as (typeof BUCKETS)[keyof typeof BUCKETS])) return lower;
  throw sendableError(400, "unsupported_bucket", "Bucket is not allowed for uploads.");
}

function sanitizeFilename(value: string) {
  return value.replace(/[/\\]/g, "_").slice(0, 120);
}

function sanitizeContentType(value?: string | null) {
  if (!value) return "audio/webm";
  const allowed = ["audio/webm", "audio/wav", "audio/mpeg", "audio/mp3", "audio/ogg"];
  const lower = value.toLowerCase();
  if (allowed.includes(lower)) return lower === "audio/mp3" ? "audio/mpeg" : lower;
  throw sendableError(400, "unsupported_type", "Only audio/webm, audio/wav, audio/mpeg, audio/ogg are allowed.");
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
