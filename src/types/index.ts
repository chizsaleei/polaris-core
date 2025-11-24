/**
 * Polaris Core - Shared TypeScript types
 * Single source of truth for core domain and row types used across server, API, and UI.
 */

// ---------- JSON utility

export type JSONPrimitive = string | number | boolean | null

export type JSONValue = JSONPrimitive | JSONObject | JSONArray

export interface JSONObject {
  [k: string]: JSONValue
}

export interface JSONArray extends Array<JSONValue> {}

// ---------- Environment (server-side)

export type BillingProvider = 'paymongo' | 'paypal'

export interface Env {
  NODE_ENV: 'development' | 'test' | 'production'
  APP_VERSION: string
  APP_BASE_URL: string
  PORT: number

  // Core API (optional for some deployments)
  CORE_API_KEY?: string

  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  SUPABASE_SERVICE_ROLE_KEY: string
  SUPABASE_JWT_SECRET?: string

  // Comma-joined at runtime, but represented as an array in code
  BILLING_PROVIDER: BillingProvider[]

  // PayMongo
  PAYMONGO_SECRET_KEY: string
  PAYMONGO_PUBLIC_KEY: string
  PAYMONGO_WEBHOOK_SECRET: string

  // PayPal
  PAYPAL_CLIENT_ID: string
  PAYPAL_CLIENT_SECRET: string
  PAYPAL_MODE: 'sandbox' | 'live'
  PAYPAL_WEBHOOK_ID: string

  // Optional KV and Redis
  POLARIS_REST_API_KV_URL: string
  POLARIS_REST_API_KV_REST_API_URL: string
  POLARIS_REST_API_KV_REST_API_TOKEN: string
  POLARIS_REST_API_KV_REST_API_READ_ONLY_TOKEN?: string
  POLARIS_REST_API_REDIS_URL?: string

  // OpenAI
  OPENAI_API_KEY: string
  OPENAI_CHAT_MODEL?: string
  OPENAI_EMBED_MODEL?: string
  OPENAI_TTS_MODEL?: string
  OPENAI_TRANSCRIBE_MODEL?: string
  OPENAI_MODERATION_MODEL?: string
  OPENAI_REALTIME_MODEL?: string

  // CORS and logging
  CORS_ORIGIN?: string
  CORS_ADDITIONAL_ORIGINS?: string
  LOG_LEVEL?: string
}

// ---------- Tiers, plans, and coaches

export enum Tier {
  FREE = 'free',
  PRO = 'pro',
  VIP = 'vip',
}

export type PlanId =
  | 'free'
  | 'pro_monthly'
  | 'pro_yearly'
  | 'vip_monthly'
  | 'vip_yearly'

export type CoachKey =
  | 'chase_krashen'
  | 'dr_claire_swales'
  | 'carter_goleman'
  | 'chelsea_lightbown'
  | 'dr_clark_atul'
  | 'dr_crystal_benner'
  | 'christopher_buffett'
  | 'colton_covey'
  | 'cody_turing'
  | 'chloe_sinek'

export interface CoachMeta {
  key: CoachKey
  name: string
  audience: string
  tags: string[]
}

// ---------- Onboarding and matching

export type QuizPriority =
  | 'fluency'
  | 'interview'
  | 'exam'
  | 'leadership'
  | 'technical'
  | 'medical'
  | 'nursing'
  | 'finance'
  | 'admissions'
  | 'personal'

export interface QuizAnswers {
  firstName: string
  profession: string
  goal: string
  domains: string[]
  priorities: QuizPriority[]
  difficulty: 1 | 2 | 3 | 4 | 5
}

export interface CoachRec {
  coach: CoachKey
  score: number
  reason: string[]
}

export interface StarterDrill {
  title: string
  prompt: string
  estMinutes: number
}

export type SevenDayPlanItemType = 'drill' | 'vocab' | 'reflection'

