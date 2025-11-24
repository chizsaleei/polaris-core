# Supabase Ops README

Version: 0.1.0
Status: Draft ready for implementation
Scope: how Polaris Coach manages schema, RLS, migrations, seeds, views, triggers, backups, and CI across local, staging, and production

---

## Directory layout

This folder holds all database assets that ship with the core service.

```
ops/supabase/
├─ README.md                      ← this guide
├─ backup.md                      ← backup policy and schedule
├─ runbook_restore.md             ← step by step restore playbook
├─ storage-buckets.md             ← bucket names, CORS, and policies
│
├─ migrations/                    ← ordered SQL migrations 0001 … 0029
│   0001_init.sql
│   0002_profiles_and_sessions.sql
│   0003_drill_items_sets.sql
│   0004_assignments.sql
│   0005_support_tickets.sql
│   0006_admin_messages.sql
│   0007_views_progress.sql
│   0008_storage_buckets.sql
│   0009_rls_policies.sql
│   0010_embeddings.sql
│   0011_practice_packs.sql
│   0012_editorial_workflow.sql
│   0013_adaptive_and_diagnostics.sql
│   0014_shopify_cache.sql
│   0015_product_recs.sql
│   0016_realtime_tokens.sql
│   0017_limits_and_tiers.sql
│   0018_entitlements.sql
│   0019_affiliates.sql
│   0020_payments_events.sql
│   0021_filters.sql
│   0022_adyen_core.sql                  (historical, may be removed)
│   0023_reconciliation_jobs.sql
│   0024_coach_switch_cooldown.sql
│   0025_expressions_pack.sql
│   0026_weekly_recap_views.sql
│   0027_paymongo_core.sql               (placeholder to be filled)
│   0028_paypal_core.sql                 (placeholder to be filled)
│   0029_remove_adyen.sql                (only if 0022 applied)
│
├─ policies/                      ← human readable policy specs mirrored by 0009*
│   profiles.sql
│   sessions_policies.sql
│   attempts_policies.sql
│   drills_policies.sql
│   entitlements.sql
│   messages_policies.sql
│   tickets_policies.sql
│   ...
│
├─ seeds/                         ← idempotent seed data
│   coaches.sql
│   drills.sql
│   limits.sql
│
├─ triggers/
│   updated_at.sql                ← generic updated_at trigger
│
└─ views/
    v_drill_stats.sql
    v_drill_stats_daily.sql
    v_user_progress.sql
```

Keep migration numbers in sync with `ops/docs/release-notes.md`.

---

## Environments

We run two remote projects plus optional local.

* Staging: `polaris-staging` on Supabase. Maps to GitHub branch `staging` and Vercel staging.
* Production: `polaris-prod` on Supabase. Maps to GitHub branch `main` and Vercel production.
* Local: optional Supabase CLI project for fast iteration.

RLS is enabled on all user scoped tables in every environment. The service role is used only by server code.

Required env in web and core:

* `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
* `SUPABASE_SERVICE_ROLE_KEY` (server only)
* `SUPABASE_JWT_SECRET` set to the Auth settings secret in Supabase

---

## Getting started locally

1. Install Supabase CLI

   ```bash
   npm i -g supabase
   supabase --version
   ```
2. Create a local project

   ```bash
   supabase init
   supabase start
   ```
3. Point CLI to our migrations folder. Create `supabase/config.toml` with:

   ```toml
   [db]
   migrations_path = "ops/supabase/migrations"
   ```
4. Reset DB from migrations and apply seeds

   ```bash
   supabase db reset           # applies 0001… latest
   supabase db execute --file ops/supabase/seeds/coaches.sql
   supabase db execute --file ops/supabase/seeds/drills.sql
   supabase db execute --file ops/supabase/seeds/limits.sql
   ```
5. Generate types for TypeScript usage

   ```bash
   supabase gen types typescript --local > src/types/database.types.ts
   ```
6. Run RLS tests (optional but recommended)

   ```bash
   supabase db execute --file ops/supabase/tests/rls_tests.sql
   ```

Set `NEXT_PUBLIC_SUPABASE_URL` to the local URL from `supabase start`, and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the printed anon key. Set `SUPABASE_SERVICE_ROLE_KEY` in the core service only.

---

## Migration workflow

We keep migrations fully scripted and idempotent where possible.

### Create a new migration

```bash
supabase migration new "0030_new_feature"
# edit ops/supabase/migrations/0030_new_feature.sql
```

### Authoring rules

* Use `create table if not exists` where safe
* Use `create or replace function` for stable function names
* Add `comment on table` and `comment on column` for schema docs
* Use `alter type ... add value if not exists` for enums
* Add grants if you create new schemas or functions
* RLS: enable `alter table ... enable row level security` and add both `USING` and `WITH CHECK`
* Prefer natural keys for idempotent seeds inside migrations only when required

### Reversibility

Supabase does not run down migrations by default. If you add breaking changes, include a reversible path or a compensating migration. Document undo steps in `ops/docs/release-notes.md` under Rollback plan.

### Apply to staging then production

```bash
# staging
psql "$SUPABASE_STAGING_URL" -f ops/supabase/migrations/00NN_whatever.sql
# or use Supabase SQL editor if needed

