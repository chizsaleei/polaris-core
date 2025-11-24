-- =====================================================================
-- 0019_affiliates.sql
-- Affiliate program: links, clicks, referrals, events, commissions, payouts
-- Works with profiles (users) and 0018_entitlements
-- For Polaris we assume no production affiliate data yet, so we hard-reset
-- any previous affiliate_* tables to avoid column mismatches.
-- =====================================================================

-- =====================================================================
-- Helpers
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
    language sql stable as $fn$
      select false
    $fn$;
  end if;
end $$;

-- =====================================================================
-- Enums
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_type where typname = 'affiliate_status') then
    create type public.affiliate_status as enum ('pending','active','blocked');
  end if;

  if not exists (select 1 from pg_type where typname = 'affiliate_attr_model') then
    create type public.affiliate_attr_model as enum ('first','last','hybrid');
  end if;

  if not exists (select 1 from pg_type where typname = 'referral_status') then
    create type public.referral_status as enum ('pending','qualified','disqualified','converted');
  end if;

  if not exists (select 1 from pg_type where typname = 'commission_status') then
    create type public.commission_status as enum ('accrued','pending_payout','paid','reversed');
  end if;

  if not exists (select 1 from pg_type where typname = 'payout_status') then
    create type public.payout_status as enum ('scheduled','processing','paid','failed','canceled');
  end if;
end $$;

-- Extend enum values used by the API if needed
do $$
begin
  if exists (select 1 from pg_type where typname = 'referral_status') then
    alter type public.referral_status add value if not exists 'clicked';
    alter type public.referral_status add value if not exists 'attached';
    alter type public.referral_status add value if not exists 'paid';
  end if;

  if exists (select 1 from pg_type where typname = 'payout_status') then
    alter type public.payout_status add value if not exists 'pending';
    alter type public.payout_status add value if not exists 'approved';
  end if;
end $$;

-- =====================================================================
-- Hard reset any old affiliate tables (Polaris: safe to drop)
-- =====================================================================

drop table if exists public.affiliate_events    cascade;
drop table if exists public.affiliate_payouts   cascade;
drop table if exists public.affiliate_commissions cascade;
drop table if exists public.affiliate_referrals cascade;
drop table if exists public.affiliate_clicks    cascade;
drop table if exists public.affiliate_links     cascade;
drop table if exists public.affiliates          cascade;
drop table if exists public.affiliate_programs  cascade;

-- =====================================================================
-- Affiliate programs and accounts
-- =====================================================================

