/**
 * Polaris Core - Rate limiting middleware presets
 *
 * Features
 *  - Key on authenticated user id when present, else fall back to client IP
 *  - JSON error responses with retry-after hint
 *  - Sensible presets for public, auth, payments, and admin routes
 *
 * Usage
 *   import { publicLimiter, authLimiter, payLimiter, adminLimiter } from './middleware/rate-limit'
 *   app.use(publicLimiter)                                   // global default
 *   app.use('/api/pay', payLimiter)                          // payments
 *   app.use('/api/admin', adminLimiter)                      // admin
 */

import type { Request, Response, RequestHandler } from 'express'
import rateLimit from 'express-rate-limit'
import type { AuthInfo } from './auth'

// ---------- Shared types for API / UI ----------

export type LimiterPreset = 'public' | 'auth' | 'pay' | 'admin'

export interface LimiterOptions {
  name: string              // label included in key derivation
  windowMs: number          // time window
  max: number               // max requests in window per key
  standardHeaders?: boolean // default true
  legacyHeaders?: boolean   // default false
  skip?: (req: Request) => boolean
  // Use a custom key generator when needed
  keyGenerator?: (req: Request) => string
}

export interface AuthenticatedRequest extends Request {
  user?: AuthInfo
}

/**
 * Shape of the rate limiting state that express-rate-limit attaches to the request.
 * v7 stores resetTime as a Date, but we accept number as well for safety.
 */
export interface RateLimitState {
  resetTime?: Date | number
}

export interface RateLimitedRequest extends Request {
  rateLimit?: RateLimitState
}

/**
 * Body shape we care about for payment key derivation.
 */
export interface PayRequestBody {
  userId?: string
  plan?: string
}

// ---------- Caps (exportable for dashboards / shared config) ----------

// If you prefer env-driven caps, override these via process.env
export const PUBLIC_MAX = toInt(process.env.RATE_PUBLIC_PER_MIN, 120)       // reqs per minute
export const AUTH_MAX = toInt(process.env.RATE_AUTH_PER_MIN, 240)           // reqs per minute
export const PAY_MAX = toInt(process.env.RATE_PAY_PER_15MIN, 30)            // reqs per 15 minutes
export const ADMIN_MAX = toInt(process.env.RATE_ADMIN_PER_MIN, 60)          // reqs per minute

/**
 * Make a limiter with our default behaviors.
 */
export function makeRateLimiter(opts: LimiterOptions): RequestHandler {
  const {
    name,
    windowMs,
    max,
    standardHeaders = true,
    legacyHeaders = false,
    skip,
    keyGenerator,
  } = opts

  return rateLimit({
    windowMs,
    max,
    standardHeaders,
    legacyHeaders,
    skip,
    keyGenerator: keyGenerator ?? defaultKeyGen(name),
    handler: jsonHandler(name),
  })
}

/**
 * Presets
 */
export const publicLimiter = makeRateLimiter({
  name: 'pub',
  windowMs: 60_000,
  max: PUBLIC_MAX,
  // Do not rate limit simple health checks
  skip: (req) => req.path === '/health' || req.path === '/version',
})

export const authLimiter = makeRateLimiter({
  name: 'auth',
  windowMs: 60_000,
  max: AUTH_MAX,
})

export const payLimiter = makeRateLimiter({
  name: 'pay',
  windowMs: 15 * 60_000,
  max: PAY_MAX,
  // Use a stronger key when we can identify the actor attempting checkout
  keyGenerator: (req: Request) => {
    const u = readUserId(req as AuthenticatedRequest)
    const body = req.body as PayRequestBody | undefined
    const bodyUser = typeof body?.userId === 'string' ? body.userId : null
    const id = u || bodyUser || clientIp(req)
    // Include plan when present to reduce cross-plan collisions
    const plan = typeof body?.plan === 'string' ? body.plan : 'na'
    return `pay:${id}:${plan}`
  },
})

export const adminLimiter = makeRateLimiter({
  name: 'admin',
  windowMs: 60_000,
  max: ADMIN_MAX,
})

/**
 * Default key generator
 * Priority: authenticated user id -> X-Client-Id header -> client IP
 */
function defaultKeyGen(namespace: string) {
  return (req: Request): string => {
    const uid = readUserId(req as AuthenticatedRequest)
    const headerId = req.header('X-Client-Id') || req.header('x-client-id')
    const ip = clientIp(req)
    return `${namespace}:${uid || headerId || ip}`
  }
}

/**
 * JSON handler with Retry-After seconds when available.
 */
function jsonHandler(namespace: string) {
  return (req: Request, res: Response): void => {
    const rateReq = req as RateLimitedRequest
    const reset = rateReq.rateLimit?.resetTime

    let retry_after_seconds: number | undefined
    if (reset instanceof Date) {
      const diff = reset.getTime() - Date.now()
      if (diff > 0) retry_after_seconds = Math.ceil(diff / 1000)
    } else if (typeof reset === 'number') {
      const diff = reset - Date.now()
      if (diff > 0) retry_after_seconds = Math.ceil(diff / 1000)
    }

    const body: { error: string; scope: string; retry_after_seconds?: number } = {
      error: 'Too many requests',
      scope: namespace,
    }

    if (retry_after_seconds !== undefined) {
      body.retry_after_seconds = retry_after_seconds
    }

    res.status(429).json(body)
  }
}

/**
 * Pull a stable user id if auth middleware attached it.
 */
export function readUserId(req: AuthenticatedRequest): string | null {
  const userId = req.user?.userId
  return typeof userId === 'string' ? userId : null
}

/**
 * A best effort IP extractor that respects reverse proxies.
 */
export function clientIp(req: Request): string {
  const xfwdHeader = req.headers['x-forwarded-for']
  const xfwd =
    typeof xfwdHeader === 'string'
      ? xfwdHeader
      : Array.isArray(xfwdHeader)
      ? xfwdHeader.join(',')
      : ''

  if (xfwd) {
    // Use the first address in the list
    const first = xfwd.split(',')[0].trim()
    if (first) return first
  }

  if (req.ip) return req.ip
  if (req.socket?.remoteAddress) return req.socket.remoteAddress

  return 'unknown'
}

/**
 * Safe integer parser for env values.
 */
export function toInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = parseInt(v, 10)
    if (Number.isFinite(n)) return n
  }
  return fallback
}
