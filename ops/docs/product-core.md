# Polaris Coach — Product Core

**Version:** 0.1.0
**Status:** Draft ready for build
**Scope:** End to end product logic for the web app and core service

---

## Purpose

Polaris Coach helps learners choose a profession specific AI coach, practice in short focused loops, automatically save better expressions, and see steady progress every week.

---

## First Principles

* Quiz is critical. The onboarding quiz must capture a concrete goal. Examples: IELTS Academic Writing Task 2, behavioral interview for a marketing role, MRCP case practice.
* Prompt engineering is decisive. Quiz outputs map to coach specific system prompts. Different coaches use different base prompts and guardrails.
* Expectation setting. The app is an AI support tool, not a substitute for certified study materials or professional advice. High stakes domains like medicine and finance show prominent disclaimers and use domain aligned rubrics and knowledge bases.

---

## Core Learning Loop

1. Onboard and set goal.
2. Choose a coach.
3. Run a 10 to 15 minute drill.
4. Get instant rubric based feedback.
5. Receive an auto generated Expressions Pack.
6. Add items to spaced review.
7. Get a weekly recap with next drills.

---

## Tiers and Access

**Free**

* One active coach with cooldown
* 10 minutes real time talk per day
* One tool or feature
* Basic vocabulary extracted from the session
* Full browse for discovery. Deeper drills gated

**Pro** — 12.99 USD monthly or 99 USD yearly

* One active coach with cooldown
* 30 minute sessions
* Any three tools or features
* Full vocabulary details: meaning, pronunciation, topic, difficulty, simple synonym, example sentence, optional idioms or professional terms
* “Done” advances to the next item to reduce repetition

**VIP** — 29 USD monthly or 199 USD yearly

* All coaches
* All tools and features
* Full vocabulary access with filters and topics

Coach switching policy

* Free and Pro: one active coach with a cooldown timestamp
* VIP: no cooldown

Server is the source of truth for all gates and timers.

---

## Payments and Entitlements

**Rails**

* Global: PayPal
* Philippines: PayMongo
* ESL markets outside PH: start with PayPal. Add regional rails later behind the same entitlement model.

**Design**

* Provider agnostic entitlements written by a unified grant path.
* Webhooks verify signatures and use idempotency by provider event id.
* A payments ledger records all changes for audit.
* Nightly reconciliation heals mismatches between provider events and internal entitlements.

**Key flows**

* Checkout: create payment session, attach customer and plan, on success write entitlements and payment_events.
* Customer portal: view plan, upgrade or cancel, manage billing details.
* Webhooks: verify signature, record status changes, update entitlements, append to ledger, enqueue reconciliation if needed.
* Reconciliation: nightly compare provider events to entitlements and fix gaps.

**Normalized webhook event shape**

```json
{
  "provider": "paypal" | "paymongo",
  "event_id": "string",
  "type": "payment.succeeded" | "payment.failed" | "subscription.updated" | "subscription.canceled",
  "occurred_at": "2025-01-01T00:00:00Z",
  "customer_id": "string",
  "plan_id": "free" | "pro" | "vip",
  "amount": 1299,
  "currency": "USD",
  "raw": {"...": "provider payload"}
}
```

**Capabilities preview on plan change**
Before commit, the portal returns a preview capabilities object so the UI can show exactly what will change after upgrade or cancel.

---

## Coaches Catalog

Ten coaches with clear audiences, benefits, tools, and drills.

1. **Academic English and Exam Strategist** — Chase Krashen
   Audience: senior high, gap year, early freshmen.
   Benefits: academic tone, organized answers, faster thinking.
   Tools: Goal Mapper, Vocabulary Ladder, PEEL point builder, rubric tracker.
   Drills: mini lecture, chart comparison, debate starter, scholarship mock.

2. **Graduate Admissions Communicator** — Dr. Claire Swales
   Tools: Research Pitch Canvas, SOP to Speech, methodology clarifier, committee Q bank.

3. **Professional Interview Communicator** — Carter Goleman
   Tools: competency map, story bank with STAR scaffolds, case and behavioral Q generator, negotiation rehearsal.

