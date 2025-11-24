-- ===================================================================== 
-- Polaris Core - RLS Policies for public.affiliate_events
-- File: ops/supabase/policies/affiliate_events.sql
--
-- Table (from 0019_affiliates.sql, simplified):
--   id                 uuid primary key default gen_random_uuid()
--   event              text not null
--   status             text not null default 'pending'
--   affiliate_id       uuid references public.affiliates(id)
--   affiliate_user_id  uuid references public.profiles(id)
--   affiliate_code     text
--   user_id            uuid references public.profiles(id)
--   session_id         text
--   referral_id        uuid references public.affiliate_referrals(id)
--   payout_id          uuid references public.affiliate_payouts(id)
--   code               text
--   click_id           text
--   reference          text
--   provider           text
--   plan               text
--   source             text
--   medium             text
--   campaign           text
--   landing_url        text
--   referrer           text
--   country            text
--   user_agent         text
--   ua_hash            text
--   ip                 text
--   ip_hash            text
--   amount_minor       bigint
--   currency           text
--   meta               jsonb not null default '{}'::jsonb
--   raw                jsonb not null default '{}'::jsonb
--   happened_at        timestamptz not null default now()
--   created_at         timestamptz not null default now()
--   updated_at         timestamptz not null default now()
--
-- Dependencies:
--   function public.is_admin() returns boolean (no args)
--
-- Policy intent:
--   • Admin has full CRUD
--   • Affiliates can read their own events (by affiliate_user_id)
--   • Referred signed-in users can read events tied to their user_id
--   • Inserts/updates/deletes are done by server/service role only
--
-- Date: 2025-11-14
-- =====================================================================

-- Ensure is_admin() exists (idempotent, same pattern as other files)
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin'
      and n.nspname = 'public'
  ) then
    create or replace function public.is_admin() returns boolean
    language sql stable as $fn$
      select false
    $fn$;
  end if;
end $$;

-- Enable RLS on affiliate_events
alter table public.affiliate_events
  enable row level security;

-- Public (anon) should never touch affiliate_events directly
revoke all on public.affiliate_events from anon;

-- Clean up any older policies so we can reapply a unified set
drop policy if exists "aff admin all events" on public.affiliate_events;
drop policy if exists "aff read own events" on public.affiliate_events;
drop policy if exists "aff read events as referred user" on public.affiliate_events;

drop policy if exists "affiliate_events_admin_all" on public.affiliate_events;
drop policy if exists "affiliate_events_select_by_affiliate_owner" on public.affiliate_events;
drop policy if exists "affiliate_events_select_by_referred_user" on public.affiliate_events;

-- ---------------------------------------------------------------------
-- Admin: full access (select/insert/update/delete)
-- ---------------------------------------------------------------------
create policy "affiliate_events_admin_all"
on public.affiliate_events
as permissive
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- ---------------------------------------------------------------------
-- Affiliates: can read their own events
-- Matches rows where affiliate_user_id equals the current user
-- ---------------------------------------------------------------------
create policy "affiliate_events_select_by_affiliate_owner"
on public.affiliate_events
as permissive
for select
to authenticated
using (affiliate_user_id = auth.uid());

-- ---------------------------------------------------------------------
-- Referred users: may read events tied to their user_id
-- ---------------------------------------------------------------------
create policy "affiliate_events_select_by_referred_user"
on public.affiliate_events
as permissive
for select
to authenticated
using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- No user inserts/updates/deletes
-- Only the service role (bypassing RLS) or admin via SQL should modify rows.
-- ---------------------------------------------------------------------

-- Helpful indexes (idempotent, aligned with 0019_affiliates)
create index if not exists idx_aff_events_aff_owner_time
  on public.affiliate_events (affiliate_user_id, happened_at desc);

create index if not exists idx_aff_events_affiliate_id_time
  on public.affiliate_events (affiliate_id, happened_at desc);

create index if not exists idx_aff_events_user_id_time
  on public.affiliate_events (user_id, happened_at desc);

create index if not exists idx_aff_events_event_time
  on public.affiliate_events (event, happened_at desc);

-- Optional, matches 0019_affiliates if you want it here too
create index if not exists idx_aff_events_payout
  on public.affiliate_events (payout_id);

-- =====================================================================
-- End of policies/affiliate_events.sql
-- =====================================================================