export interface SevenDayPlanItem {
  day: number
  type: SevenDayPlanItemType
  title: string
  prompt?: string
}

export interface SevenDayPlan {
  coach: CoachKey
  dayPlan: SevenDayPlanItem[]
}

// ---------- Practice engine contract

export interface ExpressionItem {
  text_original: string
  text_upgraded: string
  collocations: string[]
  pronunciation?: { word: string; hint: string }
  examples?: string[]
}

// A rubric is any string-keyed object of numbers
type NumericRubric = Record<string, number>

/**
 * Base practice response - generic over a numeric rubric shape.
 * This avoids forcing a string index signature on every rubric interface.
 */
export interface BasePracticeResponse<RubricShape extends NumericRubric> {
  modelAnswer: string
  wins: [string, string, string]
  fixes: [string, string]
  nextPrompt: string
  rubric: RubricShape & { overall: number }
  expressions: ExpressionItem[]
}

// Explicit rubric fields by coach - each extends NumericRubric for flexibility

export interface RubricChaseKrashen extends NumericRubric {
  structure: number
  evidence: number
  reasoning: number
  clarity: number
  delivery: number
}

export interface RubricClaireSwales extends NumericRubric {
  structure: number
  fit_alignment: number
  evidence_methods: number
  clarity_style: number
  presence_confidence: number
}

export interface RubricCarterGoleman extends NumericRubric {
  structure: number
  relevance: number
  impact: number
  clarity: number
  presence: number
}

export interface RubricChelseaLightbown extends NumericRubric {
  fluency_coherence: number
  lexical_resource: number
  grammar_accuracy: number
  pronunciation: number
  topic_development: number
}

export interface RubricClarkAtul extends NumericRubric {
  structure: number
  clinical_reasoning: number
  safety_recommendations: number
  clarity_tone: number
  evidence_guidelines: number
}

export interface RubricCrystalBenner extends NumericRubric {
  structure: number
  accuracy: number
  clarity: number
  empathy_tone: number
  safety: number
}

export interface RubricChristopherBuffett extends NumericRubric {
  clarity: number
  accuracy: number
  structure: number
  client_framing: number
  numeracy: number
}

export interface RubricColtonCovey extends NumericRubric {
  clarity: number
  relevance: number
  structure: number
  persuasion: number
  presence: number
}

export interface RubricCodyTuring extends NumericRubric {
  clarity: number
  technical_accuracy: number
  structure: number
  audience_targeting: number
  brevity_under_stress: number
}

export interface RubricChloeSinek extends NumericRubric {
  clarity: number
  specificity_action: number
  presence_tone: number
  structure: number
  follow_through: number
}

export type RubricByCoach = {
  chase_krashen: RubricChaseKrashen
  dr_claire_swales: RubricClaireSwales
  carter_goleman: RubricCarterGoleman
  chelsea_lightbown: RubricChelseaLightbown
  dr_clark_atul: RubricClarkAtul
  dr_crystal_benner: RubricCrystalBenner
  christopher_buffett: RubricChristopherBuffett
  colton_covey: RubricColtonCovey
  cody_turing: RubricCodyTuring
  chloe_sinek: RubricChloeSinek
}

export type PracticeResponseByCoach = {
  [K in CoachKey]: BasePracticeResponse<RubricByCoach[K]>
}

// ---------- Sessions and attempts (domain level)

export interface Session {
  id: string
  user_id: string
  coach_key: CoachKey
  started_at: string // ISO
  finished_at?: string // ISO
  tier: Tier
}

export interface Attempt {
  id: string
  session_id: string
  drill_id: string
  coach_key: CoachKey
  rubric_json: JSONObject
  overall_score: number
  wins: string[]
  fixes: string[]
  next_prompt: string
  expressions_json: JSONArray
  expressions_count: number
  time_on_task_seconds: number
  words_per_minute: number | null
  report_rate?: number | null
  helpfulness_rating?: number | null
  flag_safety?: boolean
  flag_risky_language?: boolean
  created_at: string // ISO
}