# production after sign off
psql "$SUPABASE_PROD_URL" -f ops/supabase/migrations/00NN_whatever.sql
```

You can also use `supabase db push` for local-to-remote sync in early development, but prefer explicit SQL once stable.

---

## Policies and RLS

Policies live in `policies/*` for readability and are copied into migrations like `0009_rls_policies.sql`.

### Policy pattern

```sql
alter table profiles enable row level security;

create policy "read own profile"
  on profiles for select
  using ( id = auth.uid() or is_admin(auth.uid()) );

create policy "update own profile"
  on profiles for update
  using ( id = auth.uid() )
  with check ( id = auth.uid() );
```

### Admin helper

```sql
create or replace function is_admin(uid uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from profiles p where p.id = uid and p.role = 'admin'
  );
$$;
```

Run the full coverage script from `ops/docs/rls-tests.md` after changes.

---

## Functions and RPCs

Define RPCs in migrations with clear security.

```sql
create or replace function start_session(p_user uuid, p_drill uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare sid uuid := gen_random_uuid();
begin
  insert into sessions(id, user_id, drill_id, started_at)
  values (sid, p_user, p_drill, now());
  return sid;
end; $$;
```

* Use `security definer` only when the function must bypass RLS. Audit carefully.
* Always `set search_path = public` in definer functions.
* Log with a lightweight `events` insert if needed.

### Advisory lock helpers

Provided for cron jobs. See `ops/docs/vercel-cron.md`.

```sql
create or replace function try_lock(key text) returns boolean language sql as $$
  select pg_try_advisory_lock( hashtext(key) );
$$;
create or replace function unlock(key text) returns boolean language sql as $$
  select pg_advisory_unlock( hashtext(key) );
$$;
```

---

## Views and materialization

* `v_user_progress`, `v_drill_stats`, `v_drill_stats_daily` are read paths used by dashboards and recap jobs
* For heavy joins, create materialized views and refresh in the cron job defined in `vercel-cron.md`

Example refresh helper:

```sql
create or replace procedure refresh_views() language sql as $$
  refresh materialized view concurrently if exists v_drill_stats_daily;
  refresh materialized view concurrently if exists v_drill_stats;
$$;
```

---

## Embeddings

Migration `0010_embeddings.sql` initializes the vector extension and tables.

```sql
create extension if not exists vector;
-- example column
alter table drills add column if not exists embedding vector(768);
```

Use a background job to backfill embeddings safely.

---

## Payments schema notes

* `0020_payments_events.sql` stores normalized provider events
* `0018_entitlements.sql` stores active plan per user
* `0027_paymongo_core.sql` and `0028_paypal_core.sql` are placeholders to add provider metadata tables or enums if required
* `0029_remove_adyen.sql` must check for the existence of 0022 artifacts before dropping

All writes to entitlements and ledger must be in a single transaction. See `ops/docs/product-core.md` for the grant path.

---

## Seeds

Seeds are idempotent and safe to run multiple times.

```sql
insert into limits(key, value)
values ('free_minutes_daily', 10), ('pro_minutes_daily', 30)
on conflict (key) do update set value = excluded.value;
```

Avoid seeding PII. Use neutral demo content for coaches and drills.

---

## Storage buckets

Defined in `0008_storage_buckets.sql` and documented in `storage-buckets.md`.

* `user-media` for audio and uploads
* `public-assets` for coach assets and OG images
* Use signed URLs for private buckets and short TTLs

---

## Backups and restore

Follow `backup.md` for schedules and retention. Use `runbook_restore.md` during incidents.

* Keep at least 7 daily, 4 weekly, and 3 monthly snapshots
* Test a restore quarterly in staging

---

## CI checks

Add a GitHub Action to validate DB changes after migrations run on staging.

* Run `supabase migration list`
* Run RLS tests script and fail on any red
* Optionally run `psql` smoke queries

Example step:

```bash
psql "$SUPABASE_STAGING_URL" -c "select now();"
psql "$SUPABASE_STAGING_URL" -f ops/supabase/tests/rls_tests.sql
```

---

## Common errors and fixes

* `permission denied for relation`: missing policy or `security definer` not set. Add policy or change function security.
* `no schema has been selected to create in`: add `set search_path = public` in definer functions.
* `function already exists`: switch to `create or replace function`.
* RLS blocked writes during jobs: confirm the job uses service role or a definer function.
* Enum value already exists: use `add value if not exists`.

---

## Naming and conventions

* Tables and columns: snake_case
* Views: prefix with `v_`
* Functions: verbs like `start_session`, `finish_session`, `try_lock`
* Events table: `domain_action` for `name` values, for example `practice_submitted`

---

## Sign off checklist for DB PRs

* [ ] New tables have primary keys, indexes, and comments
* [ ] RLS enabled with at least one `USING` and `WITH CHECK` policy
* [ ] Functions audited for definer vs invoker and search_path set
* [ ] Migrations idempotent where safe and additive
* [ ] Seeds are idempotent and free of PII
* [ ] Views refreshed in cron if materialized
* [ ] RLS tests updated and pass
* [ ] Release notes updated with migration numbers