4. **English Proficiency Coach (IELTS, TOEFL, ESL)** — Chelsea Lightbown
   Tools: band targeted prompts, pronunciation mirror, paraphrase generator, timing coach.

5. **Medical Communication and Exam Coach (Physicians)** — Dr. Clark Atul
   Tools: SBAR and SOAP speak aloud templates, differential trees, bad news protocol, guideline citation tips.

6. **Nursing Communication and Exam Coach** — Dr. Crystal Benner
   Tools: ISBAR builder, patient teaching scripts at three literacy levels, safety escalation phrases.

7. **Financial English and Certification Coach** — Christopher Buffett
   Tools: jargon to plain English converter, KPI explainers, client risk role plays.

8. **Business English and Leadership Coach** — Colton Covey
   Tools: meeting opener and closer builder, storytelling for change, objection handling cards, feedback scripts.

9. **Technical English and Certification Coach** — Cody Turing
   Tools: incident report template, architecture walkthrough prompts, acronym unpacker, cert objective quiz.

10. **Personal Development and Vision Communicator** — Chloe Sinek
    Tools: vision to vow scripts, values to boundary phrases, accountability recorder.

Catalog items include Speaking Drills, Scenarios, Q Bank, Feedback Studio, and Rubrics. Items are tagged by skill, time, level, and coach targets.

---

## Onboarding, Matching, and Plans

* Ask first name for friendly address.
* Ask profession and goal: MRCP, OSCE, scholarship interview, IELTS band target, job role.
* Ask domains and preferred difficulty.
* Recommend the top 3 to 5 coaches based on a weighted scorecard. Allow full browse.
* Enforce tier limits immediately on selection.
* Generate a 7 day plan: three drills, one vocab review, one reflection.
* The coach greets by name, mirrors difficulty, and offers the first drill within two minutes of signup.

**Matching**
Goal to coach scoring uses domain, difficulty, time budget, and topic alignment.

**Seven day plan guardrails**

* Avoid back to back repeats in skill, topic, or format.
* Respect tier gates and minute limits.

---

## Practice Engine

**Browse mode**

* Filters: coach, topic, difficulty, language, recency, date.
* Quick toggles: AI coach, expressions only, practice features only.
* Pagination: 20 items.

**Practice Now**

* Deterministic daily seed: `seed = hash(user_id + YYYY-MM-DD)`.
* Per user LRU of 50 items hides recently seen items.

**Run loop**

1. Prompt.
2. User response or choice.
3. Immediate outcome and feedback.
4. One tap “one more like this” or “switch topic”.

**Role plays and interviews** use coach specific rubrics.

**Feedback format**

* Three wins
* Two fixes
* One next prompt

**Session timer and minute accounting**

* Real time talk minutes decrement from a server counter that resets daily per tier.
* All minute math happens on the server. The client mirrors state only.

**Tier gate orchestration**

* EntitlementGuard reads a single capabilities object that controls tools, coach count, session length, and library filters.

**Coach switch cooldown**

* A `coach_switch_cooldown_until` timestamp is set on switch and enforced on the server. The UI shows the exact time when switching is allowed again.

---

## Expressions Pack

* At session end, AI compiles corrected lines, upgraded phrasing, key collocations, pronunciation notes, and example re say prompts.
* Packs save instantly to the session summary and the user Library.
* User actions: review, favorite, retry aloud, add to spaced review, report, request variations.
* Background checks remove duplicates and suppress risky items from public catalogs while keeping them private.
* Optional admin curation can promote great items to exemplars.
* States: Private User to Candidate Exemplar to Published Exemplar to Deprecated.

**Spaced review**

* Ladder: 1 day, 3 days, 7 days, 14 days.
* Correct recalls move forward. Misses push back one step.
* The scheduler is server owned.

**One more like this**

* Uses embeddings to find near neighbors by skill, topic, and target rubric band.

---

## Analytics, Growth, and Rhythm

**Events**

* onboarding_completed, coach_selected, practice_started, practice_submitted, feedback_viewed, vocab_saved, day_completed, plan_upgraded, payment_status, coach_switched, drill_opened.

**Dimensions**

* coach, domain, topic, difficulty, tier, country.

**Growth**

* Shareable single drill tryout without login.
* Weekly recap mail with three wins, two fixes, one suggestion.
* Refer a friend with VIP credit after first paid month.
* Partnerships with clinician and IELTS communities.

