-- =====================================================================
-- 0028_paypal_core.sql
-- Provider-specific scaffolding for PayPal integration.
-- Safe, additive, and idempotent where possible.
--
-- Contents
--  0) Shared helpers (touch_updated_at, is_admin) idempotent
--  1) Enums for PayPal order and capture statuses
--  2) PayPal orders and captures tables (optional provider metadata cache)
--  3) Raw webhook event journal (paypal_events)
--  4) RLS and policies (admin read, server writes)
--  5) Helper view and upsert function for webhook ingestion
--  6) Provider price -> internal plan mapping
--
-- Date: 2025-11-14
-- =====================================================================

-- 0) Shared helpers ----------------------------------------------------
do $$
begin
  -- touch_updated_at: shared trigger helper used across migrations
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'touch_updated_at'
      and n.nspname = 'public'
  ) then
    create or replace function public.touch_updated_at()
    returns trigger
    language plpgsql
    as $fn$
    begin
      new.updated_at := now();
      return new;
    end
    $fn$;
  end if;

  -- is_admin: boolean guard, to be wired later to your real admin logic
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin'
      and n.nspname = 'public'
  ) then
    create or replace function public.is_admin()
    returns boolean
    language sql stable
    as $fn$
      select false
    $fn$;
  end if;
end $$;

-- 1) Enums -------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type where typname = 'paypal_order_status'
  ) then
    create type public.paypal_order_status as enum (
      'created',
      'approved',
      'payer_action_required',
      'completed',
      'voided',
      'canceled',
      'failed'
    );
  end if;

  if not exists (
    select 1 from pg_type where typname = 'paypal_capture_status'
  ) then
    create type public.paypal_capture_status as enum (
      'pending',
      'completed',
      'declined',
      'refunded',
      'partially_refunded',
      'reversed'
    );
  end if;
end $$;

-- 2) Tables: orders and captures (provider metadata caches) ------------
create table if not exists public.paypal_orders (
  id                text primary key,           -- e.g. 5O190127TN364715T
  status            public.paypal_order_status,
  amount_cents      bigint check (amount_cents >= 0), -- minor units
  currency          text not null default 'USD',
  payer_id          text,                       -- PayPal payer id
  user_id           uuid references public.profiles(id) on delete set null,
  intent            text,                       -- CAPTURE or AUTHORIZE
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_paypal_orders_user
  on public.paypal_orders(user_id);
create index if not exists idx_paypal_orders_status
  on public.paypal_orders(status);
create index if not exists idx_paypal_orders_metadata_gin
  on public.paypal_orders
  using gin (metadata jsonb_path_ops);

create table if not exists public.paypal_captures (
  id                text primary key,           -- e.g. 2GG279541U471931P
  order_id          text references public.paypal_orders(id) on delete set null,
  status            public.paypal_capture_status,
  amount_cents      bigint check (amount_cents >= 0),
  currency          text not null default 'USD',
  seller_breakdown  jsonb default '{}'::jsonb,
  paid_at           timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_paypal_captures_order
  on public.paypal_captures(order_id);
create index if not exists idx_paypal_captures_status
  on public.paypal_captures(status);
create index if not exists idx_paypal_captures_metadata_gin
  on public.paypal_captures
  using gin (metadata jsonb_path_ops);

-- updated_at triggers using shared touch_updated_at helper
drop trigger if exists trg_paypal_orders_updated_at on public.paypal_orders;
create trigger trg_paypal_orders_updated_at
  before update on public.paypal_orders
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_paypal_captures_updated_at on public.paypal_captures;
create trigger trg_paypal_captures_updated_at
  before update on public.paypal_captures
  for each row execute function public.touch_updated_at();

-- 3) Raw webhook event journal ----------------------------------------
create table if not exists public.paypal_events (
  event_id           text primary key,     -- PayPal webhook id
  event_type         text not null,        -- e.g. PAYMENT.CAPTURE.COMPLETED
  raw                jsonb not null,       -- full payload from PayPal
  transmission_id    text,                 -- PayPal-Transmission-Id
  signature          text,                 -- PayPal-Transmission-Sig
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  duplicate          boolean not null default false,
  http_status        integer,              -- response code returned to provider
  delivery_attempts  integer not null default 1
);

create index if not exists idx_paypal_events_type
  on public.paypal_events(event_type);
create index if not exists idx_paypal_events_received
  on public.paypal_events(received_at);
create index if not exists idx_paypal_events_raw_gin
  on public.paypal_events
  using gin (raw jsonb_path_ops);

comment on table public.paypal_events is
'Verbatim PayPal webhook events for audit and replay. Do not store secrets.';

-- 4) RLS and policies --------------------------------------------------
alter table public.paypal_orders   enable row level security;
alter table public.paypal_captures enable row level security;
alter table public.paypal_events   enable row level security;

