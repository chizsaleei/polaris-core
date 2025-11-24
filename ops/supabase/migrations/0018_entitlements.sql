-- =====================================================================
-- 0018_entitlements.sql
-- Entitlements granted by billing events (PayPal, PayMongo, admin, promo)
-- Works with: 0017_limits_and_tiers.sql, payments_events.sql (future)
-- =====================================================================

-- Safety helpers
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end
$fn$;

-- Fallback stub for is_admin if not present (safe to re-run)
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin'
      and n.nspname = 'public'
  ) then
    create function public.is_admin()
    returns boolean
    language sql
    stable
    as $fn$
      select false;
    $fn$;
  end if;
end $$;

-- =====================================================================
-- Enums
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'entitlement_source') then
    create type public.entitlement_source as enum ('paypal','paymongo','admin','promo','recon');
  end if;

  if not exists (select 1 from pg_type where typname = 'entitlement_status') then
    create type public.entitlement_status as enum (
      'active',
      'scheduled',
      'expired',
      'canceled',
      'revoked'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'subscription_status') then
    create type public.subscription_status as enum (
      'trialing',
      'active',
      'past_due',
      'canceled',
      'incomplete',
      'incomplete_expired'
    );
  end if;
end $$;

-- =====================================================================
-- Billing identity map per user (PayPal / PayMongo)
-- =====================================================================

create table if not exists public.billing_profiles (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  provider           text not null default 'paypal',
  shopper_reference  text unique,             -- stable user id at provider
  email              text,                    -- for reconciliation
  country            text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists trg_touch_billing_profiles on public.billing_profiles;
create trigger trg_touch_billing_profiles
before update on public.billing_profiles
for each row execute function public.touch_updated_at();

alter table if exists public.billing_profiles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'billing_profiles'
      and policyname = 'billing_profiles read self'
  ) then
    create policy "billing_profiles read self"
    on public.billing_profiles
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'billing_profiles'
      and policyname = 'billing_profiles admin manage'
  ) then
    create policy "billing_profiles admin manage"
    on public.billing_profiles
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;
end $$;

revoke all on public.billing_profiles from anon;

-- =====================================================================
-- Subscriptions (one row per ongoing contract with a provider)
-- =====================================================================

create table if not exists public.subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  plan_id              uuid not null references public.tier_plans(id) on delete restrict,
  source               public.entitlement_source not null default 'paypal',
  subscription_ref     text unique,              -- provider subscription id
  status               public.subscription_status not null default 'active',
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at          timestamptz,
  trial_start          timestamptz,
  trial_end            timestamptz,
  meta                 jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists subs_user_idx   on public.subscriptions(user_id);
create index if not exists subs_plan_idx   on public.subscriptions(plan_id);
create index if not exists subs_status_idx on public.subscriptions(status);

drop trigger if exists trg_touch_subscriptions on public.subscriptions;
create trigger trg_touch_subscriptions
before update on public.subscriptions
for each row execute function public.touch_updated_at();

alter table if exists public.subscriptions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'subscriptions'
      and policyname = 'subscriptions read own'
  ) then
    create policy "subscriptions read own"
    on public.subscriptions
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'subscriptions'
      and policyname = 'subscriptions admin manage'
  ) then
    create policy "subscriptions admin manage"
    on public.subscriptions
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;
end $$;

revoke all on public.subscriptions from anon;

-- =====================================================================
-- Entitlements table
-- Each row grants a plan for a time window. Multiple rows can stack.
-- =====================================================================

create table if not exists public.entitlements (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  plan_id         uuid not null references public.tier_plans(id) on delete restrict,
  source          public.entitlement_source not null default 'paypal',
  status          public.entitlement_status not null default 'active',
  starts_at       timestamptz not null,
  ends_at         timestamptz,              -- null means unlimited until revoked or replaced
  subscription_id uuid references public.subscriptions(id) on delete set null,
  reason          text,
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, plan_id, starts_at)
);