**Operating cadence**

* Daily: moderation and urgents, error rates, minor content hotfixes.
* Weekly: KPI and cohort review, calibration spot checks, publish new content per coach, start or stop one A or B test.
* Monthly: policy and permission audit, curriculum refresh and deprecation, security review and backup restore test, pricing and funnel review.

---

## Safety and Medical Governance

* Medical and finance items carry educational disclaimers. The banner renders in DrillRunner and Session Summary and is non dismissible. The view is logged.
* Prefer reasoning and differentials. No definitive dosing without context.
* Auto QA gates to publication. Checks: duplication, reading level, bias, safety, rubric coverage, exam mapping, accessibility.
* Unsafe content is suppressed from public catalogs and queued for admin review but remains in private history.

---

## Admin and AI Operating Model

**Actors**

* AI Generator and Admin.

**Workflow**

* Generate to Auto QA to In Review to Approved to Published to Deprecated.

**Publish rules**
Every item must include: title, type, coach targets, skills, difficulty, runtime, framework mapping, rubric, success criteria, next step on failure, at least one accessibility note, one alternate prompt, version and changelog.

**Review checklist**

* Fit to audience and level
* Accuracy and domain safety
* Clear instructions and timing
* Rubric matches descriptors
* Accessibility and inclusive language
* Correct tags, difficulty, prerequisites
* Version and changelog present

**Audit**

* Capture reviewer id and timestamps for all checklist decisions.

---

## App Pages and Components

**Public marketing**

* Home, About, Path, Pricing, Help Center.
* OG images live under `public/og`.

**Product app**

* Onboarding, Explore, Search, Dashboard, Chat and Live, Sessions, Expressions Library, Vocabulary, Practice Pack banner, Weekly Recap, Trends, Account, Export, Delete.

**Admin**

* Audit, Drip, Editorial, Review Queue, Catalog Builder, Metrics.

**Key components**

* DrillList, DrillRunner, ShadowingPlayer, MicRecorder, PronunciationHeatmap, EntitlementGuard, PaymentButton, ReferralShare, CoachSwitchNotice, Tabs, Cards, Buttons, Header, Footer.

---

## API and Backend Highlights

**Next.js route handlers**

* `/api/auth/callback`
* `/api/chat`
* `/api/transcribe` and `/api/tts`
* `/api/realtime/token`
* `/api/pay/checkout` and `/api/pay/portal`
* `/api/pay/webhooks` for PayPal and PayMongo with signature verification
* `/api/upload`
* `/api/admin`

**Capabilities object**
The server returns a single capabilities object to enforce gates on the client.

```json
{
  "tier": "free" | "pro" | "vip",
  "session_minutes_daily": 10 | 30 | 60,
  "active_coaches": 1 | 3,
  "tools_allowed": ["vocab", "paraphrase", "tts", "transcribe"],
  "library_filters": ["expressions", "practice"],
  "coach_switch_cooldown_until": "2025-01-01T12:00:00Z"
}
```

---

## Data Model and Security

* Supabase Postgres with RLS everywhere. Users access only their rows. Admin policies use least privilege.
* Tables: users, profiles, sessions, attempts, drills, catalogs, entitlements, payments_events, affiliates, daily_usage, events, plus key expressions and messages where applicable.
* Views: drill stats, user progress, weekly recap views.
* Triggers and cron: weekly summary emails, view refresh, reconciliation jobs.
* Input sanitization on any user text that can render in the UI.
* PII retention rules purge stale audio, transient transcripts, and temporary uploads by window.

**Migrations roadmap**

* 0027_paymongo_core.sql — add provider tables and enums for PayMongo.
* 0028_paypal_core.sql — add provider tables and enums for PayPal.
* 0029_remove_adyen.sql — remove Adyen if 0022_adyen_core.sql was ever applied.

---

## Accessibility and Branding

* WCAG AA for body and large text.
* Theme tokens with on colors for filled surfaces.
* Clear focus states and error messages.
* One tap retry and one tap add to spaced review.
* Seed colors: Primary #07435E, Secondary #042838, Accent #4390BA, Surface #DBF7FF, Base dark #001C29, Text #000000.
* Tokens must pass contrast checks during build.

