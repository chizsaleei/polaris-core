// src/server/routes/upload/index.ts
/**
 * POST /api/upload
 *
 * Generate a signed upload URL for Supabase Storage so the client can push
 * files (audio, docs, images). Access is limited to authenticated users and
 * buckets defined in BUCKETS.
 *
 * Body (JSON):
 * {
 *   "bucket": "user-media",
 *   "prefix": "sessions/audio",
 *   "filename": "answer.webm",
 *   "content_type": "audio/webm",
 *   "expires_in": 900   // hint only; Supabase controls actual TTL for signed-upload URLs
 * }
 */

import { Router, type Request, type Response } from 'express'
import { randomUUID } from 'node:crypto'
import { authRequired } from '../../middleware/auth'
import { createClient } from '../../../lib/supabase'
import { BUCKETS } from '../../../lib/constants'
import { log, safeError, runWithRequestContext, getCorrelationId } from '../../../lib/logger'

const router = Router()
const enforceAuth = authRequired()
router.use((req, res, next) => {
  void enforceAuth(req, res, next)
})

const supabase = createClient()
const ALLOWED_BUCKETS = new Set(Object.values(BUCKETS))
const DEFAULT_EXPIRY = 900 // seconds; client-facing hint only
const SIGNED_UPLOAD_TTL_HINT_SEC = 120 // typical TTL of signed upload URLs

interface UploadRequestUser {
  userId?: string
}

interface UploadRequestBody {
  bucket?: unknown
  prefix?: unknown
  filename?: unknown
  content_type?: unknown
  mime?: unknown
  expires_in?: unknown
}

type UploadRequest = Request<Record<string, unknown>, unknown, UploadRequestBody> & {
  user?: UploadRequestUser
}

router.post('/', (req: UploadRequest, res: Response) => {
  void runWithRequestContext({ headers: req.headers, user_id: req.user?.userId }, async () => {
    try {
      const userId = req.user?.userId
      if (!userId) {
        return sendError(res, 401, 'unauthorized', 'Missing authenticated user.')
      }

      const body = req.body ?? ({} as UploadRequestBody)
      const bucket = normalizeBucket(firstString(body.bucket))
      const prefix = sanitizePrefix(firstString(body.prefix), userId)
      const filename = sanitizeFilename(firstString(body.filename) ?? `upload-${Date.now()}`)
      // Validate and echo the requested content type so the client can send it in the PUT
      const contentType = sanitizeContentType(firstString(body.content_type) ?? firstString(body.mime))
      const expiresIn = clampInt(firstNumber(body.expires_in), 60, 3600, DEFAULT_EXPIRY)

      const key = buildObjectKey(prefix, filename)

      // FIX: Supabase v2 createSignedUploadUrl accepts (path) or (path, { upsert?: boolean })
      // Do NOT pass expires/contentType here; send Content-Type in the client PUT request.
      const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(key, { upsert: true })

      if (error || !data) {
        throw sendableError(500, 'signed_upload_failed', error?.message || 'Unable to create upload URL.')
      }

      // Client upload example:
      // await fetch(data.signedUrl, {
      //   method: 'PUT',
      //   headers: { 'Content-Type': contentType, 'x-upsert': 'true' }, // x-upsert if you used { upsert: true } above
      //   body: fileOrBlob
      // })
      return res.status(200).json({
        ok: true,
        data: {
          bucket,
          key,
          upload_url: data.signedUrl,
          token: data.token ?? null,
          // Hint for UI only; Supabase controls the real expiry of the signed URL
          expires_at: new Date(Date.now() + Math.min(expiresIn, SIGNED_UPLOAD_TTL_HINT_SEC) * 1000).toISOString(),
          content_type: contentType,
        },
        correlation_id: getCorrelationId(),
      })
    } catch (error: unknown) {
      log.error('upload/index error', { err: safeError(error) })
      if (isSendableError(error)) {
        return sendError(res, error.status, error.code, error.message || 'Unable to create upload URL.')
      }
      return sendError(res, 500, 'upload_prepare_failed', 'Unable to create upload URL.')
    }
  })
})

export default router

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function normalizeBucket(value?: string | null) {
  if (!value) return BUCKETS.USER_MEDIA
  const lower = value.trim()
  if (ALLOWED_BUCKETS.has(lower as (typeof BUCKETS)[keyof typeof BUCKETS])) return lower
  throw sendableError(400, 'unsupported_bucket', 'Bucket is not allowed.')
}

function sanitizePrefix(prefix: string | undefined, userId: string) {
  if (!prefix) return `users/${userId}`
  const clean = prefix.replace(/^\/+/, '').replace(/\/{2,}/g, '/')
  if (!clean.includes(userId)) return `users/${userId}/${clean}`
  return clean
}

function sanitizeFilename(name: string) {
  return name.replace(/[/\\]/g, '_').slice(0, 120)
}

function sanitizeContentType(value?: string | null) {
  if (!value) return 'application/octet-stream'
  const lower = value.toLowerCase()
  if (lower.length > 120) throw sendableError(400, 'invalid_content_type', 'content_type is too long.')
  return lower
}

function buildObjectKey(prefix: string, filename: string) {
  const id = randomUUID()
  const safePrefix = prefix.replace(/\/$/, '')
  return `${safePrefix}/${id}-${filename}`
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const str = firstString(entry)
      if (str) return str
    }
    return undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length ? trimmed : undefined
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    const normalized = String(value).trim()
    return normalized.length ? normalized : undefined
  }
  if (value instanceof Date) {
    const normalized = value.toISOString().trim()
    return normalized.length ? normalized : undefined
  }
  return undefined
}

function firstNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.round(value as number)))
}

function sendError(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  })
}

type SendableError = Error & { status: number; code: string }

function sendableError(status: number, code: string, message: string): SendableError {
  return Object.assign(new Error(message), { status, code })
}

function isSendableError(error: unknown): error is SendableError {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as Partial<SendableError>
  return typeof candidate.status === 'number' && typeof candidate.code === 'string'
}
