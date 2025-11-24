/**
 * Polaris Core - Nightly Reconciliation Job
 *
 * Goal
 *  - Compare payment events vs current entitlements
 *  - Heal mismatches by granting or revoking entitlements
 *  - Append all actions to a reconciliation log for audit
 *
 * Notes
 *  - Providers: PayPal, PayMongo, and internal "system_recon"
 *  - Plans map to tiers: vip_* -> VIP, pro_* -> PRO; free is not part of billing
 */

import { createClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { ENV } from '../../config/env'

const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false, autoRefreshToken: false },
})

// Shared domain types kept in sync with payments and entitlements
export type Tier = 'free' | 'pro' | 'vip'
export type PlanKey = 'pro_monthly' | 'pro_yearly' | 'vip_monthly' | 'vip_yearly'

// Simple JSON helpers for reconciliation_log.actions_json
export type JsonValue = string | number | boolean | null | JsonObject | JsonArray
export interface JsonObject {
  [key: string]: JsonValue
}
export interface JsonArray extends Array<JsonValue> {}

export interface ReconcileOptions {
  lookbackDays?: number // default 45
  dryRun?: boolean
  limitEvents?: number // max rows from payments_events
}

export type ReconActionType =
  | 'grant_needed'
  | 'revoke_needed'
  | 'ok_no_change'
  | 'revoke_orphan'
  | 'skip_bad_ref'

export interface ReconAction {
  id: string
  type: ReconActionType
  provider: string | null
  provider_ref: string | null
  user_id: string | null
  plan_key: PlanKey | null
  tier: Tier | null
  currency: string | null
  at: string
}

export interface ReconcileResult {
  ok: boolean
  lookedBackDays: number
  sinceIso: string
  actions: ReconAction[]
  logged: number
}

// Rows we read from payments_events
type PaymentEventRow = {
  id: string
  user_id: string | null
  provider: string | null
  provider_ref: string | null
  type: string | null
  status: string | null
  plan_key: PlanKey | null
  created_at: string
  currency: string | null
  amount_minor: number | null
}

// Rows we read from entitlements
type EntitlementRow = {
  user_id: string
  tier: Tier
  active: boolean
  reference: string | null
  plan_key: PlanKey | null
}

type OrphanEntitlement = {
  user_id: string
  tier: Tier
  plan_key: PlanKey | null
}

type DesiredState = 'grant' | 'revoke' | 'none'

