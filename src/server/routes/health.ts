// src/server/routes/health.ts

import { Router, type Request, type Response } from 'express'
import { createClient } from '../../lib/supabase'

const router = Router()
const supabase = createClient()

// ---------- Shared types for API / UI ----------

export interface HealthLivenessResponse {
  ok: true
  status: 'alive'
  ts: string
}

export interface HealthEnvStatus {
  supabaseUrl: boolean
  supabaseAnonKey: boolean
  appBaseUrl: boolean
  paypalWebhookId: boolean
  paymongoWebhookSecret: boolean
}

export interface HealthDbOk {
  ok: true
}

export interface HealthDbError {
  ok: false
  error: string
}

export type HealthDbStatus = HealthDbOk | HealthDbError

export interface HealthReadinessProbeResponse {
  ok: boolean
  db: HealthDbStatus
  env: HealthEnvStatus
  ts: string
}

export interface HealthReadinessFailureResponse {
  ok: false
  error: 'readiness_failed'
  detail: string
  ts: string
}

export type HealthReadinessResponse =
  | HealthReadinessProbeResponse
  | HealthReadinessFailureResponse

// ---------- Routes ----------

/**
 * GET /health
 * Simple liveness probe
 */
router.get<never, HealthLivenessResponse>('/', (_req: Request, res: Response<HealthLivenessResponse>) => {
  res.status(200).json({
    ok: true,
    status: 'alive',
    ts: new Date().toISOString(),
  })
})

/**
 * GET /health/ready
 * Readiness probe with a cheap DB check and env hints
 */
router.get<never, HealthReadinessResponse>('/ready', (_req: Request, res: Response<HealthReadinessResponse>) => {
  void (async () => {
    try {
      const { error } = await supabase
        .from('profiles')
        .select('*', { head: true, count: 'exact' })
        .limit(0)

      const dbOk = !error

      const env: HealthEnvStatus = {
        supabaseUrl: Boolean(
          process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
        ),
        supabaseAnonKey: Boolean(
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
        ),
        appBaseUrl: Boolean(
          process.env.NEXT_PUBLIC_APP_BASE_URL || process.env.APP_BASE_URL,
        ),
        paypalWebhookId: Boolean(process.env.PAYPAL_WEBHOOK_ID),
        paymongoWebhookSecret: Boolean(process.env.PAYMONGO_WEBHOOK_SECRET),
      }

      const dbStatus: HealthDbStatus = dbOk
        ? { ok: true }
        : { ok: false, error: error?.message ?? 'db_error' }

      res.status(dbOk ? 200 : 503).json({
        ok: dbOk,
        db: dbStatus,
        env,
        ts: new Date().toISOString(),
      })
    } catch (err: unknown) {
      const detail =
        err instanceof Error ? err.message : 'unknown_error'

      res.status(503).json({
        ok: false,
        error: 'readiness_failed',
        detail,
        ts: new Date().toISOString(),
      })
    }
  })()
})

// Named export for use in app.ts and for tests
export const healthRouter = router

// Default export for existing imports
export default router
