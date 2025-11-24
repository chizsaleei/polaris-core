-- ===============================================================
-- 0022_adyen_core.sql
-- Adyen specific core schema for sessions, payments, and webhooks
-- Safe-by-default RLS. App code uses service role for writes.
-- ===============================================================

-- Enum of useful Adyen style statuses
do $$
begin
  if not exists (select 1 from pg_type where typname = 'adyen_payment_status') then
    create type public.adyen_payment_status as enum (
      'initiated',
      'authorised',
      'refused',
      'cancelled',
      'error',
      'received',
      'chargeback',
      'chargeback_reversed',
      'refund_requested',
      'refunded',
      'pending',
      'capture_pending',
      'captured',
      'refund_pending',
      'refund_failed',
      'expired'
    );
  end if;
end$$;

-- Minimal util if not already present
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
    end
    $fn$;
  end if;
end$$;

-- Optional is_admin guard, no-op default if not present
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin' and n.nspname = 'public'
  ) then
    create or replace function public.is_admin() returns boolean
    language sql stable as $$ select false $$;
  end if;
end$$;

-- ===============================================================
-- Adyen merchant accounts registered for this project
-- Note: do not store API keys here. Keep API keys in Vercel env vars.
-- ===============================================================
create table if not exists public.adyen_accounts (
  id                 uuid primary key default gen_random_uuid(),
  label              text not null,                -- "prod-main", "staging"
  merchant_account   text not null,                -- Adyen merchantAccount
  live               boolean not null default false,
  client_key         text,                         -- Adyen public client key (safe to store)
  webhook_hmac_key   text,                         -- HMAC key used to verify webhooks
  webhook_basic_user text,                         -- optional basic auth username for webhooks
  webhook_basic_pass text,                         -- optional basic auth password for webhooks
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (merchant_account, live)
);

drop trigger if exists trg_touch_adyen_accounts on public.adyen_accounts;
create trigger trg_touch_adyen_accounts
before update on public.adyen_accounts
for each row execute function public.touch_updated_at();

alter table public.adyen_accounts enable row level security;
-- No direct user access. Admin only.
revoke all on public.adyen_accounts from anon, authenticated;
create policy "adyen_accounts admin read"
on public.adyen_accounts for select to authenticated
using (public.is_admin());

create policy "adyen_accounts admin write"
on public.adyen_accounts for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ===============================================================
-- Adyen checkout sessions to power Drop-in or Components
-- Keep session id and sessionData to resume on client when needed
-- ===============================================================
create table if not exists public.adyen_sessions (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.adyen_accounts(id) on delete restrict,
  user_id             uuid references public.profiles(id) on delete set null,
  session_id          text not null,           -- from Adyen /sessions response
  session_data        text not null,           -- from Adyen /sessions response
  reference           text not null,           -- your merchantReference
  shopper_reference   text,                    -- stable id for recurring
  amount_minor        bigint not null,         -- minor units
  currency            text not null,           -- ISO code
  country_code        text,
  return_url          text,
  recurring           boolean not null default false,
  allowed_methods     text[] default null,     -- optional list to constrain PMs
  status              public.adyen_payment_status not null default 'initiated',
  result_code         text,                    -- optional Adyen resultCode mirror
  raw_response        jsonb,                   -- full /sessions response for traceability
  expires_at          timestamptz,             -- from Adyen response when present
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique(session_id)
);

create index if not exists idx_adyen_sessions_reference on public.adyen_sessions(reference);
create index if not exists idx_adyen_sessions_user on public.adyen_sessions(user_id);
create index if not exists idx_adyen_sessions_status on public.adyen_sessions(status);

drop trigger if exists trg_touch_adyen_sessions on public.adyen_sessions;
create trigger trg_touch_adyen_sessions
before update on public.adyen_sessions
for each row execute function public.touch_updated_at();

alter table public.adyen_sessions enable row level security;
-- Users can only read their own session rows. Writes are by server.
revoke all on public.adyen_sessions from anon, authenticated;
create policy "adyen_sessions user read own"
on public.adyen_sessions for select to authenticated
using (auth.uid() = user_id or public.is_admin());

