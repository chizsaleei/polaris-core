# Polaris Coach — Setup and Standards

This one-pager is the source of truth for installing, running, and shipping Polaris Coach across local, staging, and production. Keep it in sync with `.env.example`, CI, and migrations.

---

## 1) Tech stack

* **Web app**: Next.js 14 App Router, React 18, TypeScript
* **Styling**: Tailwind CSS, shadcn/ui, Lucide, Framer Motion
* **Forms and validation**: React Hook Form, Zod
* **Data**: Supabase Postgres, Auth, Storage, Realtime
* **API**: Next.js Route Handlers under `/api/*` plus small background worker in `polaris-core`
* **Payments**: PayPal REST (global) and PayMongo (PH) unified under one entitlement model
* **Email**: Resend or Postmark
* **Observability**: Sentry, OpenTelemetry traces, structured logs
* **Analytics**: first‑party events table in Supabase, optional PostHog
* **Tests**: Vitest unit, Playwright smoke
* **CI and deploy**: GitHub Actions, Vercel web, Supabase migrations

## 2) Prerequisites

* Node 18.18+ and npm
* Accounts: Vercel, Supabase, PayPal (sandbox and live), PayMongo (test and live), email provider
* Optional for local webhooks: ngrok or smee

## 3) Repos

* `polaris-coach-web` for the Next.js app
* `polaris-core` for cron, reconciliation, and shared scripts

Clone both. Then run `npm ci` in each root.

## 4) Environment variables

Keep `.env.example` exhaustive in both repos. Create `.env.local` from it.

**Web minimum**

```ini
# Public
NEXT_PUBLIC_APP_BASE_URL=http://localhost:3000
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...

# Server only
SUPABASE_SERVICE_ROLE_KEY=...
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYMONGO_PUBLIC_KEY=...
PAYMONGO_SECRET_KEY=...
WEBHOOK_SECRET_PAYPAL=...
WEBHOOK_SECRET_PAYMONGO=...
RESEND_API_KEY=...    # or POSTMARK_API_TOKEN=...
SENTRY_DSN=...
```

**Core minimum**

```ini
PORT=8787
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
WEBHOOK_SECRET_PAYPAL=...
WEBHOOK_SECRET_PAYMONGO=...
MAIL_PROVIDER_KEY=...  # Resend or Postmark
CRON_SECRET=...
```

Remove any Adyen keys to avoid conflicts.

## 5) Database and security

* Create two Supabase projects: `polaris-staging` and `polaris-prod`
* Apply migrations to staging first, then production
* Enable RLS on all user data tables. Least privilege roles for Admin
* Tables include: `users`, `profiles`, `sessions`, `attempts`, `drills`, `catalogs`, `entitlements`, `payment_events`, `affiliates`, `daily_usage`, `events` plus views for drill stats and progress

## 6) Local run

* Web: `npm run dev` in `polaris-coach-web` then open `http://localhost:3000`
* Core worker: `npm run dev` in `polaris-core` if used locally, otherwise rely on Vercel Cron in staging
* Start a tunnel and point payment webhooks to `https://<tunnel>/api/pay/webhooks`

### Local to Vercel workflow

1. Open terminal at project root
2. `npm ci`
3. `npm run dev` and verify localhost
4. Configure Tailwind, ESLint, Prettier, shadcn/ui
5. `git init` then first commit
6. Push to GitHub
7. Connect repo to Vercel and set env vars per environment
8. Deploy from `main` when ready

## 7) Branches and environments

* Branches: `staging` maps to Vercel staging, `main` maps to Vercel production
* CI: typecheck, lint, tests on pull requests. Block merge on red
* Migrations run on staging after merge to `staging`. Promote to production after verification

## 8) Payments and entitlements

Single entitlement model across providers.

* Checkout creates a session, attaches customer and plan, writes `payment_events` and `entitlements`
* Webhooks verify signatures and are idempotent per provider event id
* Nightly reconciliation compares provider events with `entitlements` and heals gaps, appending to an auditable ledger

**Test plan**

1. Run a PayPal sandbox payment. Verify entitlement unlock and ledger row
2. Run a PayMongo test payment. Verify the same path
3. Trigger webhook retry to confirm idempotency

## 9) Learning loop and gates

Server is the source of truth for:

* Tier gates: minutes per day, tools, and one active coach
* Coach switch cooldown via `coach_switch_cooldown_until`
* Spaced review due dates
* A read-only `capabilities` object that the client consumes

## 10) Analytics and observability

* Emit events only from the shared contract: `onboarding_completed`, `coach_selected`, `practice_started`, `practice_submitted`, `feedback_viewed`, `vocab_saved`, `day_completed`, `plan_upgraded`, `payment_status`, `coach_switched`, `drill_opened`
* Include properties: `user_id`, `tier`, `coach_id`, `topic`, `difficulty`, and device data where relevant
* Use Sentry for errors and OTel traces. Add correlation ids such as `session_id` or `attempt_id`

## 11) Accessibility and brand

* Enforce WCAG AA for body and large text
* Provide visible focus states and clear errors with one-tap recovery
* Seed palette: Primary `#07435E`, Secondary `#042838`, Accent `#4390BA`, Surface `#DBF7FF`, Base-dark `#001C29`, Text `#000000`

## 12) Content governance

* Workflow: Generate to Auto QA to In Review to Approved to Published to Deprecated
* Each published item requires: title, type, coach targets, skills, difficulty, runtime, framework mapping, rubric, success criteria, next step on failure, accessibility note, alternate prompt, version, changelog

## 13) Coding standards

* TypeScript strict mode. No `any` in handlers
* Validate all inputs with Zod at the edge
* Naming: snake_case for SQL, kebab-case for routes, PascalCase for React components, events use `domain_action`
* Input sanitization for any text that renders in the UI

## 14) Privacy, retention, and export

* Purge stale raw audio, transient transcripts, and temporary uploads on schedule
* One click export and delete with cascades and media cleanup queue

## 15) Release checklist

* `.env.example` matches deployed env
* Typecheck, lint, tests are green
* Staging migration applied and verified
* Webhooks reach staging and idempotency proven
* Smoke: signup, select coach, complete a drill, receive Expressions Pack, weekly recap job runs
* Promote to production and apply prod migration

## 16) Troubleshooting quick wins

* Payment not unlocking: check webhook signature, idempotency key, and reconcile job
* Minutes not updating: confirm server timer and `capabilities` fetch, not client state
* Duplicate phrases: verify pack dedupe and background cleanup
* Access looks wrong: review entitlements and tier gates from the server, never patch on the client

---

## One minute run sheet

1. `npm ci` in both repos
2. Fill `.env.local` from `.env.example`
3. Apply Supabase migrations with RLS on
4. `npm run dev` and confirm web opens
5. Tunnel webhooks and run a sandbox payment
6. Verify entitlement, ledger, and recap job
7. Push to `staging`, review preview, then merge to `main`
