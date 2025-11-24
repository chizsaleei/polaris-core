/** src\server\cron\weekly-summary.ts
 * Polaris Core - Weekly Summary Builder
 *
 * Goal
 *  - For each active user, compute a weekly practice summary
 *  - Store an immutable JSON snapshot for dashboards and email rendering
 *  - Optionally queue a lightweight email handoff to the outbox
 *
 * Inputs
 *  - attempts, sessions, analytics events in Supabase
 *  - grading thresholds from src/core/prompts/grading.md (mirrored here where needed)
 *
 * Outputs
 *  - weekly_summaries table row per user-week
 *  - optional drip_queue enqueue with category "weekly_summary"
 */

import { createClient } from '@supabase/supabase-js'
import { ENV } from '../../config/env'
import { Tier, CoachKey } from '../../types'
import crypto from 'crypto'

// ---------- Shared types for API/UI ----------

export interface WeeklySummaryOptions {
  weekStart?: Date // default: start of current ISO week (Mon)
  dryRun?: boolean // if true do not write to DB
  limitUsers?: number // limit cohort size for testing
  enqueueEmail?: boolean // if true enqueue an outbox email
}

export interface WeeklySummaryJobResult {
  ok: boolean
  week_start: string
  week_end: string
  processed: number
  wrote: number
  enqueued: number
}

export interface WeeklySummaryCohortUser {
  user_id: string
  tier: Tier
  email: string | null
  first_name: string | null
}

export interface WeeklySummaryMetrics {
  total_sessions: number
  total_attempts: number
  total_minutes: number | null
  avg_score: number | null
  avg_wpm: number | null
  total_expressions: number
  helpfulness_avg: number | null
  weekly_streak: number
}

export interface WeeklySummaryCoachStats {
  attempts: number
  avg_score: number | null
  minutes: number | null
}

export type WeeklySummaryPickType = 'drill' | 'vocab' | 'reflection'

export interface WeeklySummaryPick {
  type: WeeklySummaryPickType
  title: string
  coach: CoachKey
}

export interface WeeklySummaryWpmPoint {
  t: string
  wpm: number
}

export interface WeeklySummaryRange {
  start: string
  end: string
}

/**
 * JSON-shaped payload stored in `weekly_summaries.summary_json`
 * and sent to the frontend.
 */
export interface WeeklySummaryPayload {
  range: WeeklySummaryRange
  metrics: WeeklySummaryMetrics
  coach_breakdown: Record<CoachKey, WeeklySummaryCoachStats>
  last_coach: CoachKey | null
  picks: WeeklySummaryPick[]
  wpm_trend: WeeklySummaryWpmPoint[]
}

// ---------- Supabase client ----------

const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false, autoRefreshToken: false },
})

// ---------- Row types from Supabase ----------

interface EntRow {
  user_id: string
  tier: Tier
  profiles: unknown
}

interface AttemptRow {
  id: string
  coach_key: CoachKey
  created_at: string
  overall_score: number | null
  time_on_task_seconds: number | null
  words_per_minute: number | null
  expressions_count: number | null
  helpfulness_rating: number | null
}

interface SessionRow {
  id: string
  coach_key: CoachKey
  started_at: string
  finished_at: string | null
  tier: Tier | null
}

interface EventRow {
  name: string
  created_at: string
}

// ---------- Main job ----------