export async function runReconciliation(opts: ReconcileOptions = {}): Promise<ReconcileResult> {
  const lookbackDays = opts.lookbackDays ?? 45
  const sinceDate = daysAgo(new Date(), lookbackDays)
  const sinceIso = sinceDate.toISOString()

  // 1) Pull recent payment events grouped by provider_ref
  const { data: eventsRaw, error: e1 } = await supabase
    .from('payments_events')
    .select('id, user_id, provider, provider_ref, type, status, plan_key, created_at, currency, amount_minor')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true })
    .limit(opts.limitEvents ?? 5000)

  if (e1) throw e1

  const events = (eventsRaw ?? []) as PaymentEventRow[]

  const byRef = groupBy(events, (x) => x.provider_ref || `user:${x.user_id ?? 'unknown'}`)
  const actions: ReconAction[] = []

  for (const [reference, rows] of byRef.entries()) {
    const latest = rows[rows.length - 1]
    const userId = latest.user_id
    const planKey = latest.plan_key
    const tier = tierFromPlanKey(planKey)

    if (!userId || !planKey) {
      actions.push(
        makeAction({
          type: 'skip_bad_ref',
          provider: latest.provider,
          provider_ref: reference,
          user_id: userId,
          plan_key: planKey,
          tier,
          currency: latest.currency ?? null,
        }),
      )
      continue
    }

    const desired = desiredStateFromEvents(rows)
    const current = await fetchCurrentEntitlement(userId)

    if (desired === 'grant' && !current.activePaid) {
      actions.push(
        makeAction({
          type: 'grant_needed',
          provider: latest.provider,
          provider_ref: reference,
          user_id: userId,
          plan_key: planKey,
          tier,
          currency: latest.currency ?? null,
        }),
      )
      if (!opts.dryRun) {
        await grantEntitlement(userId, reference, planKey)
      }
    } else if (desired === 'revoke' && current.activePaid) {
      actions.push(
        makeAction({
          type: 'revoke_needed',
          provider: latest.provider,
          provider_ref: reference,
          user_id: userId,
          plan_key: planKey,
          tier: current.activePaid.tier,
          currency: latest.currency ?? null,
        }),
      )
      if (!opts.dryRun) {
        await revokeEntitlement(userId, reference)
      }
    } else {
      actions.push(
        makeAction({
          type: 'ok_no_change',
          provider: latest.provider,
          provider_ref: reference,
          user_id: userId,
          plan_key: planKey,
          tier,
          currency: latest.currency ?? null,
        }),
      )
    }
  }

  // 2) Detect orphan entitlements with no recent success event
  const orphans = await findOrphanEntitlements(sinceIso)
  for (const ent of orphans) {
    actions.push(
      makeAction({
        type: 'revoke_orphan',
        provider: 'system_recon',
        provider_ref: null,
        user_id: ent.user_id,
        plan_key: ent.plan_key,
        tier: ent.tier,
        currency: null,
      }),
    )
    if (!opts.dryRun) {
      await revokeEntitlement(ent.user_id, `recon_orphan_${ent.user_id}_${ts()}`)
    }
  }

  // 3) Write reconciliation log
  const logged = await logReconciliation(actions, !!opts.dryRun)

  return { ok: true, lookedBackDays: lookbackDays, sinceIso, actions, logged }
}

// ------------------ Core helpers ------------------

function desiredStateFromEvents(rows: PaymentEventRow[]): DesiredState {
  // Look at normalized event type plus any legacy status strings
  let state: DesiredState = 'none'

  for (const r of rows) {
    const s = (r.status ?? '').toLowerCase()
    const t = (r.type ?? '').toLowerCase()

    // Normalized event types
    if (t === 'payment_succeeded' || t === 'subscription_created' || t === 'subscription_updated') {
      state = 'grant'
    }
    if (t === 'payment_refunded' || t === 'subscription_canceled') {
      state = 'revoke'
    }

    // Legacy or internal statuses
    if (s.includes('entitlement_granted')) state = 'grant'
    if (s.includes('webhook_received') && state === 'none') state = 'grant'
    if (s.includes('entitlement_revoked')) state = 'revoke'
    if (s.includes('refund') || s.includes('cancellation') || s.includes('cancel')) state = 'revoke'
  }

  return state
}

function tierFromPlanKey(planKey: PlanKey | null): Tier | null {
  if (!planKey) return null
  if (planKey.startsWith('vip')) return 'vip'
  if (planKey.startsWith('pro')) return 'pro'
  return null
}

async function fetchCurrentEntitlement(userId: string): Promise<{ activePaid: EntitlementRow | null }> {
  const { data, error } = await supabase
    .from('entitlements')
    .select('user_id, tier, active, reference, plan_key')
    .eq('user_id', userId)
    .eq('active', true)

  if (error) throw error

  const rows = (data ?? []) as EntitlementRow[]
  const activePaid = rows.find((r) => r.tier === 'vip' || r.tier === 'pro') ?? null
  return { activePaid }
}

async function grantEntitlement(userId: string, reference: string, planKey: PlanKey): Promise<void> {
  const tier = tierFromPlanKey(planKey) ?? 'pro'

  const { error } = await supabase.rpc('grant_entitlement', {
    p_user_id: userId,
    p_tier: tier,
    p_source: 'reconciliation',
    p_reference: reference,
  })

  if (error) throw error

  await appendPaymentsEvent(userId, reference, planKey, 'entitlement_granted')
}

async function revokeEntitlement(userId: string, reference: string): Promise<void> {
  const { error } = await supabase.rpc('revoke_entitlement', {
    p_user_id: userId,
    p_source: 'reconciliation',
    p_reference: reference,
  })

  if (error) throw error

  await appendPaymentsEvent(userId, reference, null, 'entitlement_revoked')
}

