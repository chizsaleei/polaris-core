/**src\server\cron\drip-dispatch.ts
 * Polaris Core - Drip and Recap Dispatcher
 * Schedules and dispatches weekly recap emails and simple drip nudges.
 *
 * Sources:
 *  - Grading contract thresholds (see src/core/prompts/grading.md)
 *  - Events and attempts in Supabase
 * Responsibilities:
 *  - Build weekly recap card (3 drills, 1 vocab, 1 reflection) using thresholds
 *  - Create email payloads and push to `drip_queue` for an outbox worker
 *  - Lightweight daily nudges for streaks and plan upgrade hints
 *  - Idempotency per user per campaign window
 */

import { createClient } from '@supabase/supabase-js'
import { ENV } from '../../config/env'
import { Tier, CoachKey, JSONArray, JSONObject } from '../../types'

// Optional mail providers. We default to outbox table so Next.js or a worker can send via Resend/SendGrid later.
// import { Resend } from 'resend'

const supabase = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: 'public' },
  auth: { persistSession: false, autoRefreshToken: false },
})

// Local wrapper for provider without using `any`
type EnvWithDrip = typeof ENV & { DRIP_PROVIDER?: string }
const DRIP_PROVIDER: string = (ENV as EnvWithDrip).DRIP_PROVIDER ?? 'outbox'
const DEFAULT_COACH: CoachKey = 'colton_covey'

// JSON helper type
type JsonValue = string | number | boolean | null | JSONObject | JSONArray

export interface DripJobOptions {
  now?: Date
  dryRun?: boolean
  limitUsers?: number
}

export async function runDripDispatch(opts: DripJobOptions = {}) {
  const now = opts.now ?? new Date()
  const isoNow = now.toISOString()

  // Campaign windows
  const startOfWeek = startOfIsoWeek(now)
  const endOfWeek = new Date(startOfWeek)
  endOfWeek.setUTCDate(endOfWeek.getUTCDate() + 7)

  // 1) Fetch active users with recent activity or active entitlements
  const users = await fetchCohort(opts.limitUsers)

  const results: Array<{ user_id: string; email?: string | null; queued: number; skipped?: string }> = []

  for (const u of users) {
    const alreadyThere = await isQueued(u.user_id, startOfWeek)
    if (alreadyThere) {
      results.push({ user_id: u.user_id, email: u.email, queued: 0, skipped: 'already_queued' })
      continue
    }

    // 2) Pull attempts and sessions for last 14 days to compute recap
    const { attempts, metrics } = await fetchAttemptsAndMetrics(u.user_id, daysAgo(now, 14))

    // 3) Build recap selection according to thresholds
    const recap = buildWeeklyRecap(u.user_id, attempts, metrics)

    // 4) Compose subject and template data
    const subject = buildSubjectLine(recap, metrics)
    const template = buildEmailTemplate(u.first_name ?? 'there', recap, metrics)

    // JSON-safe metrics for meta
    const metricsJson = toJsonMetrics(metrics)
    const meta: JSONObject = toJson({ coach_key: recap.primaryCoach ?? null, metrics: metricsJson })

    // 5) Queue to outbox
    const queued = await enqueueEmail({
      user_id: u.user_id,
      to: u.email,
      subject,
      template,
      category: 'weekly_recap',
      window_start: startOfWeek.toISOString(),
      window_end: endOfWeek.toISOString(),
      meta,
      dryRun: !!opts.dryRun,
    })

    results.push({ user_id: u.user_id, email: u.email, queued })
  }

  return { ok: true, count: results.length, results, at: isoNow }
}

// -------------------- Data access --------------------

type CohortUser = {
  user_id: string
  tier: Tier
  email: string | null
  first_name: string | null
}

async function fetchCohort(limit?: number): Promise<CohortUser[]> {
  // Users with active entitlement OR any attempt in last 14 days
  const { data: entRaw, error: e1 } = await supabase
    .from('entitlements')
    .select('user_id, tier, profiles:profiles(email, first_name)')
    .eq('active', true)
    .limit(limit ?? 1000)

  if (e1) throw e1

  const ent: CohortUser[] = (entRaw ?? [])
    .map(normalizeCohortRow)
    .filter((row): row is CohortUser => Boolean(row))

  // Map and de-dup
  const map = new Map<string, CohortUser>()
  for (const row of ent) {
    map.set(row.user_id, {
      user_id: row.user_id,
      tier: row.tier,
      email: row.email,
      first_name: row.first_name,
    })
  }

  return Array.from(map.values())
}

const TIER_VALUES = new Set<string>(Object.values(Tier))

type ProfileShape = { email: string | null; first_name: string | null } | null