create policy "adyen_sessions admin manage"
on public.adyen_sessions for all to authenticated
using (public.is_admin()) with check (public.is_admin()));

-- ===============================================================
-- Adyen payments captured from webhooks and API follow ups
-- There can be multiple payment events for a single merchantReference.
-- Keep latest status and raw payload for audit.
-- ===============================================================
create table if not exists public.adyen_payments (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.adyen_accounts(id) on delete restrict,
  session_id           uuid references public.adyen_sessions(id) on delete set null,
  user_id              uuid references public.profiles(id) on delete set null,
  psp_reference        text not null,            -- Adyen PSP reference
  merchant_reference   text not null,            -- your reference (often maps to internal checkout id)
  method               text,                     -- payment method type, e.g., scheme, alipay, wechatpay
  status               public.adyen_payment_status not null,
  result_code          text,                     -- resultCode from Adyen
  refusal_reason       text,
  amount_minor         bigint not null,
  currency             text not null,
  country_code         text,
  captured_amount_minor bigint not null default 0,
  refunded_amount_minor bigint not null default 0,
  metadata             jsonb default '{}'::jsonb,
  raw_response         jsonb,                    -- copy of API response that set this row
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique(psp_reference)
);

create index if not exists idx_adyen_payments_merchant_reference on public.adyen_payments(merchant_reference);
create index if not exists idx_adyen_payments_user on public.adyen_payments(user_id);
create index if not exists idx_adyen_payments_status on public.adyen_payments(status);

drop trigger if exists trg_touch_adyen_payments on public.adyen_payments;
create trigger trg_touch_adyen_payments
before update on public.adyen_payments
for each row execute function public.touch_updated_at();

alter table public.adyen_payments enable row level security;
-- No direct user access. Use server endpoints.
revoke all on public.adyen_payments from anon, authenticated;
create policy "adyen_payments admin read"
on public.adyen_payments for select to authenticated
using (public.is_admin());

create policy "adyen_payments admin manage"
on public.adyen_payments for all to authenticated
using (public.is_admin()) with check (public.is_admin()));

-- ===============================================================
-- Webhook intake. Store every notification item with signature result.
-- Use a stable idempotency hash to avoid duplicates.
-- ===============================================================
create table if not exists public.adyen_webhook_events (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.adyen_accounts(id) on delete restrict,
  notification_ts      timestamptz not null default now(),
  event_code           text not null,              -- AUTHORISATION, CAPTURE, REFUND, CHARGEBACK, etc.
  success              boolean,                    -- "true" or "false" parsed
  psp_reference        text,                       -- PSP reference
  original_reference   text,                       -- original PSP reference for follow up events
  merchant_reference   text,                       -- your reference
  amount               jsonb,                      -- {currency, value}
  event_date           timestamptz,                -- from additionalData.eventDate if present
  signature_valid      boolean,                    -- HMAC verification result
  payload              jsonb not null,             -- full NotificationRequestItem as JSON
  processing_error     text,                       -- any error we got while handling
  processed_at         timestamptz,                -- when our handler finished
  -- idempotency hash from the payload
  event_hash           text generated always as (encode(digest(coalesce(payload::text, ''), 'sha256'), 'hex')) stored
);

create unique index if not exists uq_adyen_webhook_event_hash on public.adyen_webhook_events(event_hash);
create index if not exists idx_adyen_webhook_psp on public.adyen_webhook_events(psp_reference);
create index if not exists idx_adyen_webhook_event_code on public.adyen_webhook_events(event_code);
create index if not exists idx_adyen_webhook_merchant_reference on public.adyen_webhook_events(merchant_reference);

alter table public.adyen_webhook_events enable row level security;
-- No user access. Only server.
revoke all on public.adyen_webhook_events from anon, authenticated;
create policy "adyen_webhook admin read"
on public.adyen_webhook_events for select to authenticated
using (public.is_admin());

create policy "adyen_webhook admin manage"
on public.adyen_webhook_events for all to authenticated
using (public.is_admin()) with check (public.is_admin()));

-- ===============================================================
-- Helpful view to see latest status per merchant_reference
-- ===============================================================
create or replace view public.v_adyen_latest_by_reference as
select p.*
from public.adyen_payments p
where p.updated_at = (
  select max(p2.updated_at)
  from public.adyen_payments p2
  where p2.merchant_reference = p.merchant_reference
);