async function appendPaymentsEvent(
  userId: string | null,
  reference: string | null,
  planKey: PlanKey | null,
  status: 'entitlement_granted' | 'entitlement_revoked',
): Promise<void> {
  try {
    await supabase.from('payments_events').insert({
      user_id: userId,
      provider: 'system_recon',
      provider_ref: reference,
      type: status === 'entitlement_granted' ? 'subscription_updated' : 'subscription_canceled',
      status,
      plan_key: planKey,
      raw: null,
    })
  } catch (e) {
    console.error('appendPaymentsEvent failed', e)
  }
}

async function logReconciliation(actions: ReconAction[], dryRun: boolean): Promise<number> {
  try {
    const actionsJson: JsonArray = actions as unknown as JsonArray
    const { error } = await supabase.from('reconciliation_log').insert({
      batch_id: rid(),
      dry_run: dryRun,
      actions_json: actionsJson,
      created_at: new Date().toISOString(),
    })
    if (error) throw error
    return actions.length
  } catch (e) {
    console.error('logReconciliation failed', e)
    return 0
  }
}

async function findOrphanEntitlements(sinceIso: string): Promise<OrphanEntitlement[]> {
  // Entitlements that are active but without any recent success event in the window
  const { data: entsRaw, error: e1 } = await supabase
    .from('entitlements')
    .select('user_id, tier, reference, plan_key')
    .eq('active', true)

  if (e1) throw e1

  const { data: evsRaw, error: e2 } = await supabase
    .from('payments_events')
    .select('user_id, type, status, created_at')
    .gte('created_at', sinceIso)

  if (e2) throw e2

  const ents = (entsRaw ?? []) as EntitlementRow[]
  const evs = (evsRaw ?? []) as Array<{ user_id: string | null; type: string | null; status: string | null }>

  const okUsers = new Set(
    evs
      .filter((e) => {
        const t = (e.type ?? '').toLowerCase()
        const s = (e.status ?? '').toLowerCase()
        if (t === 'payment_succeeded' || t === 'subscription_created' || t === 'subscription_updated') return true
        if (s.includes('entitlement_granted') || s.includes('payment_succeeded')) return true
        return false
      })
      .map((e) => e.user_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )

  return ents
    .filter((e) => e.tier !== 'free')
    .filter((e) => !okUsers.has(e.user_id))
    .map((e) => ({
      user_id: e.user_id,
      plan_key: e.plan_key,
      tier: e.tier,
    }))
}

// ------------------ Utility helpers ------------------

function makeAction(input: {
  type: ReconActionType
  provider?: string | null
  provider_ref?: string | null
  user_id?: string | null
  plan_key?: PlanKey | null
  tier?: Tier | null
  currency?: string | null
}): ReconAction {
  return {
    id: rid(),
    type: input.type,
    provider: input.provider ?? null,
    provider_ref: input.provider_ref ?? null,
    user_id: input.user_id ?? null,
    plan_key: input.plan_key ?? null,
    tier: input.tier ?? null,
    currency: input.currency ?? null,
    at: new Date().toISOString(),
  }
}

function groupBy<T>(arr: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const item of arr) {
    const k = key(item)
    const existing = m.get(k)
    if (existing) {
      existing.push(item)
    } else {
      m.set(k, [item])
    }
  }
  return m
}

function rid(): string {
  return crypto.randomBytes(8).toString('hex')
}

function daysAgo(from: Date, days: number): Date {
  const d = new Date(from)
  d.setUTCDate(d.getUTCDate() - days)
  return d
}

function ts(): number {
  return Math.floor(Date.now() / 1000)
}

// --------------- CLI ---------------
if (require.main === module) {
  runReconciliation()
    .then((r) => console.log('[reconcile] ok', r.actions.length, 'actions'))
    .catch((e) => {
      console.error('[reconcile] error', e)
      process.exit(1)
    })
}
