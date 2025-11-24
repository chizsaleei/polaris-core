-- =====================================================================
-- 0020_payments_events.sql
-- Normalized payment events with invoices and subscriptions.
-- Works with: profiles, 0018_entitlements, 0019_affiliates (event_ref link),
-- and provider specific cores (PayPal, PayMongo).
-- =====================================================================

-- =====================================================================
-- Helper functions
-- =====================================================================

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'touch_updated_at' and n.nspname = 'public'
  ) then
    create or replace function public.touch_updated_at()
    returns trigger language plpgsql as $fn$
    begin
      new.updated_at := now();
      return new;
    end $fn$;
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin' and n.nspname = 'public'
  ) then
    create or replace function public.is_admin() returns boolean
    language sql stable as $fn$ select false $fn$;
  end if;
end $$;

-- =====================================================================
-- Enums (safe for existing installs)
-- =====================================================================

do $$
begin
  -- payment_provider
  if not exists (select 1 from pg_type where typname = 'payment_provider') then
    create type public.payment_provider as enum ('paypal');
  end if;

  alter type public.payment_provider add value if not exists 'paypal';
  alter type public.payment_provider add value if not exists 'paymongo';
  -- any older values like 'adyen' remain if they already exist

  -- payment_event_type
  if not exists (select 1 from pg_type where typname = 'payment_event_type') then
    create type public.payment_event_type as enum ('payment_authorized');
  end if;

  alter type public.payment_event_type add value if not exists 'payment_authorized';
  alter type public.payment_event_type add value if not exists 'payment_captured';
  alter type public.payment_event_type add value if not exists 'payment_refunded';
  alter type public.payment_event_type add value if not exists 'payment_failed';
  alter type public.payment_event_type add value if not exists 'invoice_paid';
  alter type public.payment_event_type add value if not exists 'invoice_failed';
  alter type public.payment_event_type add value if not exists 'subscription_created';
  alter type public.payment_event_type add value if not exists 'subscription_canceled';
  alter type public.payment_event_type add value if not exists 'dispute_opened';
  alter type public.payment_event_type add value if not exists 'dispute_won';
  alter type public.payment_event_type add value if not exists 'dispute_lost';

  -- payment_status
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type public.payment_status as enum ('pending');
  end if;

  alter type public.payment_status add value if not exists 'pending';
  alter type public.payment_status add value if not exists 'succeeded';
  alter type public.payment_status add value if not exists 'failed';
  alter type public.payment_status add value if not exists 'refunded';
  alter type public.payment_status add value if not exists 'partial_refund';
  alter type public.payment_status add value if not exists 'chargeback';
  alter type public.payment_status add value if not exists 'canceled';

  -- subscription_status
  if not exists (select 1 from pg_type where typname = 'subscription_status') then
    create type public.subscription_status as enum ('trialing');
  end if;

  alter type public.subscription_status add value if not exists 'trialing';
  alter type public.subscription_status add value if not exists 'active';
  alter type public.subscription_status add value if not exists 'past_due';
  alter type public.subscription_status add value if not exists 'canceled';
  alter type public.subscription_status add value if not exists 'incomplete';
  alter type public.subscription_status add value if not exists 'paused';
end $$;

-- =====================================================================
-- Core tables
-- =====================================================================

create table if not exists public.payments_events (
  id                  uuid primary key default gen_random_uuid(),
  provider            public.payment_provider not null,
  event_id            text not null,                      -- idempotency key from provider
  event_type          public.payment_event_type not null,
  status              public.payment_status not null default 'pending',

  -- Common identifiers
  user_id             uuid references public.profiles(id) on delete set null,
  subscription_id     uuid,                                -- link to user_subscriptions.id if known
  invoice_id          uuid,                                -- link to payments_invoices.id if known

  -- Provider fields (generic)
  psp_reference       text,                                -- provider reference id
  merchant_reference  text,                                -- merchant or order reference
  account_code        text,                                -- account or merchant account id

  -- Money
  currency            text,
  amount_cents        integer,                             -- positive for charges, negative for refunds

  -- Raw and verification
  signature_valid     boolean,
  raw                 jsonb not null,                      -- full raw payload for audit
  errors              text,

  received_at         timestamptz not null default now(),
  processed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (provider, event_id)
);

create index if not exists idx_payments_events_user on public.payments_events(user_id, received_at desc);
create index if not exists idx_payments_events_psp on public.payments_events(psp_reference);
create index if not exists idx_payments_events_type_time on public.payments_events(event_type, received_at desc);

drop trigger if exists trg_touch_payments_events on public.payments_events;
create trigger trg_touch_payments_events
before update on public.payments_events
for each row execute function public.touch_updated_at();