create table public.affiliate_programs (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name             text not null,
  default_rate_bps integer not null default 1000,
  cookie_days      integer not null default 30,
  min_payout_cents integer not null default 2500,
  currency         text not null default 'USD',
  settings         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.affiliates (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  program_id     uuid references public.affiliate_programs(id) on delete restrict,
  code           text not null unique,
  status         public.affiliate_status not null default 'pending',
  display_name   text,
  headline       text,
  website        text,
  cookie_days    integer,
  rate_bps       integer,
  payout_method  jsonb not null default '{}'::jsonb,
  tax_info       jsonb not null default '{}'::jsonb,
  metadata       jsonb not null default '{}'::jsonb,
  totals         jsonb not null default '{}'::jsonb,
  approved_at    timestamptz,
  blocked_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (program_id, user_id)
);

create index idx_affiliates_user on public.affiliates(user_id);

-- =====================================================================
-- Vanity affiliate links
-- =====================================================================

create table public.affiliate_links (
  id            uuid primary key default gen_random_uuid(),
  affiliate_id  uuid not null references public.affiliates(id) on delete cascade,
  code          text not null unique,
  landing_path  text not null default '/',
  landing_url   text,
  utm_defaults  jsonb not null default '{}'::jsonb,
  meta          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index idx_aff_links_aff on public.affiliate_links(affiliate_id);

-- =====================================================================
-- Clicks, referrals, commissions, payouts, events
-- =====================================================================

create table public.affiliate_clicks (
  id            uuid primary key default gen_random_uuid(),
  link_id       uuid not null references public.affiliate_links(id) on delete cascade,
  affiliate_id  uuid not null references public.affiliates(id) on delete cascade,
  clicked_at    timestamptz not null default now(),
  ip_hash       text,
  user_agent    text,
  country       text,
  utm           jsonb not null default '{}'::jsonb,
  meta          jsonb not null default '{}'::jsonb
);

create index idx_aff_clicks_link_time on public.affiliate_clicks(link_id, clicked_at desc);
create index idx_aff_clicks_aff_time on public.affiliate_clicks(affiliate_id, clicked_at desc);

create table public.affiliate_referrals (
  id                uuid primary key default gen_random_uuid(),
  affiliate_id      uuid references public.affiliates(id) on delete set null,
  affiliate_user_id uuid references public.profiles(id) on delete set null,
  affiliate_code    text,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  referral_code     text,
  status            public.referral_status not null default 'pending',
  reason            text,
  click_id          text,
  plan              text,
  last_payment_ref  text,
  utm_source        text,
  utm_medium        text,
  utm_campaign      text,
  metadata          jsonb not null default '{}'::jsonb,
  first_touch_at    timestamptz,
  last_touch_at     timestamptz,
  attached_at       timestamptz,
  qualified_at      timestamptz,
  converted_at      timestamptz,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.affiliate_commissions (
  id                uuid primary key default gen_random_uuid(),
  affiliate_id      uuid not null references public.affiliates(id) on delete cascade,
  affiliate_user_id uuid references public.profiles(id) on delete set null,
  referral_id       uuid references public.affiliate_referrals(id) on delete set null,
  event_ref         text,
  currency          text not null default 'USD',
  amount_minor      bigint not null,
  rate_bps          integer,
  status            public.commission_status not null default 'accrued',
  period_start      timestamptz,
  period_end        timestamptz,
  meta              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_aff_comm_aff on public.affiliate_commissions(affiliate_id, created_at desc);
create index idx_aff_comm_ref on public.affiliate_commissions(referral_id);

create table public.affiliate_payouts (
  id                uuid primary key default gen_random_uuid(),
  affiliate_id      uuid not null references public.affiliates(id) on delete cascade,
  affiliate_user_id uuid references public.profiles(id) on delete set null,
  payee_user_id     uuid references public.profiles(id) on delete set null,
  amount_minor      bigint not null,
  currency          text not null default 'USD',
  status            public.payout_status not null default 'pending',
  period_start      date,
  period_end        date,
  notes             text,
  tx_ref            text,
  failure_reason    text,
  metadata          jsonb not null default '{}'::jsonb,
  created_by        uuid references public.profiles(id) on delete set null,
  scheduled_at      timestamptz,
  approved_at       timestamptz,
  paid_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_aff_ref_aff     on public.affiliate_referrals(affiliate_id);
create index idx_aff_ref_user    on public.affiliate_referrals(user_id);
create index idx_aff_ref_code    on public.affiliate_referrals(affiliate_code);
create index idx_aff_ref_status  on public.affiliate_referrals(status);

create index idx_aff_payouts_aff           on public.affiliate_payouts(affiliate_id, created_at desc);
create index idx_aff_payouts_status        on public.affiliate_payouts(status, created_at desc);
create index idx_aff_payouts_aff_owner_paid on public.affiliate_payouts(affiliate_user_id, paid_at desc);
create index idx_aff_payouts_payee         on public.affiliate_payouts(payee_user_id);

create table public.affiliate_events (
  id                uuid primary key default gen_random_uuid(),
  event_type        text not null,
  status            text not null default 'pending',
  affiliate_id      uuid references public.affiliates(id) on delete set null,
  affiliate_user_id uuid references public.profiles(id) on delete set null,
  affiliate_code    text,
  user_id           uuid references public.profiles(id) on delete set null,
  referral_id       uuid references public.affiliate_referrals(id) on delete set null,
  payout_id         uuid references public.affiliate_payouts(id) on delete set null,
  code              text,
  click_id          text,
  reference         text,
  provider          text,
  plan              text,
  source            text,
  medium            text,
  campaign          text,
  landing_url       text,
  referrer          text,
  country           text,
  user_agent        text,
  ua_hash           text,
  ip                text,
  ip_hash           text,
  amount_minor      bigint,
  currency          text,
  meta              jsonb not null default '{}'::jsonb,
  raw               jsonb not null default '{}'::jsonb,
  happened_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_aff_events_aff_owner_time      on public.affiliate_events(affiliate_user_id, happened_at desc);
create index idx_aff_events_affiliate_id_time   on public.affiliate_events(affiliate_id, happened_at desc);
create index idx_aff_events_user_id_time        on public.affiliate_events(user_id, happened_at desc);
create index idx_aff_events_type_time           on public.affiliate_events(event_type, happened_at desc);
create index idx_aff_events_payout              on public.affiliate_events(payout_id);

-- =====================================================================
-- Helper triggers to keep affiliate_user_id in sync
-- =====================================================================

create or replace function public.set_affiliate_owner()
returns trigger
language plpgsql
as $fn$
declare
  v_user uuid;
begin
  if new.affiliate_id is null then
    return new;
  end if;

  select a.user_id into v_user
  from public.affiliates a
  where a.id = new.affiliate_id
  limit 1;

  if v_user is not null then
    new.affiliate_user_id := v_user;
  end if;

  return new;
end $fn$;

-- Touch triggers
drop trigger if exists trg_touch_aff_programs on public.affiliate_programs;
create trigger trg_touch_aff_programs
before update on public.affiliate_programs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_affiliates on public.affiliates;
create trigger trg_touch_affiliates
before update on public.affiliates
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_aff_links on public.affiliate_links;
create trigger trg_touch_aff_links
before update on public.affiliate_links
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_aff_ref on public.affiliate_referrals;
create trigger trg_touch_aff_ref
before update on public.affiliate_referrals
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_aff_comm on public.affiliate_commissions;
create trigger trg_touch_aff_comm
before update on public.affiliate_commissions
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_aff_payouts on public.affiliate_payouts;
create trigger trg_touch_aff_payouts
before update on public.affiliate_payouts
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_aff_events on public.affiliate_events;
create trigger trg_touch_aff_events
before update on public.affiliate_events
for each row execute function public.touch_updated_at();

-- Owner sync triggers
drop trigger if exists trg_aff_ref_set_owner on public.affiliate_referrals;
create trigger trg_aff_ref_set_owner
before insert or update on public.affiliate_referrals
for each row execute function public.set_affiliate_owner();

drop trigger if exists trg_aff_comm_set_owner on public.affiliate_commissions;
create trigger trg_aff_comm_set_owner
before insert or update on public.affiliate_commissions
for each row execute function public.set_affiliate_owner();

drop trigger if exists trg_aff_payouts_set_owner on public.affiliate_payouts;
create trigger trg_aff_payouts_set_owner
before insert or update on public.affiliate_payouts
for each row execute function public.set_affiliate_owner();

drop trigger if exists trg_aff_events_set_owner on public.affiliate_events;
create trigger trg_aff_events_set_owner
before insert or update on public.affiliate_events
for each row execute function public.set_affiliate_owner();

-- =====================================================================
-- Functions
-- =====================================================================

create or replace function public.get_affiliate_link(p_code text)
returns public.affiliate_links
language sql stable as $fn$
  select l.* from public.affiliate_links l where l.code = p_code limit 1;
$fn$;

create or replace function public.record_affiliate_click(
  p_code      text,
  p_ip_hash   text,
  p_user_agent text,
  p_country   text,
  p_utm       jsonb default '{}'::jsonb,
  p_meta      jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_link public.affiliate_links;
  v_id   uuid;
begin
  select * into v_link from public.affiliate_links where code = p_code;
  if v_link.id is null then
    return null;
  end if;

  insert into public.affiliate_clicks(
    link_id, affiliate_id, ip_hash, user_agent, country, utm, meta
  ) values (
    v_link.id,
    v_link.affiliate_id,
    p_ip_hash,
    left(p_user_agent, 1024),
    p_country,
    coalesce(p_utm, '{}'::jsonb),
    coalesce(p_meta, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end $fn$;

-- =====================================================================
-- RLS
-- =====================================================================

alter table public.affiliate_programs     enable row level security;
alter table public.affiliates             enable row level security;
alter table public.affiliate_links        enable row level security;
alter table public.affiliate_clicks       enable row level security;
alter table public.affiliate_referrals    enable row level security;
alter table public.affiliate_commissions  enable row level security;
alter table public.affiliate_payouts      enable row level security;
alter table public.affiliate_events       enable row level security;

-- Admin policies
drop policy if exists "aff admin all programs"    on public.affiliate_programs;
create policy "aff admin all programs"
on public.affiliate_programs
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "aff admin all affiliates"  on public.affiliates;
create policy "aff admin all affiliates"
on public.affiliates
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "aff admin all links"       on public.affiliate_links;
create policy "aff admin all links"
on public.affiliate_links
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "aff admin all referrals"   on public.affiliate_referrals;
create policy "aff admin all referrals"
on public.affiliate_referrals
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "aff admin all commissions" on public.affiliate_commissions;
create policy "aff admin all commissions"
on public.affiliate_commissions
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "aff admin all payouts"     on public.affiliate_payouts;
create policy "aff admin all payouts"
on public.affiliate_payouts
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

drop policy if exists "aff admin all events"      on public.affiliate_events;
create policy "aff admin all events"
on public.affiliate_events
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Owner / user policies
drop policy if exists "aff read own affiliate" on public.affiliates;
create policy "aff read own affiliate"
on public.affiliates
for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "aff read own links" on public.affiliate_links;
create policy "aff read own links"
on public.affiliate_links
for select to authenticated
using (
  exists (
    select 1 from public.affiliates a
    where a.id = affiliate_links.affiliate_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "aff read own clicks" on public.affiliate_clicks;
create policy "aff read own clicks"
on public.affiliate_clicks
for select to authenticated
using (
  exists (
    select 1 from public.affiliates a
    where a.id = affiliate_clicks.affiliate_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "aff read own referrals" on public.affiliate_referrals;
create policy "aff read own referrals"
on public.affiliate_referrals
for select to authenticated
using (
  exists (
    select 1 from public.affiliates a
    where a.id = affiliate_referrals.affiliate_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "aff referred user read referrals" on public.affiliate_referrals;
create policy "aff referred user read referrals"
on public.affiliate_referrals
for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "aff read own commissions" on public.affiliate_commissions;
create policy "aff read own commissions"
on public.affiliate_commissions
for select to authenticated
using (
  exists (
    select 1 from public.affiliates a
    where a.id = affiliate_commissions.affiliate_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "aff read own payouts" on public.affiliate_payouts;
create policy "aff read own payouts"
on public.affiliate_payouts
for select to authenticated
using (
  exists (
    select 1 from public.affiliates a
    where a.id = affiliate_payouts.affiliate_id
      and a.user_id = auth.uid()
  )
);

drop policy if exists "aff read payouts as payee" on public.affiliate_payouts;
create policy "aff read payouts as payee"
on public.affiliate_payouts
for select to authenticated
using (auth.uid() = payee_user_id);

drop policy if exists "aff read own events" on public.affiliate_events;
create policy "aff read own events"
on public.affiliate_events
for select to authenticated
using (
  exists (
    select 1 from public.affiliates a
    where a.id = affiliate_events.affiliate_id
      and a.user_id = auth.uid()
  )
  or affiliate_events.affiliate_user_id = auth.uid()
);

drop policy if exists "aff read events as referred user" on public.affiliate_events;
create policy "aff read events as referred user"
on public.affiliate_events
for select to authenticated
using (auth.uid() = user_id);

-- Public: allow click recording via function only
revoke all on public.affiliate_clicks    from anon;
revoke all on public.affiliate_links     from anon;
revoke all on public.affiliate_programs  from anon;
revoke all on public.affiliates          from anon;
revoke all on public.affiliate_events    from anon;

grant execute on function public.record_affiliate_click(text, text, text, text, jsonb, jsonb)
  to anon, authenticated;
grant execute on function public.get_affiliate_link(text)
  to authenticated;

-- =====================================================================
-- End
-- =====================================================================