// Normalized recap payload returned by the session summary builder
export type SessionDomain = 'medical' | 'finance' | 'general'

export interface SessionSummaryMetrics {
  wpm?: number
  clarity?: number
  taskSuccess?: number
}

export interface SessionSummaryFeedback {
  wins: string[] // up to 3
  fixes: string[] // up to 2
  next: string // one line
}

export interface SessionSummaryExpressionItem {
  id: string
  text: string
  normalized: string
  tags: string[]
  risky: boolean
  publishable: boolean
  addedAt: string // ISO
  reviewDueAt: string[] // spaced review dates
}

export interface SessionSummaryExpressionsPack {
  items: SessionSummaryExpressionItem[]
  counts: {
    total: number
    added: number
    duplicates: number
    risky: number
  }
}

export interface SessionSummary {
  sessionId: string
  userId: string
  coach: CoachKey
  rubricId?: string
  domain: SessionDomain
  minutesUsed: number
  transcript?: string
  userText?: string
  modelText?: string
  feedback: SessionSummaryFeedback
  expressions: SessionSummaryExpressionsPack
  metrics: SessionSummaryMetrics
  disclaimerShown: boolean
  disclaimerText?: string
  createdAt: string // ISO
}

// ---------- Payments and entitlements

export interface PaymentEvent {
  id?: string
  user_id?: string
  plan?: PlanId
  provider: BillingProvider
  provider_ref?: string | null
  status:
    | 'pending'
    | 'webhook_received'
    | 'webhook_rejected'
    | 'entitlement_granted'
    | 'entitlement_revoked'
    | 'error'
  amount_minor?: number
  currency?: string
  raw?: JSONObject
  created_at?: string // ISO
}

export interface Entitlement {
  user_id: string
  tier: Tier
  source: BillingProvider | 'admin' | 'dev'
  reference?: string | null
  active: boolean
  created_at: string // ISO
  updated_at: string // ISO
}

// ---------- Analytics events

export type AnalyticsEventName =
  | 'onboarding_completed'
  | 'coach_selected'
  | 'practice_started'
  | 'practice_submitted'
  | 'feedback_viewed'
  | 'vocab_saved'
  | 'day_completed'
  | 'plan_upgraded'
  | 'payment_status'
  | 'coach_switched'
  | 'drill_opened'
  | 'chat_coach'

export interface AnalyticsEvent {
  name: AnalyticsEventName
  user_id: string
  coach_key?: CoachKey
  tier?: Tier
  dimensions?: JSONObject
  created_at: string // ISO
}

// ---------- Branding and accessibility tokens (subset)

export interface BrandTokens {
  colors: {
    primary: '#07435E'
    secondary: '#042838'
    accent: '#4390BA'
    surface: '#DBF7FF'
    baseDark: '#001C29'
    text: '#000000'
  }
  wcag: {
    bodyTextAA: boolean
    largeTextAA: boolean
  }
}

export const DEFAULT_BRAND_TOKENS: BrandTokens = {
  colors: {
    primary: '#07435E',
    secondary: '#042838',
    accent: '#4390BA',
    surface: '#DBF7FF',
    baseDark: '#001C29',
    text: '#000000',
  },
  wcag: { bodyTextAA: true, largeTextAA: true },
}

// ---------- Database row types (Supabase backed)

// These mirror the core tables and can be used for DB query typing.
// Adjust column lists as you refine your schema migrations.

export interface UserRow {
  id: string
  email: string | null
  created_at: string
}

export interface ProfileRow {
  id: string
  user_id: string | null
  first_name: string | null
  profession: string | null
  goal: string | null
  domains: string[] | null
  priorities: QuizPriority[] | null
  difficulty: 1 | 2 | 3 | 4 | 5 | null
  coach_key: CoachKey | null
  tier: Tier
  timezone: string | null
  country_code: string | null
  currency_code: string | null
  daily_target_minutes: number | null
  reminder_time_local: string | null
  practice_focus: string | null
  marketing_opt_in: boolean
  created_at: string
  updated_at: string
}

