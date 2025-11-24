import { Router, type Request, type Response } from 'express'
import type { ParamsDictionary } from 'express-serve-static-core'
import { chat, type ChatMessage } from '../../../lib/openai'
import {
  composeCoachSystem,
  type PromptSettings,
  type RunContext,
} from '../../../core/prompts'
import { COACH_KEYS, DISCLAIMERS } from '../../../lib/constants'
import { createClient } from '../../../lib/supabase'
import {
  RateLimiter,
  type RateLimitRule,
  applyHeaders,
} from '../../../lib/rate-limit'
import {
  log,
  runWithRequestContext,
  safeError,
  getCorrelationId,
} from '../../../lib/logger'
import type { CoachKey as AppCoachKey } from '../../../types'
import type { CoachKey as PromptCoachKey } from '../../../core/prompts'
import type { AuthInfo } from '../../middleware/auth'

type ChatRequest = Request<ParamsDictionary> & { user?: AuthInfo }

interface ChatCoachBody {
  coach?: unknown
  coachId?: unknown
  coach_id?: unknown
  messages?: unknown
  context?: unknown
  settings?: unknown
}

const router = Router()
const supabase = createClient()

const DOCTOR_PROMPT_KEYS = new Set<PromptCoachKey>([
  'claire-swales',
  'clark-atul',
  'crystal-benner',
])

const PROMPT_TO_APP_KEY = (COACH_KEYS as readonly PromptCoachKey[]).reduce(
  (acc, promptKey) => {
    const base = promptKey.replace(/-/g, '_')
    const appKey = (
      DOCTOR_PROMPT_KEYS.has(promptKey)
        ? `dr_${base}`
        : base
    ) as AppCoachKey
    acc[promptKey] = appKey
    return acc
  },
  {} as Record<PromptCoachKey, AppCoachKey>,
)

const APP_TO_PROMPT_KEY = new Map<AppCoachKey, PromptCoachKey>(
  (Object.entries(PROMPT_TO_APP_KEY) as Array<[PromptCoachKey, AppCoachKey]>).map(
    ([prompt, app]) => [app, prompt],
  ),
)

const APP_COACH_KEY_SET = new Set<AppCoachKey>(
  Object.values(PROMPT_TO_APP_KEY),
)
const MAX_MESSAGES = 24
const MAX_SYSTEM_NOTES = 3
const MAX_CONTENT_LENGTH = 4_000

const CHAT_LIMIT_RULE: RateLimitRule = {
  windowMs: 60_000,
  max: 10,
  blockDurationMs: 5 * 60_000,
  prefix: 'chat:coach',
}
const chatLimiter = new RateLimiter(CHAT_LIMIT_RULE)

