# RLS Tests

Version: 0.1.0
Status: Draft ready for implementation
Scope: end to end checks for Supabase Row Level Security across Polaris tables and views

---

## Goals

* Deny by default where appropriate. Only allow the minimum needed per role.
* Prove that users can access only their own rows.
* Prove that admins and the service role can do what they must and no more.
* Keep a repeatable test script that runs in local, staging, and production.

---

## Roles and identities under test

* `anon` user (unauthenticated)
* `authenticated` user A: `00000000-0000-0000-0000-0000000000a1`
* `authenticated` user B: `00000000-0000-0000-0000-0000000000b2`
* `service_role` for jobs and webhooks
* `is_admin(uid)` helper returns true for admin users

Use request scoped claims to simulate identities:

```sql
-- Simulate user A
set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1"}';

-- Simulate user B
set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000b2"}';

-- Simulate admin A
set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1","is_admin":true}';

-- Simulate service role
set local role service_role;
reset "request.jwt.claims"; -- not needed for service role
```

Notes

* Policies should use `auth.uid()` and `is_admin(auth.uid())` only.
* Never trust client sent user ids.

---

## Coverage matrix

Tables and views expected access by role.

| Table or view                                            | anon                 | authenticated (own)                        | authenticated (others) | admin                                   | service role  |
| -------------------------------------------------------- | -------------------- | ------------------------------------------ | ---------------------- | --------------------------------------- | ------------- |
| `profiles`                                               | none                 | select, update own profile fields          | none                   | select all, update any                  | full          |
| `sessions`                                               | none                 | select, insert own, update own, delete own | none                   | select all, limited update              | full          |
| `attempts`                                               | none                 | select own, insert own                     | none                   | select all                              | full          |
| `drills`                                                 | select public drills | select                                     | select                 | select insert update via editorial flow | full          |
| `catalogs`                                               | select published     | select                                     | select                 | curate                                  | full          |
| `entitlements`                                           | none                 | select own                                 | none                   | select all                              | insert update |
| `payments_events`                                        | none                 | none                                       | none                   | select                                  | insert update |
| `affiliates`, `affiliate_referrals`, `affiliate_payouts` | none                 | select own                                 | none                   | select all                              | insert update |
| `daily_usage`                                            | none                 | select own                                 | none                   | select all                              | insert update |
| `events` (analytics)                                     | none                 | insert own, select own                     | none                   | select all                              | insert update |
| `messages`, `tickets`                                    | none                 | select and insert own                      | none                   | select all                              | insert update |
| `views`: `v_user_progress`                               | none                 | select own                                 | none                   | select all                              | select        |

Adjust to match final policies in `ops/supabase/policies/*`.

---

## Golden policies checklist

* RLS is enabled on all user scoped tables.
* Policies reference `auth.uid()` only. No direct equality with arbitrary params.
* Write paths enforce both `USING` and `WITH CHECK` correctly.
* Admin override is narrow and uses `is_admin(auth.uid())`.
* Service role is not blocked by RLS.

Quick query to list RLS state and policies:

```sql
select schemaname, tablename, rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public'
order by 1,2;

select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by 1,2,6,3;
```

---

## Test data fixtures

Create minimal rows for two users.

```sql
begin;
-- Profiles
insert into profiles (id, email, full_name) values
  ('00000000-0000-0000-0000-0000000000a1','a@example.com','User A')
, ('00000000-0000-0000-0000-0000000000b2','b@example.com','User B')
on conflict do nothing;

-- Sessions
insert into sessions (id, user_id, started_at) values
  (gen_random_uuid(),'00000000-0000-0000-0000-0000000000a1', now())
, (gen_random_uuid(),'00000000-0000-0000-0000-0000000000b2', now());

-- Entitlements
insert into entitlements (user_id, plan, active, updated_at)
values
('00000000-0000-0000-0000-0000000000a1','free', true, now()),
('00000000-0000-0000-0000-0000000000b2','pro', true, now())
on conflict (user_id) do update set plan = excluded.plan, active = excluded.active;
commit;
```

---

## Assertion helper

A tiny helper logs pass or fail without throwing, so the script can continue and give a summary.

```sql
create schema if not exists test;
create or replace function test.assert(name text, ok boolean, detail text default null)
returns void language plpgsql as $$
begin
  insert into test.results(name, ok, detail, at)
  values (name, ok, detail, now());
end;$$;

create table if not exists test.results(
  id bigserial primary key,
  name text not null,
  ok boolean not null,
  detail text,
  at timestamptz not null default now()
);
```

At the end, print a summary