---

## Deployment and Environments

* GitHub branches: `staging` for staging, `main` for production.
* Each branch maps to a separate Vercel project.
* CI on pull requests with type checks and linting.
* Migrations run in staging first, then production.
* Local: run Next.js and point to local or remote Supabase. Use test payment keys.
* Staging: test keys and buckets.
* Production: live keys, full logging and alerts.

**Webhooks**

* Expose a tunnel in local dev and point PayPal and PayMongo to `/api/pay/webhooks`.

---

## Environment variables

Minimal example for web and core. Remove any leftover Adyen keys.

```env
# Public to browser
NEXT_PUBLIC_APP_BASE_URL=https://staging.your-domain.com
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-STAGING-PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_STAGING_ANON_KEY
NEXT_PUBLIC_APP_VERSION=0.1.0

# Server only
SUPABASE_SERVICE_ROLE_KEY=YOUR_STAGING_SERVICE_ROLE_KEY
SUPABASE_JWT_SECRET=

BILLING_PROVIDER=paymongo,paypal

PAYMONGO_SECRET_KEY=sk_test_xxx
PAYMONGO_PUBLIC_KEY=pk_test_xxx
PAYMONGO_WEBHOOK_SECRET=whsec_xxx

PAYPAL_CLIENT_ID=YOUR_PAYPAL_SANDBOX_CLIENT_ID
PAYPAL_CLIENT_SECRET=YOUR_PAYPAL_SANDBOX_CLIENT_SECRET
PAYPAL_MODE=sandbox
PAYPAL_WEBHOOK_ID=

RESEND_API_KEY=
# or
POSTMARK_API_TOKEN=

OPENAI_API_KEY=YOUR_OPENAI_STAGING_KEY
```

---

## Consistency Rules

* Server owns entitlements, minute counters, cooldown timestamps, and spaced review due dates.
* Client reads a single capabilities object and never decides access.
* Naming conventions: SQL snake_case, routes kebab case, React components PascalCase, events as `domain_action`.
* Validate all inputs with Zod at the edge. Return typed results only.
* Payments: verify webhook signatures and use idempotency keys. Write both payment_events and entitlements in one transaction.
* Analytics: emit only from the shared contract and include user_id, tier, coach_id, topic, difficulty where relevant.
* Content lifecycle: every published item has version, rubric id, mapping, accessibility notes, and changelog.
* Accessibility and brand: enforce WCAG AA during build with token checks.
* Branch and env discipline: staging is the only pre prod branch that maps to a live environment.
* Error handling: never throw raw provider errors to the client. Log with correlation ids that include session_id or attempt_id.

---

## Internationalization and ESL Helpers

* Readable English hints. ESL users can see optional paraphrases and pronunciation nudges that do not affect the rubric score.
* Locale aware examples use regionally sensible terms when correctness is unchanged.

---

## Performance and Reliability

* Idempotent APIs with retries for `start_session`, `finish_session`, `save_pack`, and payment endpoints.
* Graceful offline: the run loop can queue one pending submission and replay when back online.
* Edge caching for public pages with short TTL and tag based revalidation on publish.

---

## Developer Workflow and Safety Nets

* Feature flags and kill switches per tool and per environment.
* Observability: type safe logs and traces to correlate attempt to rubric, pack creation, and mail sending.
* One click export and delete with cascading deletes and queued media removal.

---

## How to deploy inside your app

* Let users pick a coach, goal, and target date.
* Auto suggest three drills per week at 10 to 15 minutes each.
* After each drill, log WPM, clarity, and task success to show momentum.
* Add a weekly recap that recommends next drills and phrases to master.
* Browse filters must include date, difficulty, topic, coach, and quick toggles for expressions or practice features.

---

## Quick run checklist

* Node 18.18 or higher.
* `npm ci` runs clean in both repos.
* `.env.local` present and complete in both projects.
* Supabase migrations applied and RLS enabled.
* `npm run typecheck` and `npm run lint` are clean.
* Webhooks reach `/api/pay/webhooks` locally.
* Vercel projects connect staging and main correctly.
* First payment test upgrades entitlements and writes a ledger event.