router.post('/', (req: ChatRequest, res: Response) => {
  const headerUserRaw = req.header('x-user-id')
  const headerUser =
    typeof headerUserRaw === 'string' ? headerUserRaw.trim() : undefined
  const contextUserId = req.user?.userId ?? headerUser

  void runWithRequestContext(
    { headers: req.headers, user_id: contextUserId },
    async () => {
      try {
        const userId =
          req.user?.userId ?? headerUser ?? (contextUserId ?? '')
        if (!userId) {
          sendError(res, 401, 'unauthorized', 'Missing user id')
          return
        }

        const rateKey = `user:${userId}`
        const rate = await chatLimiter.consume(rateKey)
        applyHeaders(res, rateKey, CHAT_LIMIT_RULE, rate)
        if (!rate.allowed) {
          sendError(
            res,
            429,
            'rate_limited',
            'Please slow down and try again shortly.',
          )
          return
        }

        const rawBody: unknown = req.body ?? {}
        if (!isPlainObject(rawBody)) {
          sendError(res, 400, 'invalid_payload', 'Request body must be an object.')
          return
        }
        const body = rawBody as ChatCoachBody

        const coach = sanitizeCoachKey(body.coach ?? body.coachId ?? body.coach_id)
        if (!coach) {
          sendError(res, 400, 'invalid_coach', 'Unknown coach id.')
          return
        }

        const messages = sanitizeMessages(body.messages)
        if (!messages.length) {
          sendError(
            res,
            400,
            'invalid_messages',
            'messages must include at least one item.',
          )
          return
        }
        const { systemExtras, chatMessages } = partitionSystemMessages(messages)
        if (!chatMessages.length || chatMessages.at(-1)?.role !== 'user') {
          sendError(res, 400, 'invalid_messages', 'Last message must come from the user.')
          return
        }

        const context = await expandContext(body.context, String(userId))
        const settings = sanitizeSettings(body.settings)

        const prompt = composeCoachSystem(
          toPromptCoachKey(coach),
          context,
          settings.prompt,
        )
        const systemPrompt = buildSystemPrompt(prompt.system, systemExtras)

        res.setHeader('Cache-Control', 'no-store')

        const result = await chat({
          model: settings.model,
          system: systemPrompt,
          messages: chatMessages,
          temperature: prompt.settings.temperature,
          maxTokens: prompt.settings.maxOutputTokens,
          json: prompt.settings.jsonMode,
          extra: settings.extra,
          timeoutMs: settings.timeoutMs,
        })

        if (!prompt.settings.jsonMode && !result.text) {
          sendError(res, 502, 'upstream_empty', 'Coach responded with no content.')
          return
        }

        const payload = {
          coach,
          tier: context.tier ?? 'free',
          message: {
            role: 'assistant' as const,
            content: result.text ?? '',
          },
          json: prompt.settings.jsonMode ? result.json ?? null : undefined,
          usage: result.usage,
          finish_reason: result.finish_reason,
          disclaimer: disclaimerFor(coach),
        }

        res.status(200).json({
          ok: true,
          data: payload,
          correlation_id: getCorrelationId(),
        })
      } catch (error) {
        log.error('chat/coach failed', { err: safeError(error) })
        sendError(res, 500, 'internal_error', 'Unable to reach the coach right now.')
      }
    },
  )
})

export default router

// ------------------------------ helpers ------------------------------

function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
    correlation_id: getCorrelationId(),
  })
}

function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeCoachKey(value: unknown): AppCoachKey | null {
  const raw = toLowerString(value)
  if (!raw) return null

  const normalized = raw.replace(/[\s-]+/g, '_')
  const candidates: string[] = [normalized]
  if (!normalized.startsWith('dr_')) {
    candidates.push(`dr_${normalized}`)
  }

  for (const candidate of candidates) {
    if (isAppCoachKey(candidate)) {
      return candidate
    }
  }

  return null
}

interface RawMessageLike {
  role?: unknown
  content?: unknown
}

function isRawMessageLike(value: unknown): value is RawMessageLike {
  return value != null && typeof value === 'object'
}

function sanitizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return []
  const allowedRoles: ChatMessage['role'][] = [
    'user',
    'assistant',
    'system',
    'tool',
  ]
  const out: ChatMessage[] = []

  for (const raw of input) {
    if (!isRawMessageLike(raw)) continue

    const roleStr = toLowerString(raw.role)
    if (!roleStr) continue
    const role = roleStr as ChatMessage['role']
    if (!allowedRoles.includes(role)) continue

    const content = toSafeString(raw.content) ?? ''

    const trimmed = content.replace(/\r/g, '').trim()
    if (!trimmed) continue

    out.push({
      role,
      content: trimmed.slice(0, MAX_CONTENT_LENGTH),
    })
    if (out.length >= MAX_MESSAGES) break
  }

  return out.slice(-MAX_MESSAGES)
}

function partitionSystemMessages(messages: ChatMessage[]) {
  const systemExtras: string[] = []
  const chatMessages: ChatMessage[] = []
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (systemExtras.length < MAX_SYSTEM_NOTES) {
        systemExtras.push(msg.content)
      }
    } else {
      chatMessages.push(msg)
    }
  }
  return { systemExtras, chatMessages }
}