-- ===============================================================
-- Bridge: push normalized rows into payments_events when possible
-- This function is defensive. It only runs if payments_events exists.
-- Call this from your webhook handler after verifying HMAC.
-- ===============================================================
create or replace function public.adyen_enqueue_payment_event()
returns trigger
language plpgsql
as $fn$
declare
  has_payments_events boolean;
begin
  select to_regclass('public.payments_events') is not null into has_payments_events;

  if has_payments_events then
    begin
      insert into public.payments_events (
        provider, provider_event, provider_psp_ref, merchant_reference,
        user_id, amount_minor, currency, status, raw, occurred_at, created_at
      )
      values (
        'adyen',
        new.event_code,
        new.psp_reference,
        new.merchant_reference,
        null,                                        -- try to join later if needed
        coalesce((new.amount->>'value')::bigint, null),
        coalesce(new.amount->>'currency', null),
        case
          when new.event_code ilike 'AUTHORISATION' and new.success is true then 'authorised'
          when new.event_code ilike 'CAPTURE' and new.success is true then 'captured'
          when new.event_code ilike 'REFUND' and new.success is true then 'refunded'
          when new.event_code ilike 'CANCEL' and new.success is true then 'cancelled'
          when new.event_code ilike 'CHARGEBACK' then 'chargeback'
          else 'received'
        end,
        new.payload,
        coalesce(new.event_date, new.notification_ts),
        now()
      )
      on conflict do nothing;
    exception when others then
      -- do not fail webhook ingestion if bridge fails
      null;
    end;
  end if;

  return new;
end
$fn$;

drop trigger if exists trg_adyen_webhook_bridge on public.adyen_webhook_events;
create trigger trg_adyen_webhook_bridge
after insert on public.adyen_webhook_events
for each row execute function public.adyen_enqueue_payment_event();

-- ===============================================================
-- Optional helper to upsert a payment snapshot from webhook
-- Your webhook code can call this after verifying HMAC.
-- ===============================================================
create or replace function public.adyen_upsert_payment_from_webhook(
  p_account_id uuid,
  p_user_id uuid,
  p_psp_reference text,
  p_merchant_reference text,
  p_status public.adyen_payment_status,
  p_result_code text,
  p_refusal_reason text,
  p_amount_minor bigint,
  p_currency text,
  p_country_code text,
  p_method text,
  p_raw jsonb
) returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  insert into public.adyen_payments as ap (
    account_id, user_id, psp_reference, merchant_reference,
    status, result_code, refusal_reason,
    amount_minor, currency, country_code,
    method, raw_response
  )
  values (
    p_account_id, p_user_id, p_psp_reference, p_merchant_reference,
    p_status, p_result_code, p_refusal_reason,
    p_amount_minor, p_currency, p_country_code,
    p_method, p_raw
  )
  on conflict (psp_reference) do update set
    user_id        = coalesce(excluded.user_id, ap.user_id),
    merchant_reference = excluded.merchant_reference,
    status         = excluded.status,
    result_code    = excluded.result_code,
    refusal_reason = excluded.refusal_reason,
    amount_minor   = excluded.amount_minor,
    currency       = excluded.currency,
    country_code   = excluded.country_code,
    method         = coalesce(excluded.method, ap.method),
    raw_response   = excluded.raw_response,
    updated_at     = now()
  returning id into v_id;

  return v_id;
end
$fn$;

grant execute on function public.adyen_upsert_payment_from_webhook(
  uuid, uuid, text, text, public.adyen_payment_status, text, text, bigint, text, text, text, jsonb
) to anon, authenticated;

-- ===============================================================
-- Notes
-- - Store API keys in Vercel env. Only client_key and HMAC live here.
-- - Use adyen_sessions for your /pay/checkout route and Drop-in.
-- - Insert every webhook item into adyen_webhook_events.
-- - Verify HMAC using adyen_accounts.webhook_hmac_key before trusting.
-- - After verification, upsert adyen_payments and let the bridge
--   trigger copy a normalized row into payments_events for analytics.
-- ===============================================================
