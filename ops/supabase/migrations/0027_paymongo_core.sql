-- =====================================================================
-- 0027_paymongo_core.sql
-- Provider-specific scaffolding for PayMongo integration.
-- Safe, additive, and idempotent where possible.
--
-- Contents
--  0) Shared helpers (touch_updated_at, is_admin) idempotent
--  1) Enum(s) for PayMongo statuses
--  2) PayMongo payment intent and payment tables (optional metadata cache)
--  3) Raw webhook event journal (paymongo_events)
--  4) RLS and policies (admin read, server writes)
--  5) Helper view(s) and upsert function for webhook ingestion
--  6) Optional price -> plan mapping
--
-- Date: 2025-11-14
-- =====================================================================

-- 0) Helpers -----------------------------------------------------------
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
    select 1 from pg_type where typname = 'paymongo_payment_status'
  ) then
    create type public.paymongo_payment_status as enum (
      'initiated',                -- created but not ready
      'requires_payment_method',  -- waiting for payment method
      'requires_action',          -- 3DS or next action
      'processing',               -- paying
      'succeeded',                -- paid
      'failed',                   -- failed
      'canceled'                  -- canceled
    );
  end if;
end $$;

-- 2) Tables: intents and payments (cache of provider metadata) ---------
create table if not exists public.paymongo_payment_intents (
  id                text primary key,           -- e.g. pi_...
  status            public.paymongo_payment_status,
  amount            bigint check (amount >= 0), -- centavos
  currency          text not null default 'PHP',
  client_key        text,
  customer_id       text,                       -- PayMongo customer id if used
  user_id           uuid references public.profiles(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_paymongo_pi_user
  on public.paymongo_payment_intents(user_id);
create index if not exists idx_paymongo_pi_status
  on public.paymongo_payment_intents(status);
create index if not exists idx_paymongo_pi_metadata_gin
  on public.paymongo_payment_intents
  using gin (metadata jsonb_path_ops);

create table if not exists public.paymongo_payments (
  id                text primary key,           -- e.g. pay_...
  payment_intent_id text references public.paymongo_payment_intents(id) on delete set null,
  status            public.paymongo_payment_status,
  amount            bigint check (amount >= 0), -- centavos
  currency          text not null default 'PHP',
  payment_method    text,                       -- e.g. card, gcash, grab_pay, paymaya, etc
  paid_at           timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_paymongo_pay_pi
  on public.paymongo_payments(payment_intent_id);
create index if not exists idx_paymongo_pay_status
  on public.paymongo_payments(status);
create index if not exists idx_paymongo_pay_metadata_gin
  on public.paymongo_payments
  using gin (metadata jsonb_path_ops);

-- updated_at triggers using shared touch_updated_at helper
drop trigger if exists trg_paymongo_pi_updated_at on public.paymongo_payment_intents;
create trigger trg_paymongo_pi_updated_at
  before update on public.paymongo_payment_intents
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_paymongo_pay_updated_at on public.paymongo_payments;
create trigger trg_paymongo_pay_updated_at
  before update on public.paymongo_payments
  for each row execute function public.touch_updated_at();

-- 3) Raw webhook event journal ----------------------------------------
create table if not exists public.paymongo_events (
  event_id          text primary key,     -- provider event id
  event_type        text not null,        -- e.g. payment.paid, payment.failed, payment_intent.payment_succeeded
  raw               jsonb not null,       -- full payload from PayMongo
  signature         text,                 -- x-paymongo-signature header if provided
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  duplicate         boolean not null default false,
  http_status       integer,              -- response code we returned to provider
  delivery_attempts integer not null default 1
);

create index if not exists idx_paymongo_events_type
  on public.paymongo_events(event_type);
create index if not exists idx_paymongo_events_received
  on public.paymongo_events(received_at);
create index if not exists idx_paymongo_events_raw_gin
  on public.paymongo_events
  using gin (raw jsonb_path_ops);

comment on table public.paymongo_events is
'Verbatim PayMongo webhook events for audit and replay. Never store PAN or secrets.';

-- 4) RLS and policies --------------------------------------------------
alter table public.paymongo_payment_intents enable row level security;
alter table public.paymongo_payments       enable row level security;
alter table public.paymongo_events         enable row level security;

-- Start safe: remove any default grants to anon/authenticated
revoke all on public.paymongo_payment_intents from anon, authenticated;
revoke all on public.paymongo_payments       from anon, authenticated;
revoke all on public.paymongo_events         from anon, authenticated;

-- Admin read policies (service role bypasses RLS for server-side jobs)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'paymongo_payment_intents'
      and policyname = 'admin read paymongo_payment_intents'
  ) then
    create policy "admin read paymongo_payment_intents"
      on public.paymongo_payment_intents
      for select
      to authenticated
      using (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'paymongo_payments'
      and policyname = 'admin read paymongo_payments'
  ) then
    create policy "admin read paymongo_payments"
      on public.paymongo_payments
      for select
      to authenticated
      using (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'paymongo_events'
      and policyname = 'admin read paymongo_events'
  ) then
    create policy "admin read paymongo_events"
      on public.paymongo_events
      for select
      to authenticated
      using (public.is_admin());
  end if;
