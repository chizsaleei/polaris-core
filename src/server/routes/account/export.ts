// polaris-core/src/server/routes/account/export.ts

import {
  Router,
  type Request,
  type Response,
  type RequestHandler,
} from 'express'
import type { ParsedQs } from 'qs'
import zlib from 'node:zlib'
import { createClient } from '../../../lib/supabase'
import type { AuthInfo } from '../../middleware/auth'

const router = Router()
const supabase = createClient()

// ---------- Shared types for API/UI ----------

export type AccountExportErrorCode =
  | 'missing_user_id'
  | 'compress_failed'
  | 'internal_error'

export interface AccountExportErrorResponse {
  error: AccountExportErrorCode
}

export interface AccountExportTableConfig {
  name: string
  by?: string // column used for user scoping, defaults to "user_id"
}

export interface AccountExportTableManifestEntry {
  count: number
  error?: string
}

export type AccountExportManifest = Record<string, AccountExportTableManifestEntry>

export interface AccountExportDocumentMeta {
  userId: string
  generatedAt: string
  appVersion: string
  tables: AccountExportManifest
}

export interface AccountExportDocument {
  meta: AccountExportDocumentMeta
  data: Record<string, unknown[]>
}

type GenericRow = Record<string, unknown>
type AccountExportQuery = ParsedQs & { userId?: string }

export interface AccountExportManifestSuccessResponse {
  ok: true
  userId: string
  generatedAt: string
  tables: AccountExportManifest
}

export type AccountExportManifestResponse =
  | AccountExportManifestSuccessResponse
  | AccountExportErrorResponse

// ---------- Auth helper types ----------

type RequestWithAuth = Request & { user?: AuthInfo }

/**
 * Pull a stable user id if auth middleware attached it.
 * Mirror logic used in other routes (delete, etc.).
 */
export function readUserId(req: Request): string | null {
  const user = (req as RequestWithAuth).user
  if (!user) return null
  if (typeof user.userId === 'string' && user.userId.length > 0) {
    return user.userId
  }
  if ('id' in user && typeof (user as Record<string, unknown>).id === 'string') {
    return (user as Record<string, string>).id
  }
  return null
}

// ---------- Shared config ----------

export const ACCOUNT_EXPORT_TABLES: AccountExportTableConfig[] = [
  { name: 'profiles', by: 'user_id' },
  { name: 'sessions' },
  { name: 'attempts' },
  { name: 'practice_packs' },
  { name: 'vocabulary' },
  { name: 'key_expressions' },
  { name: 'assignments' },
  { name: 'entitlements' },
  { name: 'payments_events' },
  { name: 'events' },
  { name: 'daily_usage' },
  { name: 'tickets' },
  { name: 'notifications' },
]

// ---------- Core handlers ----------

