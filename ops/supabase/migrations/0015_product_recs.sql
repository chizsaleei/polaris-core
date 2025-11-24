-- =====================================================================
-- 0015_product_recs.sql
-- Product recommendations: items, rules, slots, and events
-- Supports affiliate links now and Shopify integration later
-- =====================================================================

-- Helper to keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Fallback stub for is_admin if not yet present
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
end $$;

-- Types
do $$
begin
  if not exists (select 1 from pg_type where typname = 'rec_surface') then
    create type public.rec_surface as enum (
      'home',
      'dashboard',
      'drill',
      'library',
      'pricing',
      'coach_catalog'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'rec_event_type') then
    create type public.rec_event_type as enum ('impression', 'click');
  end if;

  if not exists (select 1 from pg_type where typname = 'rec_source') then
    create type public.rec_source as enum ('external', 'shopify');
  end if;
end $$;

-- =====================================================================
-- Master catalog of recommended items
-- One row per product or resource that you might recommend
-- =====================================================================
create table if not exists public.product_rec_items (
  id                uuid primary key default gen_random_uuid(),
  source            public.rec_source not null default 'external',
  -- If source = 'shopify' this can link to cached products for joins
  shopify_product_id uuid references public.shopify_products_cache(id) on delete set null,
  -- For external items keep data inline
  title             text not null,
  subtitle          text,
  description       text,
  image_url         text,
  url               text,                   -- landing or detail page
  affiliate_url     text,                   -- tracked link if any
  partner           text,                   -- brand or affiliate partner
  tags              text[] not null default '{}',
  price_min         numeric(12,2),
  price_max         numeric(12,2),
  currency          text default 'USD',
  available         boolean not null default true,

  -- Targeting
  markets           text[] not null default '{GLOBAL}',  -- e.g. GLOBAL, PH, JP, KR
  tiers             text[] not null default '{FREE,PRO,VIP}',
  coach_keys        text[] not null default '{}',        -- slugs like 'carter-goleman'
  topics            text[] not null default '{}',        -- user skills or themes
  difficulties      text[] not null default '{}',        -- e.g. A1..C2 or easy..hard

  weight            integer not null default 10,         -- base selection weight
  is_active         boolean not null default true,
  starts_at         timestamptz,
  ends_at           timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id) on delete set null,
  updated_by        uuid references public.profiles(id) on delete set null,
  raw               jsonb not null default '{}'::jsonb   -- optional source payload
);

drop trigger if exists trg_touch_product_rec_items on public.product_rec_items;
create trigger trg_touch_product_rec_items
before update on public.product_rec_items
for each row execute function public.touch_updated_at();

create index if not exists pri_active_window_idx
  on public.product_rec_items (is_active, starts_at, ends_at);
create index if not exists pri_tags_gin
  on public.product_rec_items using gin (tags);
create index if not exists pri_markets_gin
  on public.product_rec_items using gin (markets);
create index if not exists pri_tiers_gin
  on public.product_rec_items using gin (tiers);
create index if not exists pri_coach_keys_gin
  on public.product_rec_items using gin (coach_keys);
create index if not exists pri_topics_gin
  on public.product_rec_items using gin (topics);
create index if not exists pri_difficulties_gin
  on public.product_rec_items using gin (difficulties);

-- =====================================================================
-- Rule sets to target items to surfaces and audiences
-- =====================================================================
create table if not exists public.product_rec_rules (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  surface           public.rec_surface not null,
  description       text,
  is_active         boolean not null default true,

  -- Audience filters
  markets           text[] not null default '{GLOBAL}',
  tiers             text[] not null default '{FREE,PRO,VIP}',
  coach_keys        text[] not null default '{}',
  topics            text[] not null default '{}',
  difficulties      text[] not null default '{}',

  -- Date window
  starts_at         timestamptz,
  ends_at           timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references public.profiles(id) on delete set null,
  updated_by        uuid references public.profiles(id) on delete set null,
  meta              jsonb not null default '{}'::jsonb
);

drop trigger if exists trg_touch_product_rec_rules on public.product_rec_rules;
create trigger trg_touch_product_rec_rules
before update on public.product_rec_rules
for each row execute function public.touch_updated_at();

create index if not exists prr_surface_idx on public.product_rec_rules (surface);
create index if not exists prr_active_window_idx on public.product_rec_rules (is_active, starts_at, ends_at);
create index if not exists prr_markets_gin on public.product_rec_rules using gin (markets);
create index if not exists prr_tiers_gin on public.product_rec_rules using gin (tiers);
create index if not exists prr_coach_keys_gin on public.product_rec_rules using gin (coach_keys);