end $$;

-- 5) Helper view and ingestion function -------------------------------

create or replace view public.v_paymongo_events_flat as
select
  e.event_id                                   as provider_event_id,
  e.event_type                                 as provider_event_type,
  (e.raw->'data'->'attributes'->>'status')     as status,
  ((e.raw->'data'->'attributes'->>'amount')::bigint) as amount_centavos,
  coalesce(e.raw->'data'->'attributes'->>'currency', 'PHP') as currency,
  e.raw->'data'->'attributes'->'metadata'      as metadata,
  e.raw->'data'->'attributes'->>'payment_intent_id' as payment_intent_id,
  e.raw->'data'->'attributes'->>'payment_id'        as payment_id,
  e.received_at,
  e.processed_at,
  e.duplicate
from public.paymongo_events e;

-- Upsert helper used by webhook handler.
-- Returns true if inserted, false if this was a duplicate delivery.
create or replace function public.paymongo_log_event(
  p_event_id    text,
  p_event_type  text,
  p_signature   text,
  p_raw         jsonb,
  p_received_at timestamptz default now()
) returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  inserted boolean := false;
begin
  insert into public.paymongo_events(
    event_id,
    event_type,
    raw,
    signature,
    received_at,
    duplicate,
    delivery_attempts
  )
  values (
    p_event_id,
    p_event_type,
    p_raw,
    p_signature,
    coalesce(p_received_at, now()),
    false,
    1
  )
  on conflict (event_id) do update
    set duplicate         = true,
        delivery_attempts = paymongo_events.delivery_attempts + 1,
        http_status       = null
  returning (xmax = 0) into inserted; -- true only on first insert

  return inserted;
end
$fn$;

grant execute on function public.paymongo_log_event(text, text, text, jsonb, timestamptz)
  to anon, authenticated;

-- 6) Provider price -> internal plan mapping ---------------------------
create table if not exists public.paymongo_price_map (
  price_id   text primary key,     -- PayMongo price or reference id from metadata
  plan_key   text not null,        -- e.g. 'pro_monthly', 'pro_yearly', 'vip_monthly', 'vip_yearly'
  amount     bigint not null check (amount >= 0),
  currency   text not null default 'PHP',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_paymongo_price_map_plan
  on public.paymongo_price_map(plan_key)
  where active;

drop trigger if exists trg_paymongo_price_map_updated_at on public.paymongo_price_map;
create trigger trg_paymongo_price_map_updated_at
  before update on public.paymongo_price_map
  for each row execute function public.touch_updated_at();

alter table public.paymongo_price_map enable row level security;
revoke all on public.paymongo_price_map from anon, authenticated;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'paymongo_price_map'
      and policyname = 'paymongo_price_map admin read'
  ) then
    create policy "paymongo_price_map admin read"
      on public.paymongo_price_map
      for select
      to authenticated
      using (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'paymongo_price_map'
      and policyname = 'paymongo_price_map admin write'
  ) then
    create policy "paymongo_price_map admin write"
      on public.paymongo_price_map
      for all
      to authenticated
      using (public.is_admin())
      with check (public.is_admin());
  end if;
end $$;

comment on table public.paymongo_price_map is
'Maps PayMongo price/reference ids to internal plan keys for entitlement grants.';

-- Seed common plan keys if not present (safe if run multiple times)
insert into public.paymongo_price_map(price_id, plan_key, amount, currency, active)
values
  ('pm_pro_monthly', 'pro_monthly', 129900, 'PHP', true),
  ('pm_pro_yearly',  'pro_yearly',  999000, 'PHP', true),
  ('pm_vip_monthly', 'vip_monthly', 290000, 'PHP', true),
  ('pm_vip_yearly',  'vip_yearly', 1990000, 'PHP', true)
on conflict (price_id) do nothing;

-- =====================================================================
-- End 0027_paymongo_core.sql
-- =====================================================================