export async function handleAccountExport(
  req: Request,
  res: Response<AccountExportErrorResponse | Buffer>,
): Promise<void> {
  try {
    const headerUser = readUserId(req)
    const queryUserId =
      typeof req.query.userId === 'string' ? req.query.userId : ''
    const userId = headerUser || (queryUserId || null)

    if (!userId) {
      res.status(401).json({ error: 'missing_user_id' })
      return
    }

    const manifest: AccountExportManifest = {}
    const payload: Record<string, unknown[]> = {}

    for (const t of ACCOUNT_EXPORT_TABLES) {
      const col = t.by || 'user_id'
      const rows: GenericRow[] = []
      let from = 0
      const page = 1000

      // Probe once to detect table availability and count
      const probe = await supabase
        .from(t.name)
        .select('*', { count: 'exact', head: false })
        .eq(col, userId)
        .range(0, 0)

      if (probe.error) {
        // Table missing
        if (/42P01|relation .* does not exist/i.test(probe.error.message)) {
          manifest[t.name] = { count: 0, error: 'table_missing' }
          continue
        }

        // Other error
        manifest[t.name] = {
          count: 0,
          error: sanitizeError(probe.error.message),
        }
        continue
      }

      // If first page has data, keep paginating
      const firstBatch = toRowArray(probe.data)
      if (firstBatch.length > 0) {
        rows.push(...firstBatch)
      }

      const total = probe.count ?? rows.length

      while (rows.length < total) {
        // After first row, move forward by page size
        from = rows.length
        const to = from + page - 1
        const { data, error } = await supabase
          .from(t.name)
          .select('*')
          .eq(col, userId)
          .range(from, to)

        if (error) {
          manifest[t.name] = {
            count: rows.length,
            error: sanitizeError(error.message),
          }
          break
        }

        const batch = toRowArray(data)
        if (!batch.length) break
        rows.push(...batch)
      }

      payload[t.name] = rows
      manifest[t.name] = { count: rows.length }
    }

    const now = new Date().toISOString()
    const appVersion = process.env.npm_package_version || '0.1.0'
    const exportDoc: AccountExportDocument = {
      meta: {
        userId,
        generatedAt: now,
        appVersion,
        tables: manifest,
      },
      data: payload,
    }

    const json = Buffer.from(JSON.stringify(exportDoc, null, 2), 'utf8')
    const filename = `polaris-export-${userId}-${now.replace(/[:.]/g, '-')}.json`

    // If client supports gzip, compress for smaller download
    const acceptsGzip = /\bgzip\b/i.test(
      String(req.header('accept-encoding') ?? ''),
    )

    if (acceptsGzip) {
      zlib.gzip(
        json,
        { level: zlib.constants.Z_BEST_SPEED },
        (err: Error | null, gz: Buffer) => {
          if (err) {
            res.status(500).json({ error: 'compress_failed' })
            return
          }

          res.setHeader('Content-Type', 'application/json')
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${filename}.gz"`,
          )
          res.setHeader('Content-Encoding', 'gzip')
          res.setHeader('Cache-Control', 'no-store')
          res.status(200).send(gz)
        },
      )
      return
    }

    res.setHeader('Content-Type', 'application/json')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"`,
    )
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).send(json)
  } catch (err: unknown) {
    console.error('[account/export] unexpected', err)
    res.status(500).json({ error: 'internal_error' })
  }
}

export async function handleAccountExportManifest(
  req: Request,
  res: Response<AccountExportManifestResponse>,
): Promise<void> {
  try {
    const headerUser = readUserId(req)
    const queryUserId =
      typeof req.query.userId === 'string' ? req.query.userId : ''
    const userId = headerUser || (queryUserId || null)

    if (!userId) {
      res.status(401).json({ error: 'missing_user_id' })
      return
    }

    const manifest: AccountExportManifest = {}

    for (const t of ACCOUNT_EXPORT_TABLES) {
      const col = t.by || 'user_id'
      const { count, error } = await supabase
        .from(t.name)
        .select('*', { count: 'exact', head: true })
        .eq(col, userId)

      if (error) {
        if (/42P01|relation .* does not exist/i.test(error.message)) {
          manifest[t.name] = { count: 0, error: 'table_missing' }
        } else {
          manifest[t.name] = {
            count: 0,
            error: sanitizeError(error.message),
          }
        }
      } else {
        manifest[t.name] = { count: count ?? 0 }
      }
    }

    const response: AccountExportManifestSuccessResponse = {
      ok: true,
      userId,
      generatedAt: new Date().toISOString(),
      tables: manifest,
    }

    res.status(200).json(response)
  } catch (err: unknown) {
    console.error('[account/export/manifest] unexpected', err)
    res.status(500).json({ error: 'internal_error' })
  }
}

// ---------- Helpers ----------

function sanitizeError(msg: string): string {
  return msg.replace(/\s+/g, ' ').slice(0, 180)
}

// ---------- Route wiring (non-async to satisfy no-misused-promises) ----------

type ExportHandler = RequestHandler<
  never,
  AccountExportErrorResponse | Buffer,
  unknown,
  AccountExportQuery
>

const exportHandler: ExportHandler = (req, res) => {
  void handleAccountExport(req, res)
}

type ExportManifestHandler = RequestHandler<
  never,
  AccountExportManifestResponse,
  unknown,
  AccountExportQuery
>

const exportManifestHandler: ExportManifestHandler = (req, res) => {
  void handleAccountExportManifest(req, res)
}

router.get('/', exportHandler)
router.get('/manifest', exportManifestHandler)

// Named export for wiring/tests
export const accountExportRouter = router

// Default export for existing imports
export default router

function toRowArray(value: unknown): GenericRow[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is GenericRow => !!row && typeof row === 'object')
}
