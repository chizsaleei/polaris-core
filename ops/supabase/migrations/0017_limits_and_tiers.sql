-- =====================================================================
-- 0017_limits_and_tiers.sql
-- Plans (tiers), per-plan limits, per-user overrides, usage counters
-- Works with: entitlements, payments, analytics, feature flags
-- =====================================================================

-- Safety: helper touch (idempotent)
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $touch$
begin
  new.updated_at := now();
  return new;
end
$touch$;

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
  if not exists (select 1 from pg_type where typname = 'tier_code') then
    create type public.tier_code as enum ('free','pro','vip');
  end if;

  if not exists (select 1 from pg_type where typname = 'limit_key') then
    create type public.limit_key as enum (
      -- session & access
      'realtime_minutes_daily',        -- minutes per calendar day (Manila boundary)
      'active_coaches',                -- how many coaches a user can hold active
      'tools_unlocked',                -- # tools/features simultaneously unlocked
      'cooldown_days',                 -- coach-switch cooldown in days
      -- content & voice
      'tts_chars_daily',               -- characters for TTS per day
      'uploads_mb_daily',              -- uploads cap (audio, etc.)
      -- library / expressions
      'vocab_full_access',             -- boolean (0/1) gate for full vocab filters
      -- sharing & referrals (future)
      'share_tryouts_daily'            -- how many shareable tryouts a user can mint
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'limit_window') then
    create type public.limit_window as enum ('daily','monthly','rolling','lifetime','none');
  end if;
end $$;

