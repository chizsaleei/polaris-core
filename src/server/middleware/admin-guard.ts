/**
 * Polaris Core — Admin Guard middleware
 *
 * Protects admin routes by either:
 *  1) Valid Supabase Auth JWT whose profile is_admin = true or role in ['admin','owner']
 *  2) An API key sent as X-Admin-Key header that matches ADMIN_API_KEY (for automations and CI)
 *
 * On success attaches `req.admin = { userId, email, roles, source }`
 */

import type { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import { ENV } from '../../config/env'

// Service role client for server-side checks
const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false, autoRefreshToken: false },
})

type AdminSource = 'api_key' | 'user'

interface ProfileRow {
  id: string
  email: string | null
  is_admin: boolean | null
  role: string | null
}

export interface AdminInfo {
  userId: string
  email?: string | null
  roles: string[]
  source: AdminSource
}

declare module 'express-serve-static-core' {
  // Augment Request with admin info when present
  interface Request {
    admin?: AdminInfo
  }
}

export interface AdminGuardOptions {
  allowApiKey?: boolean // default true
  requiredRoles?: string[] // default ['admin','owner']
}

const ADMIN_API_KEY: string | undefined = (() => {
  const envValue = (ENV.ADMIN_API_KEY || '').trim()
  const fallback = (process.env.ADMIN_API_KEY || '').trim()
  const resolved = envValue || fallback
  return resolved ? resolved : undefined
})()

/**
 * Express middleware. Usage:
 *   app.use('/api/admin', adminGuard())
 */
export function adminGuard(opts: AdminGuardOptions = {}) {
  const allowApiKey = opts.allowApiKey !== false
  const required = opts.requiredRoles ?? ['admin', 'owner']

  return async function (req: Request, res: Response, next: NextFunction) {
    try {
      // 1) API key path (for CI and cron)
      if (allowApiKey && ADMIN_API_KEY) {
        const hdr = req.header('X-Admin-Key') || req.header('x-admin-key')
        if (hdr && safeEqual(hdr.trim(), ADMIN_API_KEY.trim())) {
          req.admin = { userId: 'api-key', roles: ['admin'], source: 'api_key' }
          return next()
        }
      }

      // 2) Supabase Auth JWT path
      const token = readBearerToken(req)
      if (!token) {
        return res.status(401).json({ error: 'Missing auth token or admin key' })
      }

      const { data: userRes, error: userErr } = await supabase.auth.getUser(token)
      if (userErr || !userRes?.user) {
        return res.status(401).json({ error: 'Invalid or expired token' })
      }

      const uid = userRes.user.id

      // Load profile to check admin flags
      const { data: profile, error: profErr } = await supabase
        .from('profiles')
        .select('id, email, is_admin, role')
        .eq('id', uid)
        .maybeSingle<ProfileRow>()

      if (profErr) {
        // If profile lookup fails, block access to be safe
        return res.status(403).json({ error: 'Profile check failed' })
      }

      const roles: string[] = []
      if (profile?.role) roles.push(String(profile.role).toLowerCase())
      if (profile?.is_admin) roles.push('admin')

      const ok = roles.some((r) => required.includes(r))
      if (!ok) {
        return res.status(403).json({ error: 'Admin role required' })
      }

      req.admin = {
        userId: uid,
        email: profile?.email ?? null,
        roles: Array.from(new Set(roles)),
        source: 'user',
      }

      return next()
    } catch (e) {
      console.error('[admin-guard] error', e)
      return res.status(500).json({ error: 'Server error' })
    }
  }
}

// -------- helpers

function readBearerToken(req: Request): string | null {
  const h = req.header('Authorization') || req.header('authorization')
  if (!h) return null
  const [scheme, token] = h.split(' ')
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null
  return token.trim()
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// Node 18 has crypto.timingSafeEqual. Avoid importing crypto again here.
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  // Simple constant time compare
  let diff = a.length ^ b.length
  for (let i = 0; i < a.length && i < b.length; i++) {
    diff |= a[i] ^ b[i]
  }
  return diff === 0
}