export interface SessionRow extends Session {}

export interface AttemptRow extends Attempt {}

export type DrillKind =
  | 'speaking'
  | 'scenario'
  | 'qbank'
  | 'feedback'
  | 'rubric'

export type CatalogItemState =
  | 'private_user'
  | 'candidate_exemplar'
  | 'published_exemplar'
  | 'deprecated'

export interface DrillRow {
  id: string
  coach_key: CoachKey
  topic_key: string
  level: string
  kind: DrillKind
  prompt: string
  rubric_key: string | null
  metadata: JSONObject | null
  state: CatalogItemState
  created_at: string
  updated_at: string
}

export interface EntitlementRow extends Entitlement {}

export interface PaymentEventRow extends PaymentEvent {
  id: string
  created_at: string
}

export interface DailyUsageRow {
  user_id: string
  date: string // YYYY-MM-DD
  minutes_used: number
  drills_completed: number
  created_at: string
}

export interface EventRow extends AnalyticsEvent {
  id: string
}

// ---------- Attribution (shared shapes) ----------

export type AttributionChannel =
  | 'direct'
  | 'organic_search'
  | 'paid_search'
  | 'paid_social'
  | 'social'
  | 'email'
  | 'referral'
  | 'affiliate'
  | 'unknown'

export interface AttributionUtm {
  source?: string
  medium?: string
  campaign?: string
  term?: string
  content?: string
}

export interface AttributionClickIds {
  gclid?: string
  msclkid?: string
  fbclid?: string
  twclid?: string
  ttclid?: string
  clid?: string
}

export interface AttributionCore {
  ts: string
  request_id: string
  landing_url?: string
  referrer?: string
  user_agent?: string
  country?: string
  ip_hash?: string
  utm: AttributionUtm
  click: AttributionClickIds
  affiliate_code?: string
  channel: AttributionChannel
  site_domain?: string
}

export interface AttributionCookies {
  firstTouch?: string
  lastTouch?: string
}

// ---------- Admin messages / announcements ----------

export type AdminMessageState =
  | 'draft'
  | 'approved'
  | 'scheduled'
  | 'sending'
  | 'sent'
  | 'canceled'
  | 'archived'

export type AdminMessageImportance = 'low' | 'normal' | 'high' | 'urgent'

export interface AdminMessageRow {
  id: string
  author_id: string | null
  title: string
  body_text: string | null
  body_html: string | null
  importance: AdminMessageImportance
  tags: string[]
  hero_image_url: string | null
  cta_label: string | null
  cta_url: string | null
  audience_filter: JSONObject
  state: AdminMessageState
  send_at: string | null
  sent_at: string | null
  canceled_at: string | null
  created_at: string
  updated_at: string
  meta: JSONObject
}

export interface AdminMessageCreateInput {
  title: string
  bodyText?: string | null
  bodyHtml?: string | null
  importance?: AdminMessageImportance
  tags?: string[] | string | null
  heroImageUrl?: string | null
  ctaLabel?: string | null
  ctaUrl?: string | null
  sendAt?: string | null
  state?: AdminMessageState
  audienceFilter?: JSONObject
  meta?: JSONObject
}

export type AdminMessageUpdateInput = Partial<AdminMessageCreateInput>

export interface AdminMessageListResponse {
  ok: true
  items: AdminMessageRow[]
}

export interface AdminMessageItemResponse {
  ok: true
  item: AdminMessageRow
}

export interface AdminMessageCreateResponse {
  ok: true
  id: string
}

export interface AdminMessageQueueResponse {
  ok: true
  item: Pick<AdminMessageRow, 'id' | 'state' | 'send_at'>
}