-- Patch older schemas where entitlements had "plan" (tier_code) instead of "plan_id"
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'entitlements'
  ) then
    -- ensure plan_id column exists
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name  = 'entitlements'
        and column_name = 'plan_id'
    ) then
      alter table public.entitlements
        add column plan_id uuid;
    end if;

    -- backfill plan_id from old "plan" column if present
    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name  = 'entitlements'
        and column_name = 'plan'
    ) then
      update public.entitlements e
      set plan_id = tp.id
      from public.tier_plans tp
      where tp.code::text = e.plan::text
        and e.plan_id is null;
    end if;
  end if;
end $$;

create index if not exists ent_user_time_idx     on public.entitlements(user_id, starts_at desc);
create index if not exists ent_status_idx        on public.entitlements(status);
create index if not exists ent_active_window_idx on public.entitlements(user_id, ends_at);

drop trigger if exists trg_touch_entitlements on public.entitlements;
create trigger trg_touch_entitlements
before update on public.entitlements
for each row execute function public.touch_updated_at();

alter table if exists public.entitlements enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'entitlements'
      and policyname = 'entitlements read own'
  ) then
    create policy "entitlements read own"
    on public.entitlements
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'entitlements'
      and policyname = 'entitlements admin manage'
  ) then
    create policy "entitlements admin manage"
    on public.entitlements
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;
end $$;

revoke all on public.entitlements from anon;

-- =====================================================================
-- View: active entitlements right now
-- =====================================================================

create or replace view public.v_active_entitlements as
select e.*
from public.entitlements e
where e.status = 'active'
  and e.starts_at <= now()
  and (e.ends_at is null or e.ends_at > now());

-- Pick the highest tier if overlapping windows exist
create or replace view public.v_user_current_plan as
select
  e.user_id,
  e.plan_id,
  e.starts_at,
  e.ends_at
from (
  select
    e.*,
    row_number() over (
      partition by e.user_id
      order by
        -- prefer higher tier by code rank vip > pro > free
        case (
          select code
          from public.tier_plans tp
          where tp.id = e.plan_id
        )
          when 'vip' then 3
          when 'pro' then 2
          else 1
        end desc,
        e.ends_at nulls last
    ) as rn
  from public.v_active_entitlements e
) e
where e.rn = 1;

-- =====================================================================
-- Sync user_tiers whenever entitlements change
-- =====================================================================

