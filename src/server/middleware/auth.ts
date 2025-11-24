/**src\server\middleware\auth.ts
 * Polaris Core — Auth middleware
 *
 * Purpose
 *  - Verify Supabase Auth JWT from the Authorization header or cookies
 *  - Attach `req.user` with profile and active entitlement tier
 *  - Offer three helpers:
 *      1) authOptional()  -> attach user if present, continue if not
 *      2) authRequired()  -> require a valid user or return 401
 *      3) requireTier(t)  -> require user and minimum tier (free/pro/vip)
 *
 * Integration
 *  - Uses Supabase service role to verify JWT and read profile + entitlements
 *  - Expects tables: profiles(id, email, is_admin, role), entitlements(user_id, tier, active)
 */

import type { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import { ENV } from '../../config/env'
import { Tier } from '../../types'

// Service role client for server-side checks
const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false, autoRefreshToken: false },
})

export interface AuthInfo {
  userId: string
  email?: string | null
  tier: Tier
  roles?: string[]
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthInfo
  }
}

/**
 * Attach user to req if a valid token is present. If token is missing or invalid, continue.
 */
export function authOptional() {
  return async function (req: Request, _res: Response, next: NextFunction) {
    try {
      const token = readAccessToken(req)
      if (!token) return next()

      const user = await loadUserAndTier(token)
      if (user) req.user = user
      return next()
    } catch {
      // Do not block on errors in optional mode
      return next()
    }
  }
}

/**
 * Require a valid authenticated user. Respond with 401 if missing or invalid.
 */
export function authRequired() {
  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      const token = readAccessToken(req)
      if (!token) return res.status(401).json({ error: 'Missing auth token' })

      const user = await loadUserAndTier(token)
      if (!user) return res.status(401).json({ error: 'Invalid or expired token' })

      req.user = user
      return next()
    } catch (e) {
      console.error('[authRequired] error', e)
      return res.status(500).json({ error: 'Server error' })
    }
  }
}

/**
 * Require a minimum tier. VIP >= PRO >= FREE.
 * Example:
 *    app.get('/api/vip-only', requireTier('vip'), handler)
 */
export function requireTier(minTier: Tier) {
  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      // Ensure we have a user first
      const token = readAccessToken(req)
      if (!token) return res.status(401).json({ error: 'Missing auth token' })

      const user = req.user ?? (await loadUserAndTier(token))
      if (!user) return res.status(401).json({ error: 'Invalid or expired token' })

      if (!meetsTier(user.tier, minTier)) {
        return res.status(403).json({ error: `Requires ${minTier} plan` })
      }

      req.user = user
      return next()
    } catch (e) {
      console.error('[requireTier] error', e)
      return res.status(500).json({ error: 'Server error' })
    }
  }
}

// ----------------- internals -----------------

function readAccessToken(req: Request): string | null {
  // 1) Authorization: Bearer <token>
  const h = req.header('Authorization') || req.header('authorization')
  if (h && h.toLowerCase().startsWith('bearer ')) {
    const token = h.slice(7).trim()
    if (token) return token
  }

  // 2) Supabase cookies (fallback). We only need sb-access-token.
  //    If you add cookie-parser, use req.cookies['sb-access-token'] instead.
  const cookieHeader = req.header('Cookie') || req.header('cookie')
  if (cookieHeader) {
    const token = readCookie(cookieHeader, 'sb-access-token')
    if (token) return token
  }

  return null
}

async function loadUserAndTier(token: string): Promise<AuthInfo | null> {
  // Validate token and get user id
  const { data: userRes, error: userErr } = await supabase.auth.getUser(token)
  if (userErr || !userRes?.user) return null
  const uid = userRes.user.id

  // Load profile
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('id, email, is_admin, role')
    .eq('id', uid)
    .maybeSingle<ProfileRow>()

  if (profErr) {
    // If profile lookup fails, still allow auth but with minimal info
    return { userId: uid, email: null, tier: Tier.FREE, roles: [] }
  }

  // Load active entitlement, prefer vip over pro
  const { data: ent, error: entErr } = await supabase
    .from('entitlements')
    .select('tier, active')
    .eq('user_id', uid)
    .eq('active', true)
    .returns<EntitlementRow[]>()

  if (entErr) {
    return { userId: uid, email: profile?.email ?? null, tier: Tier.FREE, roles: toRoles(profile) }
  }

  const tier: Tier =
    (ent ?? [])
      .map((r) => r.tier)
      .sort((a, b) => tierWeight(b) - tierWeight(a))[0] ?? Tier.FREE

  return {
    userId: uid,
    email: profile?.email ?? null,
    tier,
    roles: toRoles(profile),
  }
}

interface ProfileRow {
  id: string
  email: string | null
  is_admin: boolean | null
  role: string | null
}

interface EntitlementRow {
  tier: Tier
  active: boolean
}

function toRoles(profile: ProfileRow | null): string[] {
  const roles: string[] = []
  if (profile?.role) roles.push(String(profile.role).toLowerCase())
  if (profile?.is_admin) roles.push('admin')
  return Array.from(new Set(roles))
}

function meetsTier(userTier: Tier, min: Tier): boolean {
  return tierWeight(userTier) >= tierWeight(min)
}

function tierWeight(t: Tier): number {
  switch (t) {
    case Tier.VIP:
      return 3
    case Tier.PRO:
      return 2
    case Tier.FREE:
    default:
      return 1
  }
}

function readCookie(header: string, name: string): string | null {
  const parts = header.split(';')
  for (const p of parts) {
    const [k, ...rest] = p.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('=')) || null
  }
  return null
}