export async function runWeeklySummary(
  opts: WeeklySummaryOptions = {},
): Promise<WeeklySummaryJobResult> {
  const startOfWeek = opts.weekStart ? startOfIsoWeek(opts.weekStart) : startOfIsoWeek(new Date())
  const endOfWeek = new Date(startOfWeek)
  endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 7)

  const cohort = await fetchCohort(opts.limitUsers)

  const batchId = rid()
  const results: Array<{ user_id: string; wrote: boolean; enqueued?: boolean; reason?: string }> =
    []

  for (const u of cohort) {
    // idempotency: if a summary already exists for this user-week, skip
    const exists = await hasSummary(u.user_id, startOfWeek)
    if (exists) {
      results.push({ user_id: u.user_id, wrote: false, reason: 'already_exists' })
      continue
    }

    const data = await buildUserWeeklySummary(u.user_id, startOfWeek, endOfWeek)

    if (!opts.dryRun) {
      await insertWeeklySummary({
        user_id: u.user_id,
        week_start: startOfWeek.toISOString(),
        week_end: endOfWeek.toISOString(),
        payload: data,
        batch_id: batchId,
      })
    }

    let enqueued = false
    if (opts.enqueueEmail && !opts.dryRun) {
      enqueued = await enqueueWeeklyEmail({
        user_id: u.user_id,
        to: u.email ?? null,
        first_name: u.first_name ?? 'there',
        summary: data,
        week_start: startOfWeek.toISOString(),
        week_end: endOfWeek.toISOString(),
      })
    }

    results.push({ user_id: u.user_id, wrote: !opts.dryRun, enqueued })
  }

  const wroteCount = results.filter((r) => r.wrote).length
  const enqueuedCount = results.filter((r) => r.enqueued).length

  await logMaintenance({
    job: 'weekly_summary',
    batchId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun: !!opts.dryRun,
    processed: results.length,
    wrote: wroteCount,
    enqueued: enqueuedCount,
  })

  return {
    ok: true,
    week_start: startOfWeek.toISOString(),
    week_end: endOfWeek.toISOString(),
    processed: results.length,
    wrote: wroteCount,
    enqueued: enqueuedCount,
  }
}

// ---------- Data access ----------

async function fetchCohort(limit?: number): Promise<WeeklySummaryCohortUser[]> {
  // Users with active entitlement
  const { data, error } = await supabase
    .from('entitlements')
    .select('user_id, tier, profiles:profiles(email, first_name)')
    .eq('active', true)
    .limit(limit ?? 1000)

  if (error) throw error

  const rows = (data ?? []) as EntRow[]

  const unique = new Map<string, WeeklySummaryCohortUser>()
  for (const r of rows) {
    const profile = normalizeProfile(r.profiles)
    unique.set(r.user_id, {
      user_id: r.user_id,
      tier: r.tier,
      email: profile.email,
      first_name: profile.first_name,
    })
  }
  return Array.from(unique.values())
}