-- Start safe: revoke any default grants
revoke all on public.paypal_orders   from anon, authenticated;
revoke all on public.paypal_captures from anon, authenticated;
revoke all on public.paypal_events   from anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'paypal_orders'
      and policyname = 'admin read paypal_orders'
  ) then
    create policy "admin read paypal_orders"
      on public.paypal_orders
      for select
      to authenticated
      using (public.is_admin());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'paypal_captures'
      and policyname = 'admin read paypal_captures'
  ) then
    create policy "admin read paypal_captures"
      on public.paypal_captures
      for select
      to authenticated
      using (public.is_admin());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'paypal_events'
      and policyname = 'admin read paypal_events'
  ) then
    create policy "admin read paypal_events"
      on public.paypal_events
      for select
      to authenticated
      using (public.is_admin());
  end if;
end $$;

-- 5) Helper view and ingestion function -------------------------------
create or replace view public.v_paypal_events_flat as
select
  e.event_id                                         as provider_event_id,
  e.event_type                                       as provider_event_type,
  (e.raw->'resource'->>'status')                     as status,
  (((e.raw->'resource'->'amount'->>'value')::numeric(20,2) * 100)::bigint) as amount_cents,
  coalesce(e.raw->'resource'->'amount'->>'currency_code', 'USD') as currency,
  e.raw->'resource'->'supplementary_data'->'related_ids'->>'order_id' as related_order_id,
  e.raw->'resource'->>'id'                            as resource_id,
  e.received_at,
  e.processed_at,
  e.duplicate
from public.paypal_events e;

-- Upsert helper used by webhook handler. Returns true if inserted, false if duplicate.
create or replace function public.paypal_log_event(
  p_event_id       text,
  p_event_type     text,
  p_transmission_id text,
  p_signature      text,
  p_raw            jsonb,
  p_received_at    timestamptz default now()
) returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  inserted boolean := false;
begin
  insert into public.paypal_events(
    event_id,
    event_type,
    raw,
    transmission_id,
    signature,
    received_at,
    duplicate,
    delivery_attempts
  )
  values (
    p_event_id,
    p_event_type,
    p_raw,
    p_transmission_id,
    p_signature,
    coalesce(p_received_at, now()),
    false,
    1
  )
  on conflict (event_id) do update
    set duplicate         = true,
        delivery_attempts = paypal_events.delivery_attempts + 1,
        http_status       = null
  returning (xmax = 0) into inserted; -- true only on insert

  return inserted;
end
$fn$;

grant execute on function public.paypal_log_event(
  text,
  text,
  text,
  text,
  jsonb,
  timestamptz
) to anon, authenticated;

-- 6) Provider price -> internal plan mapping ---------------------------
create table if not exists public.paypal_price_map (
  price_id   text primary key,     -- your PayPal product or plan id
  plan_key   text not null,        -- e.g. 'pro_monthly', 'pro_yearly', 'vip_monthly', 'vip_yearly'
  amount     bigint not null check (amount >= 0),
  currency   text not null default 'USD',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_paypal_price_map_plan
  on public.paypal_price_map(plan_key)
  where active;

drop trigger if exists trg_paypal_price_map_updated_at on public.paypal_price_map;
create trigger trg_paypal_price_map_updated_at
  before update on public.paypal_price_map
  for each row execute function public.touch_updated_at();

alter table public.paypal_price_map enable row level security;
revoke all on public.paypal_price_map from anon, authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'paypal_price_map'
      and policyname = 'paypal_price_map admin read'
  ) then
    create policy "paypal_price_map admin read"
      on public.paypal_price_map
      for select
      to authenticated
      using (public.is_admin());
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'paypal_price_map'
      and policyname = 'paypal_price_map admin write'
  ) then
    create policy "paypal_price_map admin write"
      on public.paypal_price_map
      for all
      to authenticated
      using (public.is_admin())
      with check (public.is_admin());
  end if;
end $$;

comment on table public.paypal_price_map is
'Maps PayPal product or plan ids to internal plan keys for entitlement grants.';

-- Seed common plan keys if not present (safe to run multiple times)
insert into public.paypal_price_map(price_id, plan_key, amount, currency, active)
values
  ('pp_pro_monthly', 'pro_monthly', 1299,  'USD', true),
  ('pp_pro_yearly',  'pro_yearly',  9900,  'USD', true),
  ('pp_vip_monthly', 'vip_monthly', 2900,  'USD', true),
  ('pp_vip_yearly',  'vip_yearly', 19900,  'USD', true)
on conflict (price_id) do nothing;

-- =====================================================================
-- End 0028_paypal_core.sql
-- =====================================================================