-- Minimal subscription tracker for entitlement logic
create table if not exists public.user_subscriptions (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  provider             public.payment_provider not null,
  external_id          text not null,                       -- provider subscription or customer id
  plan_code            text not null,                       -- 'free','pro','vip' or SKU
  status               public.subscription_status not null default 'trialing',
  current_period_start timestamptz,
  current_period_end   timestamptz,
  cancel_at            timestamptz,
  canceled_at          timestamptz,
  meta                 jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique(provider, external_id)
);

create index if not exists idx_user_subs_user on public.user_subscriptions(user_id);

drop trigger if exists trg_touch_user_subs on public.user_subscriptions;
create trigger trg_touch_user_subs
before update on public.user_subscriptions
for each row execute function public.touch_updated_at();

-- Minimal invoice tracker for reporting and reconciliation
create table if not exists public.payments_invoices (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  provider            public.payment_provider not null,
  external_id         text not null,                       -- provider reference for capture or recurring charge
  subscription_id     uuid references public.user_subscriptions(id) on delete set null,
  currency            text not null,
  amount_cents        integer not null,
  status              public.payment_status not null default 'pending',
  period_start        timestamptz,
  period_end          timestamptz,
  paid_at             timestamptz,
  refunded_cents      integer not null default 0,
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique(provider, external_id)
);

create index if not exists idx_invoices_user_time on public.payments_invoices(user_id, created_at desc);

drop trigger if exists trg_touch_invoices on public.payments_invoices;
create trigger trg_touch_invoices
before update on public.payments_invoices
for each row execute function public.touch_updated_at();

-- =====================================================================
-- Mark processed helper
-- =====================================================================

create or replace function public.mark_payment_event_processed(p_id uuid, p_err text default null)
returns void
language sql
security definer
set search_path = public
as $fn$
  update public.payments_events
  set processed_at = now(),
      errors = p_err,
      updated_at = now()
  where id = p_id;
$fn$;

grant execute on function public.mark_payment_event_processed(uuid, text) to authenticated;

-- =====================================================================
-- Views for dashboards
-- =====================================================================

-- Use ::text comparisons so newly added enum values are safe inside this transaction
create or replace view public.v_revenue_daily as
select
  date_trunc('day', coalesce(pe.processed_at, pe.received_at)) as day,
  pe.currency,
  sum(pe.amount_cents) filter (
    where pe.status::text = 'succeeded'
      and pe.event_type::text in ('payment_captured','invoice_paid')
  ) as gross_cents,
  sum(abs(pe.amount_cents)) filter (
    where pe.status::text in ('refunded','chargeback')
  ) as refunds_cents,
  count(*) filter (
    where pe.event_type::text in ('payment_captured','invoice_paid')
      and pe.status::text = 'succeeded'
  ) as tx_count
from public.payments_events pe
group by 1, 2
order by 1 desc;

create or replace view public.v_subscriptions_active as
select
  us.user_id,
  us.plan_code,
  us.status,
  us.current_period_start,
  us.current_period_end
from public.user_subscriptions us
where us.status::text in ('trialing','active','past_due');

-- =====================================================================
-- RLS
-- =====================================================================

alter table public.payments_events enable row level security;

drop policy if exists "payments_events admin manage" on public.payments_events;
create policy "payments_events admin manage"
on public.payments_events for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "payments_events user read" on public.payments_events;
create policy "payments_events user read"
on public.payments_events for select to authenticated
using (user_id is not null and auth.uid() = user_id);

revoke all on public.payments_events from anon;

alter table public.payments_invoices enable row level security;

drop policy if exists "payments_invoices admin manage" on public.payments_invoices;
create policy "payments_invoices admin manage"
on public.payments_invoices for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "payments_invoices user read" on public.payments_invoices;
create policy "payments_invoices user read"
on public.payments_invoices for select to authenticated
using (auth.uid() = user_id);

revoke all on public.payments_invoices from anon;

alter table public.user_subscriptions enable row level security;

drop policy if exists "user_subscriptions admin manage" on public.user_subscriptions;
create policy "user_subscriptions admin manage"
on public.user_subscriptions for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "user_subscriptions user read" on public.user_subscriptions;
create policy "user_subscriptions user read"
on public.user_subscriptions for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "user_subscriptions user update_own" on public.user_subscriptions;
create policy "user_subscriptions user update_own"
on public.user_subscriptions for update to authenticated
using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on public.user_subscriptions from anon;

-- =====================================================================
-- Optional seed to ease dev testing
-- =====================================================================

insert into public.user_subscriptions (user_id, provider, external_id, plan_code, status)
select id, 'paypal', gen_random_uuid()::text, 'pro', 'trialing'
from public.profiles
where false;  -- flip to true manually if you want seed rows in dev