create or replace function public.sync_user_tier_from_entitlements(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_plan_id uuid;
  v_src     text := 'entitlements';
begin
  select plan_id
  into v_plan_id
  from public.v_user_current_plan
  where user_id = p_user
  limit 1;

  if v_plan_id is null then
    -- fall back to FREE
    select id
    into v_plan_id
    from public.tier_plans
    where code = 'free';

    v_src := 'fallback_free';
  end if;

  insert into public.user_tiers (user_id, plan_id, source, activated_at, expires_at)
  values (p_user, v_plan_id, v_src, now(), null)
  on conflict (user_id) do update
    set plan_id = excluded.plan_id,
        source = excluded.source,
        activated_at = case
          when public.user_tiers.plan_id is distinct from excluded.plan_id
            then now()
          else public.user_tiers.activated_at
        end,
        expires_at = null,
        updated_at = now();
end
$fn$;

create or replace function public.trg_entitlements_after_change()
returns trigger
language plpgsql
as $fn$
begin
  perform public.sync_user_tier_from_entitlements(coalesce(new.user_id, old.user_id));
  return null;
end
$fn$;

drop trigger if exists trg_entitlements_sync on public.entitlements;
create trigger trg_entitlements_sync
after insert or update or delete on public.entitlements
for each row execute function public.trg_entitlements_after_change();

-- =====================================================================
-- Helper to grant or update entitlement from a payment period
-- Useful for webhooks and reconciliation
-- =====================================================================

create or replace function public.upsert_entitlement_period(
  p_user            uuid,
  p_plan_code       public.tier_code,
  p_source          public.entitlement_source,
  p_status          public.entitlement_status,
  p_starts_at       timestamptz,
  p_ends_at         timestamptz,
  p_subscription_id uuid default null,
  p_reason          text default null,
  p_meta            jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_plan_id uuid;
  v_ent_id  uuid;
begin
  select id
  into v_plan_id
  from public.tier_plans
  where code = p_plan_code;

  if v_plan_id is null then
    raise exception 'Unknown plan code %', p_plan_code;
  end if;

  -- Try to find an identical window for idempotency
  select id
  into v_ent_id
  from public.entitlements
  where user_id = p_user
    and plan_id = v_plan_id
    and starts_at = p_starts_at
    and coalesce(ends_at, 'infinity'::timestamptz)
        = coalesce(p_ends_at, 'infinity'::timestamptz)
  limit 1;

  if v_ent_id is null then
    insert into public.entitlements (
      user_id,
      plan_id,
      source,
      status,
      starts_at,
      ends_at,
      subscription_id,
      reason,
      meta
    )
    values (
      p_user,
      v_plan_id,
      p_source,
      p_status,
      p_starts_at,
      p_ends_at,
      p_subscription_id,
      p_reason,
      coalesce(p_meta, '{}'::jsonb)
    )
    returning id into v_ent_id;
  else
    update public.entitlements
    set status          = p_status,
        source          = p_source,
        subscription_id = coalesce(p_subscription_id, public.entitlements.subscription_id),
        reason          = coalesce(p_reason, public.entitlements.reason),
        meta            = public.entitlements.meta || coalesce(p_meta, '{}'::jsonb),
        updated_at      = now()
    where id = v_ent_id;
  end if;

  perform public.sync_user_tier_from_entitlements(p_user);
  return v_ent_id;
end
$fn$;

grant execute on function public.upsert_entitlement_period(
  uuid,
  public.tier_code,
  public.entitlement_source,
  public.entitlement_status,
  timestamptz,
  timestamptz,
  uuid,
  text,
  jsonb
) to authenticated;

-- =====================================================================
-- Nightly reconciliation sketch support
-- =====================================================================

create table if not exists public.reconciliation_jobs (
  id           uuid primary key default gen_random_uuid(),
  run_date     date not null,
  scope        text not null default 'billing',  -- e.g. 'paypal', 'paymongo', 'billing'
  status       text not null default 'scheduled', -- scheduled, running, complete, failed
  stats        jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (run_date, scope)
);

drop trigger if exists trg_touch_recon on public.reconciliation_jobs;
create trigger trg_touch_recon
before update on public.reconciliation_jobs
for each row execute function public.touch_updated_at();

alter table if exists public.reconciliation_jobs enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'reconciliation_jobs'
      and policyname = 'recon admin manage'
  ) then
    create policy "recon admin manage"
    on public.reconciliation_jobs
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;
end $$;

revoke all on public.reconciliation_jobs from anon;

-- =====================================================================
-- Convenience: ensure everyone has a user_tiers row
-- =====================================================================

insert into public.user_tiers (user_id, plan_id, source)
select pr.id, tp.id, 'backfill_0018'
from public.profiles pr
join public.tier_plans tp on tp.code = 'free'
where not exists (
  select 1 from public.user_tiers ut
  where ut.user_id = pr.id
)
on conflict (user_id) do nothing;

-- Final notes:
-- 1) Webhook handlers for PayPal and PayMongo call upsert_entitlement_period
--    with the correct window and entitlement_source.
-- 2) When a subscription is canceled at period end, keep entitlement active
--    until the end and then move to canceled or expired.
-- 3) Nightly reconciliation jobs can compare provider records to entitlements
--    and heal mismatches via upsert_entitlement_period plus sync_user_tier_from_entitlements.
-- =====================================================================
