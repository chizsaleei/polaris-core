-- =====================================================================
-- Polaris Core - 0002_profiles_and_sessions.sql
-- Purpose:
--   • Add useful profile columns and indexes without redefining the table
--   • Auto-create profile on auth.users insert
--   • Keep profile email in sync with auth.users
--   • Extra session indexes for dashboards
-- Notes:
--   - 0001 already created public.profiles and public.sessions,
--     enums (tier_plan, user_role), RLS, and the tg_set_updated_at() trigger fn.
--   - This migration only alters and augments.
-- =====================================================================

set check_function_bodies = off;

-- -----------------------------
-- PROFILES - schema changes
-- -----------------------------
alter table public.profiles
  add column if not exists email                text,
  add column if not exists avatar_url           text,
  add column if not exists referral_code        text,
  add column if not exists billing_customer_ref text,
  add column if not exists last_seen_at         timestamptz;

-- Helpful indexes
create index if not exists idx_profiles_email on public.profiles (email);
-- Unique allows many NULLs, OK for fresh column
do $$
begin
  if not exists (
    select 1
    from   pg_indexes
    where  schemaname = 'public'
    and    indexname  = 'idx_profiles_referral_code_unique'
  ) then
    execute 'create unique index idx_profiles_referral_code_unique on public.profiles (referral_code)';
  end if;
end$$;

comment on table public.profiles is 'App-facing user profile tied to auth.users.';
comment on column public.profiles.billing_customer_ref is 'External billing identifier for payments mapping.';

-- Leave the updated_at trigger as created in 0001:
-- trigger name: tg_profiles_updated calling public.tg_set_updated_at()

-- -----------------------------
-- PROFILES - create-on-signup
-- -----------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $fn$
begin
  insert into public.profiles (id, email, full_name, avatar_url, referral_code)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', null),
    coalesce(new.raw_user_meta_data->>'avatar_url', null),
    substr(new.id::text, 1, 8)  -- simple deterministic seed
  )
  on conflict (id) do nothing;

  return new;
end
$fn$;

-- Recreate the trigger safely
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- -----------------------------
-- PROFILES - email sync
-- -----------------------------
create or replace function public.sync_profile_email()
returns trigger
language plpgsql
security definer
as $fn$
begin
  update public.profiles
     set email = new.email,
         updated_at = now()
   where id = new.id;
  return new;
end
$fn$;

drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
after update of email on auth.users
for each row execute function public.sync_profile_email();

-- RLS for profiles is already established in 0001 as:
--   "profiles_self_select", "profiles_self_update", "profiles_self_insert"
-- Nothing to add here to avoid policy name conflicts.

-- -----------------------------
-- SESSIONS - extra indexes only
-- -----------------------------
-- 0001 created public.sessions and idx_sessions_user_time
-- Add two more helpful indexes
create index if not exists idx_sessions_coach_started
  on public.sessions (coach_key, started_at desc);

create index if not exists idx_sessions_active
  on public.sessions (user_id)
  where ended_at is null;

-- =====================================================================
-- End of 0002_profiles_and_sessions.sql
-- =====================================================================