```sql
select count(*) total, sum((ok)::int) passed from test.results;
select * from test.results order by id;
```

---

## Core tests

### Profiles

```sql
-- User A sees self
set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1"}';
select test.assert('profiles: own row visible', exists(
  select 1 from profiles where id = auth.uid()
));

-- User A cannot see B
select test.assert('profiles: other row hidden', not exists(
  select 1 from profiles where id <> auth.uid()
));

-- User A can update own name
select test.assert('profiles: update own', (
  with upd as (
    update profiles set full_name = 'User A Prime' where id = auth.uid() returning 1
  ) select exists(select 1 from upd)
));

-- User A cannot update B
select test.assert('profiles: update other blocked', not exists (
  update profiles set full_name = 'Hack' where id <> auth.uid() returning 1
));
```

### Sessions

```sql
-- Insert own
select test.assert('sessions: insert own ok', (
  with ins as (
    insert into sessions (id, user_id, started_at)
    values (gen_random_uuid(), auth.uid(), now())
    returning 1
  ) select exists(select 1 from ins)
));

-- Insert for other blocked
select test.assert('sessions: insert other blocked', not exists (
  insert into sessions (id, user_id, started_at)
  values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000b2', now())
  returning 1
));

-- Select only own
select test.assert('sessions: only own visible', (
  select count(*) filter (where user_id = auth.uid()) = count(*) from sessions
));
```

### Attempts

```sql
-- Create attempt for own session ok. Create for other blocked.
-- Expect select to return only own attempts.
```

### Entitlements

```sql
-- Users can read their own only
select test.assert('entitlements: own visible', exists(
  select 1 from entitlements where user_id = auth.uid()
));
select test.assert('entitlements: other hidden', not exists(
  select 1 from entitlements where user_id <> auth.uid()
));

-- Users cannot write
select test.assert('entitlements: update blocked', not exists(
  update entitlements set plan = 'vip' where user_id = auth.uid() returning 1
));

-- Service role can write
set local role service_role; reset "request.jwt.claims";
select test.assert('entitlements: service can write', (
  with upd as (
    update entitlements set plan = 'pro' where user_id = '00000000-0000-0000-0000-0000000000a1' returning 1
  ) select exists(select 1 from upd)
));
```

### Payments events

```sql
-- Users cannot select
set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1"}';
select test.assert('payments_events: user blocked', not exists(
  select 1 from payments_events
));

-- Admin can select
set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000a1","is_admin":true}';
select test.assert('payments_events: admin visible', exists(
  select 1 from payments_events limit 1
));
```

### Views

```sql
-- v_user_progress returns only own rows
set local role authenticated;
set local "request.jwt.claims" = '{"role":"authenticated","sub":"00000000-0000-0000-0000-0000000000b2"}';
select test.assert('v_user_progress: only own', not exists(
  select 1 from v_user_progress where user_id <> auth.uid()
));
```

---

## Edge cases

* Null `request.jwt.claims` must behave like anon.
* Deleted profile: rows should be hidden or cascade deleted where designed.
* Soft deletes: policies should filter `deleted_at is null` by default.
* Time travel views: ensure policy still applies on historical queries.

---

## How to run locally

1. Apply migrations and enable RLS policies.
2. Load fixtures from this guide.
3. Run the script in a single transaction to avoid lingering settings.

Example psql run

```bash
psql "$DATABASE_URL" -f ops/supabase/tests/rls_tests.sql
```

Supabase CLI alternative

```bash
supabase db execute --file ops/supabase/tests/rls_tests.sql --db-url "$SUPABASE_DB_URL"
```

---

## CI integration

* Add a GitHub Action job that runs against staging after migrations.
* Fail the build if any `test.results.ok` is false.
* Export a short artifact with the failure list and correlation id.

---

## Drift detection

Keep a snapshot of policies in git and diff on every migration.

```sql
copy (
  select schemaname, tablename, policyname, cmd, roles, qual, with_check
  from pg_policies where schemaname = 'public' order by 1,2,3
) to stdout with csv header;
```

---

## Runbook for failures

* Identify the failing test name in `test.results`.
* Compare policy text with expected rules here.
* Check that `is_admin` function and helper views were deployed.
* If a data driven failure: inspect the failing row to confirm `user_id` is correct.
* Add a unit test for the fixed policy to prevent regressions.

---

## Files to add next

* `ops/supabase/tests/rls_tests.sql` full script assembled from this guide.
* `ops/supabase/policies/*` human readable policy files used by migrations.
* `ops/docs/runbooks/rls-failure.md` short triage steps.