function normalizeCohortRow(row: unknown): CohortUser | null {
  if (!row || typeof row !== 'object') return null
  const record = row as { user_id?: unknown; tier?: unknown; profiles?: unknown }
  if (typeof record.user_id !== 'string' || !isTierValue(record.tier)) return null
  const profile = normalizeProfile(record.profiles)
  return {
    user_id: record.user_id,
    tier: record.tier,
    email: profile?.email ?? null,
    first_name: profile?.first_name ?? null,
  }
}

function normalizeProfile(input: unknown): ProfileShape {
  if (!input) return null
  if (Array.isArray(input)) {
    return normalizeProfile(input[0])
  }
  if (typeof input === 'object') {
    const obj = input as { email?: unknown; first_name?: unknown }
    const emailValue = obj.email
    const firstNameValue = obj.first_name
    const email =
      typeof emailValue === 'string' ? emailValue : emailValue === null ? null : null
    const first_name =
      typeof firstNameValue === 'string' ? firstNameValue : firstNameValue === null ? null : null
    return { email, first_name }
  }
  return null
}

function isTierValue(value: unknown): value is Tier {
  return typeof value === 'string' && TIER_VALUES.has(value)
}

type AttemptRow = {
  id: string
  coach_key: CoachKey | null
  overall_score: number | null
  created_at: string
  time_on_task_seconds: number | null
  words_per_minute: number | null
  helpfulness_rating: number | null
  expressions_count: number | null
}

async function fetchAttemptsAndMetrics(userId: string, since: Date) {
  const sinceIso = since.toISOString()

  const { data: attemptsRaw, error: eA } = await supabase
    .from('attempts')
    .select(
      'id, coach_key, overall_score, created_at, time_on_task_seconds, words_per_minute, helpfulness_rating, expressions_count',
    )
    .eq('user_id', userId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false })

  if (eA) throw eA

  const attempts = (attemptsRaw ?? []) as AttemptRow[]

  // Aggregate metrics for subject lines and trends
  const metrics = summarizeMetrics(attempts)
  return { attempts, metrics }
}

function summarizeMetrics(atts: AttemptRow[]) {
  const total = atts.length
  const avgScore = mean(atts.map((a) => a.overall_score).filter(isNum), 0)
  const avgWpm = mean(atts.map((a) => a.words_per_minute).filter(isNum), null)
  const totalExpr = sum(atts.map((a) => a.expressions_count ?? 0))
  const latestCoach = atts[0]?.coach_key ?? null
  const lowScores = atts.filter((a) => (a.overall_score ?? 0) < 60).length
  return { total, avgScore, avgWpm, totalExpr, latestCoach, lowScores }
}

// -------------------- Recap logic --------------------

interface WeeklyRecap {
  primaryCoach: CoachKey | null
  picks: Array<{ type: 'drill' | 'vocab' | 'reflection'; title: string; prompt?: string; coach: CoachKey }>
}

function buildWeeklyRecap(
  userId: string,
  attempts: AttemptRow[],
  _metrics: ReturnType<typeof summarizeMetrics>,
): WeeklyRecap {
  // Threshold rules from grading.md
  // - overall_score under 60 with high helpfulness (we fall back to under 60 alone)
  // - expressions_count under 3
  // - time_on_task under 40 percent of target (assume target ~ 10 minutes)

  const targetSeconds = 10 * 60
  const underScore = attempts.filter((a) => (a.overall_score ?? 0) < 60)
  const lowExpr = attempts.filter((a) => (a.expressions_count ?? 0) < 3)
  const shortTime = attempts.filter((a) => (a.time_on_task_seconds ?? 0) < targetSeconds * 0.4)

  // Choose primary coach by most recent attempt, fallback to null
  const primaryCoach = attempts[0]?.coach_key ?? null

  const picks: WeeklyRecap['picks'] = []

  // 3 drills
  for (const src of [underScore[0], lowExpr[0], shortTime[0]]) {
    if (!src) continue
    const coach = src.coach_key ?? primaryCoach ?? DEFAULT_COACH
    const drillTitle = pickDrillTitleForCoach(coach)
    picks.push({ type: 'drill', title: drillTitle, prompt: undefined, coach })
  }

  // fill if fewer than 3
  while (picks.filter((p) => p.type === 'drill').length < 3) {
    const coach = primaryCoach ?? DEFAULT_COACH
    picks.push({ type: 'drill', title: pickDrillTitleForCoach(coach), coach })
  }

  // 1 vocab review
  picks.push({
    type: 'vocab',
    title: 'Vocabulary review',
    prompt: 'Review your Expressions Pack. Favorite two items and retry aloud.',
    coach: primaryCoach ?? DEFAULT_COACH,
  })

  // 1 reflection
  picks.push({
    type: 'reflection',
    title: 'Weekly reflection',
    prompt: 'Two wins, one fix, one next action with a time cue.',
    coach: primaryCoach ?? DEFAULT_COACH,
  })

  return { primaryCoach, picks }
}

