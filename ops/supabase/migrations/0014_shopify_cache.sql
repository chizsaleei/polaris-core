-- =====================================================================
-- 0014_shopify_cache.sql
-- Cache Shopify products and collections for fast reads and safe querying
-- Works with existing recommendation features and public marketing pages
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

-- ======================================================
-- Collections cache
-- ======================================================
create table if not exists public.shopify_collections_cache (
  id               uuid primary key default gen_random_uuid(),
  shopify_id       text not null unique,                   -- Shopify GID
  handle           text not null,
  title            text not null,
  description_html text,
  image_url        text,
  country_scope    text default 'GLOBAL',                  -- optional scoping
  is_published     boolean not null default true,
  raw              jsonb not null default '{}'::jsonb,     -- full API payload
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists trg_touch_shopify_collections_cache on public.shopify_collections_cache;
create trigger trg_touch_shopify_collections_cache
before update on public.shopify_collections_cache
for each row execute function public.touch_updated_at();

create index if not exists scc_handle_idx on public.shopify_collections_cache (handle);
create index if not exists scc_published_idx on public.shopify_collections_cache (is_published);

-- ======================================================
-- Products cache
-- ======================================================
create table if not exists public.shopify_products_cache (
  id                 uuid primary key default gen_random_uuid(),
  shopify_id         text not null unique,              -- Shopify GID
  handle             text not null,
  title              text not null,
  vendor             text,
  product_type       text,
  tags               text[] not null default '{}',
  price_min          numeric(12,2),
  price_max          numeric(12,2),
  currency           text default 'USD',
  available          boolean not null default true,
  is_published       boolean not null default true,
  market             text default 'GLOBAL',             -- optional regional label
  image_url          text,
  url                text,                              -- storefront URL
  raw                 jsonb not null default '{}'::jsonb,  -- full API payload
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists trg_touch_shopify_products_cache on public.shopify_products_cache;
create trigger trg_touch_shopify_products_cache
before update on public.shopify_products_cache
for each row execute function public.touch_updated_at();

create index if not exists spc_handle_idx on public.shopify_products_cache (handle);
create index if not exists spc_vendor_idx on public.shopify_products_cache (vendor);
create index if not exists spc_type_idx on public.shopify_products_cache (product_type);
create index if not exists spc_tags_gin on public.shopify_products_cache using gin (tags);
create index if not exists spc_pub_avail_idx on public.shopify_products_cache (is_published, available);

-- ======================================================
-- Relation: products in collections
-- ======================================================
create table if not exists public.shopify_product_collections (
  product_id     uuid not null references public.shopify_products_cache(id) on delete cascade,
  collection_id  uuid not null references public.shopify_collections_cache(id) on delete cascade,
  position       integer,
  primary key (product_id, collection_id)
);

-- ======================================================
-- Sync bookkeeping
-- ======================================================
create table if not exists public.shopify_sync_state (
  id                uuid primary key default gen_random_uuid(),
  source            text not null default 'shopify',
  last_full_sync_at timestamptz,
  last_delta_sync_at timestamptz,
  last_webhook_at   timestamptz,
  cursor            text,                         -- GraphQL pagination cursor if used
  stats             jsonb not null default '{}'::jsonb,
  updated_at        timestamptz not null default now(),
  created_at        timestamptz not null default now()
);

drop trigger if exists trg_touch_shopify_sync_state on public.shopify_sync_state;
create trigger trg_touch_shopify_sync_state
before update on public.shopify_sync_state
for each row execute function public.touch_updated_at();

-- ======================================================
-- Views for public reads
-- Only whitelisted fields leave the DB for client use
-- ======================================================
create or replace view public.v_shopify_products_public as
select
  p.id,
  p.handle,
  p.title,
  p.vendor,
  p.product_type,
  p.tags,
  p.price_min,
  p.price_max,
  p.currency,
  p.available,
  p.image_url,
  p.url,
  p.market,
  p.updated_at
from public.shopify_products_cache p
where p.is_published and p.available;

create or replace view public.v_shopify_collections_public as
select
  c.id,
  c.handle,
  c.title,
  c.description_html,
  c.image_url,
  c.country_scope,
  c.updated_at
from public.shopify_collections_cache c
where c.is_published;

-- ======================================================
-- RLS
-- ======================================================
alter table public.shopify_collections_cache enable row level security;
alter table public.shopify_products_cache enable row level security;
alter table public.shopify_product_collections enable row level security;
alter table public.shopify_sync_state enable row level security;

-- Admin full control
create policy if not exists "shopify_collections admin all"
on public.shopify_collections_cache
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy if not exists "shopify_products admin all"
on public.shopify_products_cache
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy if not exists "shopify_link admin all"
on public.shopify_product_collections
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy if not exists "shopify_sync admin all"
on public.shopify_sync_state
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Public and user reads for published items only
create policy if not exists "shopify_products public read"
on public.shopify_products_cache
for select to anon, authenticated
using (is_published and available);

create policy if not exists "shopify_collections public read"
on public.shopify_collections_cache
for select to anon, authenticated
using (is_published);

-- Link table read only through published rows
create policy if not exists "shopify_link public read"
on public.shopify_product_collections
for select to anon, authenticated
using (
  exists (
    select 1
    from public.shopify_products_cache p
    where p.id = product_id and p.is_published and p.available
  ) and
  exists (
    select 1
    from public.shopify_collections_cache c
    where c.id = collection_id and c.is_published
  )
);

-- ======================================================
-- Helpful indexes for storefront browsing
-- ======================================================
create index if not exists spc_title_trgm on public.shopify_products_cache
using gin (title gin_trgm_ops);

create index if not exists scc_title_trgm on public.shopify_collections_cache
using gin (title gin_trgm_ops);

-- Notes
-- 1) Server sync job writes to cache tables as admin service role
-- 2) Clients read from views or direct tables under RLS
-- 3) Recommendation layer can join v_shopify_products_public to your product_recommendations logic
-- =====================================================================