-- =====================================================================
-- Slots bind rules to items with positions on a surface
-- =====================================================================
create table if not exists public.product_rec_slots (
  id                uuid primary key default gen_random_uuid(),
  surface           public.rec_surface not null,
  position          integer not null default 1,      -- 1 based
  rule_id           uuid references public.product_rec_rules(id) on delete cascade,
  item_id           uuid references public.product_rec_items(id) on delete cascade,
  weight            integer not null default 10,
  is_active         boolean not null default true,
  starts_at         timestamptz,
  ends_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists trg_touch_product_rec_slots on public.product_rec_slots;
create trigger trg_touch_product_rec_slots
before update on public.product_rec_slots
for each row execute function public.touch_updated_at();

create unique index if not exists prs_surface_pos_unique
  on public.product_rec_slots (surface, position)
  where is_active = true;

create index if not exists prs_item_idx on public.product_rec_slots (item_id);
create index if not exists prs_rule_idx on public.product_rec_slots (rule_id);
create index if not exists prs_active_window_idx on public.product_rec_slots (is_active, starts_at, ends_at);

-- =====================================================================
-- Events for analytics and optimization
-- =====================================================================
create table if not exists public.product_rec_events (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references public.profiles(id) on delete set null,
  session_id        uuid references public.sessions(id) on delete set null,
  event_type        public.rec_event_type not null,
  surface           public.rec_surface not null,
  item_id           uuid references public.product_rec_items(id) on delete cascade,
  rule_id           uuid references public.product_rec_rules(id) on delete set null,
  slot_id           uuid references public.product_rec_slots(id) on delete set null,
  country           text,
  tier              text,
  coach_key         text,
  topic             text,
  difficulty        text,
  created_at        timestamptz not null default now(),
  meta              jsonb not null default '{}'::jsonb
);

create index if not exists pre_user_time_idx on public.product_rec_events (user_id, created_at desc);
create index if not exists pre_item_time_idx on public.product_rec_events (item_id, created_at desc);
create index if not exists pre_surface_type_time_idx on public.product_rec_events (surface, event_type, created_at desc);

-- =====================================================================
-- Views
-- v_product_recs_public gives safe fields for client read
-- v_product_recs_for_user applies basic targeting
-- =====================================================================
create or replace view public.v_product_recs_public as
select
  i.id,
  i.title,
  i.subtitle,
  i.description,
  coalesce(i.affiliate_url, i.url) as url,
  i.image_url,
  i.partner,
  i.tags,
  i.price_min,
  i.price_max,
  i.currency,
  i.available,
  i.markets,
  i.tiers,
  i.coach_keys,
  i.topics,
  i.difficulties,
  i.weight,
  i.starts_at,
  i.ends_at,
  i.updated_at
from public.product_rec_items i
where i.is_active
  and i.available
  and (i.starts_at is null or i.starts_at <= now())
  and (i.ends_at   is null or i.ends_at   >= now());

create or replace view public.v_product_recs_for_user as
select distinct on (s.surface, s.position)
  s.surface,
  s.position,
  i.id as item_id,
  i.title,
  i.subtitle,
  i.description,
  coalesce(i.affiliate_url, i.url) as url,
  i.image_url,
  i.partner,
  i.tags,
  i.price_min,
  i.price_max,
  i.currency,
  i.updated_at,
  s.rule_id,
  s.id as slot_id
from public.product_rec_slots s
join public.product_rec_items i on i.id = s.item_id
left join public.product_rec_rules r on r.id = s.rule_id
where s.is_active
  and (s.starts_at is null or s.starts_at <= now())
  and (s.ends_at   is null or s.ends_at   >= now())
  and i.is_active and i.available
  and (i.starts_at is null or i.starts_at <= now())
  and (i.ends_at   is null or i.ends_at   >= now());

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.product_rec_items enable row level security;
alter table public.product_rec_rules enable row level security;
alter table public.product_rec_slots enable row level security;
alter table public.product_rec_events enable row level security;

-- Admin full control
create policy if not exists "product_rec_items admin all"
on public.product_rec_items
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy if not exists "product_rec_rules admin all"
on public.product_rec_rules
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy if not exists "product_rec_slots admin all"
on public.product_rec_slots
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Read access
create policy if not exists "product_rec_items read published"
on public.product_rec_items
for select to anon, authenticated
using (
  is_active
  and available
  and (starts_at is null or starts_at <= now())
  and (ends_at   is null or ends_at   >= now())
);

create policy if not exists "product_rec_rules read"
on public.product_rec_rules
for select to authenticated
using (is_active);

create policy if not exists "product_rec_slots read"
on public.product_rec_slots
for select to anon, authenticated
using (
  is_active
  and (starts_at is null or starts_at <= now())
  and (ends_at   is null or ends_at   >= now())
);

-- Event writes from clients
create policy if not exists "product_rec_events insert public"
on public.product_rec_events
for insert to anon, authenticated
with check (true);

create policy if not exists "product_rec_events read own or admin"
on public.product_rec_events
for select to authenticated
using (public.is_admin() or user_id = auth.uid());

-- =====================================================================
-- Helpful function to record events from SQL
-- =====================================================================
create or replace function public.record_product_rec_event(
  p_event_type public.rec_event_type,
  p_surface    public.rec_surface,
  p_item_id    uuid,
  p_rule_id    uuid default null,
  p_slot_id    uuid default null,
  p_country    text default null,
  p_tier       text default null,
  p_coach_key  text default null,
  p_topic      text default null,
  p_difficulty text default null,
  p_meta       jsonb default '{}'::jsonb
) returns void
language sql
security definer
as $$
  insert into public.product_rec_events
    (user_id, session_id, event_type, surface, item_id, rule_id, slot_id,
     country, tier, coach_key, topic, difficulty, meta)
  values
    (auth.uid(), null, p_event_type, p_surface, p_item_id, p_rule_id, p_slot_id,
     p_country, p_tier, p_coach_key, p_topic, p_difficulty, p_meta);
$$;

revoke all on function public.record_product_rec_event(public.rec_event_type, public.rec_surface, uuid, uuid, uuid, text, text, text, text, text, jsonb) from public;
grant execute on function public.record_product_rec_event(public.rec_event_type, public.rec_surface, uuid, uuid, uuid, text, text, text, text, text, jsonb) to anon, authenticated;

-- =====================================================================
-- Notes
-- 1) Admin seeds items and rules then assigns slots for each surface
-- 2) Client fetch uses v_product_recs_public or v_product_recs_for_user
-- 3) Events table powers CTR and demotion of weak items
-- =====================================================================