function pickDrillTitleForCoach(coach: CoachKey): string {
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

// -------------------- Email composition --------------------

function buildSubjectLine(recap: WeeklyRecap, metrics: ReturnType<typeof summarizeMetrics>) {
  const coach = recap.primaryCoach?.replaceAll('_', ' ') ?? 'your coach'
  if (metrics.total === 0) return `Your weekly plan is ready`
  if (metrics.lowScores > 0) return `A focused plan for stronger scores`
  if ((metrics.totalExpr ?? 0) < 6) return `Save more expressions this week`
  return `Keep momentum with ${coach}`
}

function buildEmailTemplate(firstName: string, recap: WeeklyRecap, metrics: ReturnType<typeof summarizeMetrics>) {
  return {
    template_id: 'weekly_recap_v1',
    data: {
      greeting: `Hi ${firstName},`,
      intro:
        metrics.total > 0
          ? `Here is a short plan from your coach based on last week's practice.`
          : `Welcome back. Here is a simple plan to get started.`,
      picks: recap.picks,
      tip: tipForCoach(recap.primaryCoach),
      cta_url: `${ENV.APP_BASE_URL}/dashboard?tab=recap`,
      footer: `This plan is tailored to your recent drills. You can change coaches anytime from Explore.`,
    },
  }
}

function tipForCoach(coach: CoachKey | null): string {
  switch (coach) {
    case 'chelsea_lightbown':
      return 'Use linking words and aim for steady pacing. Record and re-listen once.'
    case 'carter_goleman':
      return 'Use STAR and add one number in the Result line.'
    case 'dr_clark_atul':
      return 'Lead with SBAR. Name one red flag early.'
    case 'dr_crystal_benner':
      return 'Use ISBAR and a teach back question for patient talks.'
    case 'christopher_buffett':
      return 'Plain English. Position, Evidence, Risk, Recommendation.'
    case 'colton_covey':
      return 'Intent, Context, Proposal, Ask. Keep it under two minutes.'
    case 'cody_turing':
      return 'Expand acronyms once. State one tradeoff.'
    case 'dr_claire_swales':
      return 'Motivation, Question, Method, Impact, Fit. One citation helps.'
    case 'chase_krashen':
      return 'PEEL: Point, Evidence, Explain, Link. One example.'
    case 'chloe_sinek':
      return 'Purpose, Values, Next action, Safeguard. Calm and clear.'
    default:
      return 'Keep it short and specific. One step at a time.'
  }
}

// -------------------- Outbox and idempotency --------------------

async function isQueued(userId: string, windowStart: Date) {
  const { data, error } = await supabase
    .from('drip_queue')
    .select('id')
    .eq('user_id', userId)
    .eq('category', 'weekly_recap')
    .gte('window_start', windowStart.toISOString())
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

async function enqueueEmail(input: {
  user_id: string
  to?: string | null
  subject: string
  template: JSONObject
  category: 'weekly_recap' | 'nudge_streak' | 'upgrade_hint'
  window_start: string
  window_end: string
  meta?: JSONObject
  dryRun: boolean
}) {
  if (input.dryRun) {
    console.log('[drip][dry-run]', input.user_id, input.subject)
    return 0
  }

  const { error } = await supabase.from('drip_queue').insert({
    user_id: input.user_id,
    to_email: input.to ?? null,
    subject: input.subject,
    template_json: input.template,
    category: input.category,
    window_start: input.window_start,
    window_end: input.window_end,
    meta: input.meta ?? null,
    provider: DRIP_PROVIDER,
    status: 'queued',
  })
  if (error) throw error
  return 1
}

// -------------------- Small helpers --------------------

function toJsonMetrics(m: ReturnType<typeof summarizeMetrics>): JSONObject {
  const obj: { [k: string]: JsonValue } = {
    total: m.total,
    avgScore: m.avgScore,
    avgWpm: m.avgWpm,
    totalExpr: m.totalExpr,
    latestCoach: m.latestCoach, // may be null, never undefined
    lowScores: m.lowScores,
  }
  return obj as JSONObject
}

function toJson(o: Record<string, JsonValue>): JSONObject {
  return o as JSONObject
}

function startOfIsoWeek(d: Date) {
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = copy.getUTCDay() || 7 // Mon..Sun as 1..7
  if (day !== 1) copy.setUTCDate(copy.getUTCDate() - (day - 1))
  return copy
}

function daysAgo(from: Date, days: number) {
  const d = new Date(from)
  d.setUTCDate(d.getUTCDate() - days)
  return d
}

function mean(arr: number[], fallback: number | null): number | null {
  const xs = arr.filter((x) => Number.isFinite(x))
  if (xs.length === 0) return fallback
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function sum(arr: number[]) {
  return arr.reduce((a, b) => a + b, 0)
}

function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

// --------------- CLI ---------------
if (require.main === module) {
  runDripDispatch()
    .then((r) => console.log('[drip] done', r.count))
    .catch((e) => {
      console.error('[drip] error', e)
      process.exit(1)
    })
}