-- =====================================================================
-- Catalog of all limits we track
-- =====================================================================
create table if not exists public.limits_catalog (
  key           public.limit_key primary key,
  window_kind   public.limit_window not null default 'none',
  description   text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

insert into public.limits_catalog (key, window_kind, description)
values
  ('realtime_minutes_daily', 'daily', 'Total realtime practice minutes allowed per calendar day'),
  ('active_coaches',         'none',  'How many coaches may be active concurrently'),
  ('tools_unlocked',         'none',  'How many Tools & Features unlocked at a time'),
  ('cooldown_days',          'none',  'Coach switch cooldown in days'),
  ('tts_chars_daily',        'daily', 'Text-to-speech characters allowed per day'),
  ('uploads_mb_daily',       'daily', 'Upload size budget (MB) per day'),
  ('vocab_full_access',      'none',  '1 enables full vocabulary filters & meanings'),
  ('share_tryouts_daily',    'daily', 'How many tryout links a user can share per day')
on conflict (key) do nothing;

drop trigger if exists trg_touch_limits_catalog on public.limits_catalog;
create trigger trg_touch_limits_catalog
before update on public.limits_catalog
for each row execute function public.touch_updated_at();

-- =====================================================================
-- Tier plans (pricing metadata is indicative; billing handled by payments)
-- =====================================================================
create table if not exists public.tier_plans (
  id                 uuid primary key default gen_random_uuid(),
  code               public.tier_code unique not null,
  name               text not null,
  -- Nominal list prices in USD cents for display/reporting
  -- Actual truth lives in payment providers / entitlements (PayPal / PayMongo)
  price_month_cents  int not null default 0,
  price_year_cents   int not null default 0,
  currency           text not null default 'USD',
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Align with current product: Pro 12.99 / 99, VIP 29 / 199
insert into public.tier_plans (code, name, price_month_cents, price_year_cents)
values
  ('free','Free', 0,    0),
  ('pro','Pro',   1299, 9900),
  ('vip','VIP',   2900, 19900)
on conflict (code) do nothing;

drop trigger if exists trg_touch_tier_plans on public.tier_plans;
create trigger trg_touch_tier_plans
before update on public.tier_plans
for each row execute function public.touch_updated_at();

-- =====================================================================
-- Per-plan limits
-- =====================================================================
create table if not exists public.tier_limits (
  plan_id      uuid references public.tier_plans(id) on delete cascade,
  key          public.limit_key not null,
  value_num    numeric,     -- numeric value (minutes, counts, MB, chars, days)
  value_bool   boolean,     -- for boolean-style gates (vocab_full_access)
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (plan_id, key)
);

drop trigger if exists trg_touch_tier_limits on public.tier_limits;
create trigger trg_touch_tier_limits
before update on public.tier_limits
for each row execute function public.touch_updated_at();

-- Seed defaults per operating rules
insert into public.tier_limits (plan_id, key, value_num, value_bool, note)
select p.id, k.key,
  case k.key
    when 'realtime_minutes_daily' then case p.code when 'free' then 10 when 'pro' then 30 else 1440 end
    when 'active_coaches'         then case p.code when 'free' then 1  when 'pro' then 1  else 99   end
    when 'tools_unlocked'         then case p.code when 'free' then 1  when 'pro' then 3  else 99   end
    when 'cooldown_days'          then case p.code when 'vip'  then 0  else 7 end
    when 'tts_chars_daily'        then case p.code when 'free' then 2000 when 'pro' then 20000 else 100000 end
    when 'uploads_mb_daily'       then case p.code when 'free' then 25   when 'pro' then 250   else 1024    end
    when 'share_tryouts_daily'    then case p.code when 'free' then 1    when 'pro' then 3     else 10      end
    else null
  end as value_num,
  case k.key
    when 'vocab_full_access' then (p.code in ('pro','vip'))
    else null
  end as value_bool,
  'seed'
from public.tier_plans p
cross join public.limits_catalog k
on conflict (plan_id, key) do nothing;

-- =====================================================================
-- Per-user overrides (support, promos, bug fixes)
-- =====================================================================
create table if not exists public.user_limits (
  user_id     uuid references public.profiles(id) on delete cascade,
  key         public.limit_key not null,
  value_num   numeric,
  value_bool  boolean,
  reason      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

drop trigger if exists trg_touch_user_limits on public.user_limits;
create trigger trg_touch_user_limits
before update on public.user_limits
for each row execute function public.touch_updated_at();

-- =====================================================================
-- Usage counters (rolling or windowed)
-- =====================================================================
create table if not exists public.limit_usage (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references public.profiles(id) on delete cascade,
  key           public.limit_key not null,
  used          numeric not null default 0,
  window_start  timestamptz not null,   -- app chooses Manila boundary for "daily"
  window_end    timestamptz not null,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists lu_user_key_window_idx
  on public.limit_usage (user_id, key, window_start desc);

drop trigger if exists trg_touch_limit_usage on public.limit_usage;
create trigger trg_touch_limit_usage
before update on public.limit_usage
for each row execute function public.touch_updated_at();

-- =====================================================================
-- Effective tier for a user (derived from entitlements later; default Free)
-- =====================================================================
create table if not exists public.user_tiers (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  plan_id      uuid not null references public.tier_plans(id) on delete restrict,
  source       text not null default 'seed', -- e.g., 'paypal', 'paymongo', 'admin', 'promo'
  activated_at timestamptz not null default now(),
  expires_at   timestamptz
);

-- Default all existing profiles to FREE if not already set
insert into public.user_tiers (user_id, plan_id, source)
select pr.id, tp.id, 'default'
from public.profiles pr
cross join lateral (
  select id from public.tier_plans where code = 'free'
) tp
on conflict (user_id) do nothing;

-- =====================================================================
-- Views and helpers
-- =====================================================================

-- View: the plan a user is currently on (handles nulls)
create or replace view public.v_user_plan as
select
  u.user_id,
  coalesce(
    u.plan_id,
    (select id from public.tier_plans where code = 'free')
  ) as plan_id
from public.user_tiers u
union
select
  pr.id as user_id,
  (select id from public.tier_plans where code = 'free') as plan_id
from public.profiles pr
where not exists (select 1 from public.user_tiers ut where ut.user_id = pr.id);

-- Function: get effective limit value (bool returned as numeric 0/1 if requested)
create or replace function public.get_effective_limit_num(
  p_user uuid,
  p_key  public.limit_key
)
returns numeric
language sql
stable
as $$
  with plan as (
    select v.plan_id
    from public.v_user_plan v
    where v.user_id = p_user
  ),
  plan_val as (
    select
      coalesce(tl.value_num, case when tl.value_bool is true then 1 else 0 end) as n
    from public.tier_limits tl
    join plan on plan.plan_id = tl.plan_id
    where tl.key = p_key
  ),
  user_override as (
    select
      coalesce(ul.value_num, case when ul.value_bool is true then 1 else null end) as n
    from public.user_limits ul
    where ul.user_id = p_user
      and ul.key = p_key
  )
  select coalesce(
           (select n from user_override),
           (select n from plan_val),
           0
         )::numeric
$$;

-- Function: how much has the user used in a given window range
create or replace function public.get_used_in_window(
  p_user         uuid,
  p_key          public.limit_key,
  p_window_start timestamptz,
  p_window_end   timestamptz
)
returns numeric
language sql
stable
as $$
  select coalesce(sum(used), 0)::numeric
  from public.limit_usage
  where user_id      = p_user
    and key          = p_key
    and window_start >= p_window_start
    and window_end   <= p_window_end
$$;

-- Function: record usage into the current window; upsert
create or replace function public.record_limit_usage(
  p_user         uuid,
  p_key          public.limit_key,
  p_amount       numeric,
  p_window_start timestamptz,
  p_window_end   timestamptz,
  p_meta         jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $record$
declare
  v_id uuid;
begin
  if p_amount <= 0 then
    return;
  end if;

  select id
  into v_id
  from public.limit_usage
  where user_id      = p_user
    and key          = p_key
    and window_start = p_window_start
    and window_end   = p_window_end
  limit 1;

  if v_id is null then
    insert into public.limit_usage (user_id, key, used, window_start, window_end, meta)
    values (p_user, p_key, p_amount, p_window_start, p_window_end, coalesce(p_meta, '{}'::jsonb));
  else
    update public.limit_usage
    set used       = used + p_amount,
        meta       = public.limit_usage.meta || coalesce(p_meta, '{}'::jsonb),
        updated_at = now()
    where id = v_id;
  end if;
end
$record$;

-- =====================================================================
-- RLS
-- =====================================================================

alter table if exists public.tier_plans     enable row level security;
alter table if exists public.tier_limits    enable row level security;
alter table if exists public.user_limits    enable row level security;
alter table if exists public.limit_usage    enable row level security;
alter table if exists public.user_tiers     enable row level security;
alter table if exists public.limits_catalog enable row level security;

-- Policies (no IF NOT EXISTS, use pg_policies checks)
do $$
begin
  -- Admin full access to catalogs and plans
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'limits_catalog'
      and policyname = 'limits admin all on catalogs'
  ) then
    create policy "limits admin all on catalogs"
    on public.limits_catalog
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'tier_plans'
      and policyname = 'limits admin all on plans'
  ) then
    create policy "limits admin all on plans"
    on public.tier_plans
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'tier_limits'
      and policyname = 'limits admin all on plan limits'
  ) then
    create policy "limits admin all on plan limits"
    on public.tier_limits
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  -- Users can read catalogs and plans
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'limits_catalog'
      and policyname = 'limits read catalogs'
  ) then
    create policy "limits read catalogs"
    on public.limits_catalog
    for select
    to authenticated
    using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'tier_plans'
      and policyname = 'limits read plans'
  ) then
    create policy "limits read plans"
    on public.tier_plans
    for select
    to authenticated
    using (is_active);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'tier_limits'
      and policyname = 'limits read tier_limits'
  ) then
    create policy "limits read tier_limits"
    on public.tier_limits
    for select
    to authenticated
    using (true);
  end if;

  -- User-specific data
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'user_limits'
      and policyname = 'user_limits read own'
  ) then
    create policy "user_limits read own"
    on public.user_limits
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'user_limits'
      and policyname = 'user_limits admin upsert'
  ) then
    create policy "user_limits admin upsert"
    on public.user_limits
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'limit_usage'
      and policyname = 'limit_usage read own'
  ) then
    create policy "limit_usage read own"
    on public.limit_usage
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'limit_usage'
      and policyname = 'limit_usage insert own'
  ) then
    create policy "limit_usage insert own"
    on public.limit_usage
    for insert
    to authenticated
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'limit_usage'
      and policyname = 'limit_usage update own'
  ) then
    create policy "limit_usage update own"
    on public.limit_usage
    for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'user_tiers'
      and policyname = 'user_tiers read own'
  ) then
    create policy "user_tiers read own"
    on public.user_tiers
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'user_tiers'
      and policyname = 'user_tiers admin manage'
  ) then
    create policy "user_tiers admin manage"
    on public.user_tiers
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;
end $$;

-- Anonymous: nothing
revoke all on public.tier_plans     from anon;
revoke all on public.tier_limits    from anon;
revoke all on public.user_limits    from anon;
revoke all on public.limit_usage    from anon;
revoke all on public.user_tiers     from anon;
revoke all on public.limits_catalog from anon;

-- Exec permissions
revoke all on function public.record_limit_usage(
  uuid,
  public.limit_key,
  numeric,
  timestamptz,
  timestamptz,
  jsonb
) from public;

grant execute on function public.record_limit_usage(
  uuid,
  public.limit_key,
  numeric,
  timestamptz,
  timestamptz,
  jsonb
) to authenticated;

-- =====================================================================
-- Convenience defaults for Manila day boundary in app code (doc note)
-- - For "daily" windows, your server should compute using Asia/Manila:
--   window_start = Manila midnight (converted to UTC)
--   window_end   = next Manila midnight (converted to UTC)
-- =====================================================================