async function hasSummary(userId: string, weekStart: Date): Promise<boolean> {
  const { data, error } = await supabase
    .from('weekly_summaries')
    .select('id')
    .eq('user_id', userId)
    .eq('week_start', weekStart.toISOString())
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

async function insertWeeklySummary(input: {
  user_id: string
  week_start: string
  week_end: string
  payload: WeeklySummaryPayload
  batch_id: string
}): Promise<void> {
  const { error } = await supabase.from('weekly_summaries').insert({
    user_id: input.user_id,
    week_start: input.week_start,
    week_end: input.week_end,
    summary_json: input.payload,
    batch_id: input.batch_id,
  })
  if (error) throw error
}

// ---------- Builder ----------

async function buildUserWeeklySummary(
  userId: string,
  start: Date,
  end: Date,
): Promise<WeeklySummaryPayload> {
  const since = start.toISOString()
  const until = end.toISOString()

  // Attempts in the window
  const { data: attempts, error: eA } = await supabase
    .from('attempts')
    .select(
      'id, coach_key, created_at, overall_score, time_on_task_seconds, words_per_minute, expressions_count, helpfulness_rating',
    )
    .eq('user_id', userId)
    .gte('created_at', since)
    .lt('created_at', until)
    .order('created_at', { ascending: true })

  if (eA) throw eA

  // Sessions in the window
  const { data: sessions, error: eS } = await supabase
    .from('sessions')
    .select('id, coach_key, started_at, finished_at, tier')
    .eq('user_id', userId)
    .gte('started_at', since)
    .lt('started_at', until)
    .order('started_at', { ascending: true })

  if (eS) throw eS

  // Events in the window for streak and day completed
  const { data: events, error: eE } = await supabase
    .from('events')
    .select('name, created_at')
    .eq('user_id', userId)
    .gte('created_at', since)
    .lt('created_at', until)

  if (eE) throw eE

  const att = (attempts ?? []) as AttemptRow[]
  const sess = (sessions ?? []) as SessionRow[]
  const evs = (events ?? []) as EventRow[]

  // Metrics
  const totalAttempts = att.length
  const totalSessions = sess.length
  const totalTimeSeconds = sum(att.map((a) => a.time_on_task_seconds ?? 0))
  const totalMinutes = round2(totalTimeSeconds / 60)

  const avgScore = round1(mean(att.map((a) => a.overall_score).filter(isNum), null))
  const avgWpm = mean(att.map((a) => a.words_per_minute).filter(isNum), null)
  const totalExpressions = sum(att.map((a) => a.expressions_count ?? 0))
  const helpAvg = mean(att.map((a) => a.helpfulness_rating).filter(isNum), null)

  // Coach breakdown
  const byCoach = group(att, (a) => a.coach_key)
  const coachBreakdown: Record<CoachKey, WeeklySummaryCoachStats> = {} as Record<
    CoachKey,
    WeeklySummaryCoachStats
  >

  for (const [coach, rows] of byCoach.entries()) {
    const attemptsCount = rows.length
    const avgScorePerCoach = round1(
      mean(
        rows.map((r) => r.overall_score).filter(isNum),
        null,
      ),
    )
    const minutesPerCoach = round2(sum(rows.map((r) => r.time_on_task_seconds ?? 0)) / 60)
    coachBreakdown[coach] = {
      attempts: attemptsCount,
      avg_score: avgScorePerCoach,
      minutes: minutesPerCoach,
    }
  }

  // Day completed streak inside the week
  const days = new Set(
    evs
      .filter((e) => e.name === 'day_completed')
      .map((e) => toLocalISODate(e.created_at)),
  )
  const weeklyStreak = days.size

  // Threshold based suggestions
  const picks = suggestPicks(att)

  // WPM trend
  const wpmTrend = buildWpmTrend(att)

  const lastCoach: CoachKey | null = att.length > 0 ? att[att.length - 1].coach_key ?? null : null

  const payload: WeeklySummaryPayload = {
    range: { start: since, end: until },
    metrics: {
      total_sessions: totalSessions,
      total_attempts: totalAttempts,
      total_minutes: totalMinutes,
      avg_score: avgScore,
      avg_wpm: avgWpm,
      total_expressions: totalExpressions,
      helpfulness_avg: helpAvg,
      weekly_streak: weeklyStreak,
    },
    coach_breakdown: coachBreakdown,
    last_coach: lastCoach,
    picks,
    wpm_trend: wpmTrend,
  }

  return payload
}

// Suggest 3 drills + vocab + reflection using simple rules from grading.md
function suggestPicks(attempts: AttemptRow[]): WeeklySummaryPick[] {
  const targetSeconds = 10 * 60
  const underScore = attempts.filter((a) => (a.overall_score ?? 0) < 60)
  const lowExpr = attempts.filter((a) => (a.expressions_count ?? 0) < 3)
  const shortTime = attempts.filter((a) => (a.time_on_task_seconds ?? 0) < targetSeconds * 0.4)

  const primaryCoach: CoachKey | null =
    attempts.length > 0 ? attempts[attempts.length - 1].coach_key ?? null : null

  const picks: WeeklySummaryPick[] = []

  for (const src of [underScore[0], lowExpr[0], shortTime[0]]) {
    if (!src) continue
    const coach = src.coach_key
    picks.push({ type: 'drill', title: defaultDrillTitle(coach), coach })
  }

  while (picks.filter((p) => p.type === 'drill').length < 3) {
    const coach = primaryCoach ?? 'colton_covey'
    picks.push({ type: 'drill', title: defaultDrillTitle(coach), coach })
  }

  picks.push({ type: 'vocab', title: 'Vocabulary review', coach: primaryCoach ?? 'colton_covey' })
  picks.push({
    type: 'reflection',
    title: 'Weekly reflection',
    coach: primaryCoach ?? 'colton_covey',
  })

  return picks
}

function defaultDrillTitle(coach: CoachKey): string {
  switch (coach) {
    case 'carter_goleman':
      return 'Two minute STAR sprint'
    case 'chase_krashen':
      return '60 second mini lecture'
    case 'chelsea_lightbown':
      return 'IELTS Part 2 long turn'
    case 'dr_clark_atul':
      return 'ICU case presentation'
    case 'dr_crystal_benner':
      return 'ISBAR shift handoff'
    case 'christopher_buffett':
      return 'Two minute market wrap'
    case 'colton_covey':
      return 'Five slide strategy pitch'
    case 'cody_turing':
      return 'Architecture walkthrough'
    case 'dr_claire_swales':
      return 'Three minute research pitch'
    case 'chloe_sinek':
      return 'Life vision speech'
    default:
      return 'Practice Now selection'
  }
}

function buildWpmTrend(attempts: AttemptRow[]): WeeklySummaryWpmPoint[] {
  return attempts
    .filter((a): a is AttemptRow & { words_per_minute: number } => isNum(a.words_per_minute))
    .map((a) => ({ t: a.created_at, wpm: a.words_per_minute }))
}

// ---------- Email outbox ----------

async function enqueueWeeklyEmail(input: {
  user_id: string
  to: string | null
  first_name: string
  summary: WeeklySummaryPayload
  week_start: string
  week_end: string
}): Promise<boolean> {
  const { error } = await supabase.from('drip_queue').insert({
    user_id: input.user_id,
    to_email: input.to,
    subject: `Your weekly summary is ready`,
    template_json: {
      template_id: 'weekly_summary_v1',
      data: {
        greeting: `Hi ${input.first_name},`,
        intro: `Here is your weekly summary and a short plan to keep momentum.`,
        summary: input.summary,
        cta_url: `${ENV.APP_BASE_URL}/dashboard?tab=recap`,
      },
    },
    category: 'weekly_summary',
    window_start: input.week_start,
    window_end: input.week_end,
    provider: 'outbox',
    status: 'queued',
  })
  if (error) {
    console.error('[weekly-summary] enqueue failed', error)
    return false
  }
  return true
}

// ---------- Logging ----------

async function logMaintenance(input: {
  job: 'weekly_summary'
  batchId: string
  startedAt: string
  finishedAt: string
  dryRun: boolean
  processed: number
  wrote: number
  enqueued: number
}): Promise<void> {
  try {
    const { error } = await supabase.from('maintenance_log').insert({
      job: input.job,
      batch_id: input.batchId,
      dry_run: input.dryRun,
      results_json: {
        processed: input.processed,
        wrote: input.wrote,
        enqueued: input.enqueued,
      },
      started_at: input.startedAt,
      finished_at: input.finishedAt,
    })
    if (error) console.error('[weekly-summary] log insert failed', error)
  } catch (e) {
    console.error('[weekly-summary] logMaintenance error', e)
  }
}

// ---------- Small helpers ----------

function startOfIsoWeek(d: Date): Date {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = copy.getUTCDay() || 7 // Mon..Sun as 1..7
  if (day !== 1) copy.setUTCDate(copy.getUTCDate() - (day - 1))
  return copy
}

function mean(arr: number[], fallback: number | null): number | null {
  const xs = arr.filter((x) => Number.isFinite(x))
  if (xs.length === 0) return fallback
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0)
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function round1(n: number | null): number | null {
  if (n === null) return null
  return Math.round(n * 10) / 10
}

function round2(n: number | null): number | null {
  if (n === null) return null
  return Math.round(n * 100) / 100
}

function toLocalISODate(iso: string): string {
  const d = new Date(iso)
  // Date component in YYYY-MM-DD (UTC based)
  return d.toISOString().slice(0, 10)
}

function group<T, K extends string>(arr: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const item of arr) {
    const k = key(item)
    const xs = m.get(k) || []
    xs.push(item)
    m.set(k, xs)
  }
  return m
}

function rid(): string {
  return crypto.randomBytes(8).toString('hex')
}

function normalizeProfile(p: unknown): { email: string | null; first_name: string | null } {
  if (p == null) return { email: null, first_name: null }

  let base: unknown = p
  if (Array.isArray(p)) {
    base = p[0] ?? null
  }

  if (!base || typeof base !== 'object') {
    return { email: null, first_name: null }
  }

  const record = base as Record<string, unknown>
  const email = typeof record.email === 'string' ? record.email : null
  const first_name = typeof record.first_name === 'string' ? record.first_name : null

  return { email, first_name }
}

// ---------- CLI ----------

if (require.main === module) {
  // Example:
  // ts-node src/server/cron/weekly-summary.ts
  runWeeklySummary({ enqueueEmail: true })
    .then((r) => console.log('[weekly-summary] ok', r))
    .catch((e) => {
      console.error('[weekly-summary] error', e)
      process.exit(1)
    })
}