function buildSystemPrompt(base: string, extras: string[]) {
  if (!extras.length) return base
  return `${base}\n\nAdditional system notes:\n${extras.join('\n')}`
}

function isAppCoachKey(value: string): value is AppCoachKey {
  return APP_COACH_KEY_SET.has(value as AppCoachKey)
}

function toPromptCoachKey(key: AppCoachKey): PromptCoachKey {
  return APP_TO_PROMPT_KEY.get(key) ?? 'carter-goleman'
}

async function expandContext(
  raw: unknown,
  userId: string,
): Promise<RunContext> {
  const ctx = sanitizeContext(raw)
  if (!ctx.tier) {
    ctx.tier = await resolveTierForUser(userId)
  }
  return ctx
}

interface ContextInput {
  userName?: unknown
  user_name?: unknown
  language?: unknown
  topic?: unknown
  skill?: unknown
  difficulty?: unknown
  timeboxSeconds?: unknown
  timebox_seconds?: unknown
  tier?: unknown
  rubricId?: unknown
  rubric_id?: unknown
  bandTarget?: unknown
  band_target?: unknown
}

function sanitizeContext(raw: unknown): RunContext {
  if (!isPlainObject(raw)) return {}
  const input = raw as ContextInput
  const ctx: RunContext = {}

  ctx.userName = clampString(input.userName ?? input.user_name, 80)
  const language = clampString(input.language, 12)
  ctx.language = language ? language.toLowerCase() : undefined
  ctx.topic = clampString(input.topic, 120)
  ctx.skill = clampString(input.skill, 60)
  ctx.difficulty = parseDifficulty(input.difficulty)
  ctx.timeboxSeconds = parseIntRange(
    input.timeboxSeconds ?? input.timebox_seconds,
    0,
    900,
  )
  ctx.tier = parseTier(input.tier)
  ctx.rubricId = clampString(input.rubricId ?? input.rubric_id, 80)
  ctx.bandTarget = clampString(input.bandTarget ?? input.band_target, 40)

  return stripEmpty(ctx)
}

interface SettingsInput {
  temperature?: unknown
  temp?: unknown
  maxOutputTokens?: unknown
  max_tokens?: unknown
  jsonMode?: unknown
  model?: unknown
  timeoutMs?: unknown
  timeout_ms?: unknown
  topP?: unknown
  top_p?: unknown
  frequencyPenalty?: unknown
  frequency_penalty?: unknown
  presencePenalty?: unknown
  presence_penalty?: unknown
}

function sanitizeSettings(
  raw: unknown,
): {
  prompt: PromptSettings
  model?: string
  timeoutMs?: number
  extra?: Record<string, unknown>
} {
  if (!isPlainObject(raw)) {
    return { prompt: {} }
  }
  const input = raw as SettingsInput

  const prompt: PromptSettings = {}
  const extra: Record<string, unknown> = {}

  const temperature = parseNumberRange(
    input.temperature ?? input.temp,
    0,
    1.5,
  )
  if (temperature != null) prompt.temperature = temperature

  const maxTokens = parseIntRange(
    input.maxOutputTokens ?? input.max_tokens,
    32,
    1_800,
  )
  if (maxTokens != null) prompt.maxOutputTokens = maxTokens

  if (typeof input.jsonMode === 'boolean') {
    prompt.jsonMode = input.jsonMode
  }

  const model = clampString(input.model, 100)
  const timeoutMs = parseIntRange(
    input.timeoutMs ?? input.timeout_ms,
    1_000,
    120_000,
  )

  const topP = parseNumberRange(input.topP ?? input.top_p, 0, 1)
  if (topP != null) extra.top_p = topP

  const freq = parseNumberRange(
    input.frequencyPenalty ?? input.frequency_penalty,
    -2,
    2,
  )
  if (freq != null) extra.frequency_penalty = freq

  const pres = parseNumberRange(
    input.presencePenalty ?? input.presence_penalty,
    -2,
    2,
  )
  if (pres != null) extra.presence_penalty = pres

  return {
    prompt,
    model: model ?? undefined,
    timeoutMs: timeoutMs ?? undefined,
    extra: Object.keys(extra).length ? extra : undefined,
  }
}

