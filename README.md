# Polaris Core

Server for Polaris Coach. Handles auth, practice session storage, analytics, billing webhooks, and cron jobs. This repo is server only. The Next.js UI lives in `polaris-web`.

## What it does

- Auth and profile fetch through Supabase
- Practice sessions and attempts API
- Expressions Pack save and review endpoints
- Analytics events intake
- Billing with PayMongo and PayPal
  - Unified entitlement writes and reconciliation
  - Provider specific webhooks
- Admin utilities
  - Review queue, catalog, and metrics API scaffolds
  - Protected by `admin-guard` middleware
- Cron jobs
  - Weekly summaries
  - Reconciliation
  - Materialized view refresh
  - Drip dispatch

## Tech stack

- Node.js + TypeScript
- Express
- Supabase Postgres + RLS
- PayMongo and PayPal SDKs or REST
- Optional KV or Redis for small queues and locks

## Requirements

- Node 18 or 20
- A Supabase project with schema and RLS
- PayMongo keys and webhook secret if PayMongo is enabled
- PayPal Client ID, Client Secret, Mode, and Webhook ID if PayPal is enabled

## Quick start

```bash
# 1) copy env example
cp .env.example .env

# 2) install
npm ci

# 3) build types or run directly in dev
npm run dev
# or
npm run build && npm start