function clampString(value: unknown, max: number): string | undefined {
  const safe = toSafeString(value)
  if (safe == null) return undefined
  const trimmed = safe.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function parseIntRange(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  const str = toSafeString(value)
  if (str == null) return undefined
  const num = Number.parseInt(str, 10)
  if (!Number.isFinite(num) || num < min || num > max) return undefined
  return num
}

function parseNumberRange(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const num = Number(value)
  if (!Number.isFinite(num) || num < min || num > max) return undefined
  return num
}

function parseDifficulty(
  value: unknown,
): RunContext['difficulty'] | undefined {
  const normalized = toLowerString(value)
  if (!normalized) return undefined
  if (
    normalized === 'easy' ||
    normalized === 'medium' ||
    normalized === 'hard'
  ) {
    return normalized as RunContext['difficulty']
  }
  return undefined
}

function parseTier(value: unknown): RunContext['tier'] | undefined {
  const normalized = toLowerString(value)
  if (!normalized) return undefined
  if (normalized === 'vip' || normalized.startsWith('vip_')) return 'vip'
  if (normalized === 'pro' || normalized.startsWith('pro_')) return 'pro'
  if (normalized === 'free') return 'free'
  return undefined
}

function stripEmpty<T extends object>(obj: T): T {
  const clone = { ...obj } as Record<string, unknown>
  for (const key of Object.keys(clone)) {
    if (clone[key] === undefined || clone[key] === null) {
      delete clone[key]
    }
  }
  return clone as T
}

function disclaimerFor(coach: AppCoachKey): string | undefined {
  if (coach === 'dr_clark_atul' || coach === 'dr_crystal_benner') {
    return DISCLAIMERS.MEDICAL
  }
  if (coach === 'christopher_buffett') {
    return DISCLAIMERS.FINANCE
  }
  return undefined
}

function toLowerString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().toLowerCase()
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).toLowerCase()
  }
  return null
}

function toSafeString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

interface EntitlementLite {
  plan: string | null
  active: boolean
}

interface ProfileTierRow {
  tier: string | null
}

function asEntitlementRows(value: unknown): EntitlementLite[] {
  if (!Array.isArray(value)) return []
  const rows: EntitlementLite[] = []
  for (const entry of value) {
    if (!isPlainObject(entry)) continue
    const plan =
      typeof entry.plan === 'string' || entry.plan === null
        ? entry.plan ?? null
        : null
    const active = entry.active === true
    if (typeof active === 'boolean') {
      rows.push({ plan, active })
    }
  }
  return rows
}

function asProfileTierRow(value: unknown): ProfileTierRow | null {
  if (!isPlainObject(value)) return null
  const { tier } = value
  if (tier === null || typeof tier === 'string') {
    return { tier: tier ?? null }
  }
  return null
}

async function resolveTierForUser(
  userId: string,
): Promise<RunContext['tier']> {
  try {
    const entResult = await supabase
      .from('entitlements')
      .select('plan, active')
      .eq('user_id', userId)
      .eq('active', true)
    const entRows = asEntitlementRows(entResult.data)

    if (!entResult.error && entRows.length > 0) {
      const plans = new Set(
        entRows
          .map((row) => (row.plan ?? '').toLowerCase())
          .filter((plan) => plan.length > 0),
      )

      if ([...plans].some((plan) => plan.startsWith('vip'))) return 'vip'
      if ([...plans].some((plan) => plan.startsWith('pro'))) return 'pro'
    }

    const profileResult = await supabase
      .from('profiles')
      .select('tier')
      .eq('id', userId)
      .maybeSingle()
    const profile = asProfileTierRow(profileResult.data)

    if (profile?.tier) {
      const tier = parseTier(profile.tier)
      if (tier) return tier
    }
  } catch (error) {
    log.warn('resolveTierForUser failed', { userId, err: safeError(error) })
  }
  return 'free'
}
