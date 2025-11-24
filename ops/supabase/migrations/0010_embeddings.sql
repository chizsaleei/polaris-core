-- =====================================================================
-- 0010_embeddings.sql
-- Semantic search with pgvector for catalog and user content
-- Aligned with operating model:
--   - Catalog (Published) is publicly discoverable (read-only)
--   - User artifacts are private to the owner
--   - Admin can do everything
-- Prereqs:
--   - 0001..0009 applied (tables, RLS, public.is_admin())
--   - pgcrypto already enabled earlier for gen_random_uuid()
-- =====================================================================

-- 1) Enable pgvector extension (idempotent)
create extension if not exists vector;

-- Use 1536 dims to match common embedding models (for example text-embedding-3-small)
-- Adjust if you standardize on a different dimension.

-- =====================================================================
-- 2) Catalog embeddings (for Published drills / sets / items)
-- =====================================================================

create table if not exists public.search_catalog_embeddings (
  id               uuid primary key default gen_random_uuid(),
  entity_type      text not null check (entity_type in ('drill','drill_item','drill_set')),
  entity_id        uuid not null,
  title            text not null,
  tags             text[] not null default '{}',
  coach_ids        text[] not null default '{}',   -- target coaches for routing/filtering
  language         text,                           -- for example 'en'
  difficulty       text,                           -- for example 'A1'..'C2', 'Beginner'..'Advanced'
  state            text not null default 'Published',
  content          text not null,                  -- searchable text: prompt, rubric highlights, etc.
  embedding        vector(1536) not null,
  embedding_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (entity_type, entity_id)
);

alter table if exists public.search_catalog_embeddings
  enable row level security;

-- RLS policies for catalog embeddings
do $$
begin
  if to_regclass('public.search_catalog_embeddings') is not null then
    -- Admin full access
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename  = 'search_catalog_embeddings'
        and policyname = 'admin all'
    ) then
      create policy "admin all"
      on public.search_catalog_embeddings
      for all
      to authenticated
      using (public.is_admin())
      with check (public.is_admin());
    end if;

    -- Public read for Published items (catalog discovery)
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename  = 'search_catalog_embeddings'
        and policyname = 'catalog read published embeddings'
    ) then
      create policy "catalog read published embeddings"
      on public.search_catalog_embeddings
      for select
      to anon, authenticated
      using (state = 'Published');
    end if;
  end if;
end $$;

-- Indexes
create index if not exists search_catalog_embeddings_entity_idx
  on public.search_catalog_embeddings (entity_type, entity_id);

-- Vector index for cosine distance
create index if not exists search_catalog_embeddings_vec_idx
  on public.search_catalog_embeddings
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- =====================================================================
-- 3) User embeddings (private user library: transcripts, key_expressions, vocabulary)
-- =====================================================================

create table if not exists public.search_user_embeddings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  source_type      text not null check (source_type in ('transcript','key_expression','vocabulary','goal','assignment')),
  source_id        uuid,                           -- nullable if line-level only
  coach_id         text,                           -- helps filter by coach context
  language         text,
  difficulty       text,
  content          text not null,                  -- normalized text for search
  embedding        vector(1536) not null,
  embedding_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, source_type, source_id)
);

alter table if exists public.search_user_embeddings
  enable row level security;

-- RLS policies for user embeddings
do $$
begin
  if to_regclass('public.search_user_embeddings') is not null then
    -- Admin full access
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename  = 'search_user_embeddings'
        and policyname = 'admin all'
    ) then
      create policy "admin all"
      on public.search_user_embeddings
      for all
      to authenticated
      using (public.is_admin())
      with check (public.is_admin());
    end if;

    -- Owner read
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename  = 'search_user_embeddings'
        and policyname = 'owner read'
    ) then
      create policy "owner read"
      on public.search_user_embeddings
      for select
      to authenticated
      using (user_id = auth.uid());
    end if;

    -- Owner insert
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename  = 'search_user_embeddings'
        and policyname = 'owner write'
    ) then
      create policy "owner write"
      on public.search_user_embeddings
      for insert
      to authenticated
      with check (user_id = auth.uid());
    end if;

    -- Owner update
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename  = 'search_user_embeddings'
        and policyname = 'owner update'
    ) then
      create policy "owner update"
      on public.search_user_embeddings
      for update
      to authenticated
      using (user_id = auth.uid())
      with check (user_id = auth.uid());
    end if;
  end if;
end $$;

create index if not exists search_user_embeddings_user_idx
  on public.search_user_embeddings (user_id, source_type);

create index if not exists search_user_embeddings_vec_idx
  on public.search_user_embeddings
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- =====================================================================
-- 4) Helper trigger to keep updated_at fresh
-- =====================================================================

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

drop trigger if exists trg_touch_catalog_embeddings on public.search_catalog_embeddings;
create trigger trg_touch_catalog_embeddings
before update on public.search_catalog_embeddings
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_user_embeddings on public.search_user_embeddings;
create trigger trg_touch_user_embeddings
before update on public.search_user_embeddings
for each row execute function public.touch_updated_at();

-- =====================================================================
-- 5) Semantic search utility functions
-- Notes:
--   - We expose SQL STABLE functions that respect RLS.
--   - The <=> operator is cosine distance; lower is more similar.
-- =====================================================================

-- Catalog search (optionally filter by coach_id, tags, difficulty)
create or replace function public.search_catalog(
  query_embedding vector(1536),
  match_limit int default 10,
  coach_filter text default null,
  tag_filter text[] default null,
  difficulty_filter text default null
)
returns table(
  entity_type text,
  entity_id uuid,
  title text,
  tags text[],
  coach_ids text[],
  difficulty text,
  distance float4
)
language sql
stable
as $$
  select
    sce.entity_type,
    sce.entity_id,
    sce.title,
    sce.tags,
    sce.coach_ids,
    sce.difficulty,
    (sce.embedding <=> query_embedding)::float4 as distance
  from public.search_catalog_embeddings sce
  where sce.state = 'Published'
    and (coach_filter is null or coach_filter = any (sce.coach_ids))
    and (tag_filter   is null or sce.tags && tag_filter)
    and (difficulty_filter is null or sce.difficulty = difficulty_filter)
  order by sce.embedding <=> query_embedding
  limit greatest(match_limit, 1)
$$;

-- Owner scoped user search (optionally filter by coach_id or source_type)
create or replace function public.search_user_library(
  query_embedding vector(1536),
  match_limit int default 10,
  coach_filter text default null,
  source_type_filter text default null
)
returns table(
  source_type text,
  source_id uuid,
  coach_id text,
  content text,
  distance float4
)
language sql
stable
security definer
set search_path = public
as $$
  -- RLS still applies to the underlying table; we use auth.uid()
  select
    sue.source_type,
    sue.source_id,
    sue.coach_id,
    sue.content,
    (sue.embedding <=> query_embedding)::float4 as distance
  from public.search_user_embeddings sue
  where sue.user_id = auth.uid()
    and (coach_filter is null or sue.coach_id = coach_filter)
    and (source_type_filter is null or sue.source_type = source_type_filter)
  order by sue.embedding <=> query_embedding
  limit greatest(match_limit, 1)
$$;

-- Grants for function execution (RLS controls row visibility)
grant execute on function public.search_catalog(vector, int, text, text[], text)
  to anon, authenticated;
grant execute on function public.search_user_library(vector, int, text, text)
  to authenticated;

-- =====================================================================
-- 6) Defensive: revoke PUBLIC table grants (policies decide access)
-- =====================================================================

do $$
declare
  r record;
begin
  for r in
    select quote_ident(schemaname) as s, quote_ident(tablename) as t
    from pg_tables
    where schemaname = 'public'
      and tablename in ('search_catalog_embeddings','search_user_embeddings')
  loop
    execute format('revoke all on table %s.%s from public;', r.s, r.t);
  end loop;
end $$;

-- =====================================================================
-- Notes for the application layer (non executable, for reference):
-- - Generate embeddings in app/core when:
--     * A drill/drill_item/drill_set transitions to Published -> upsert into search_catalog_embeddings
--     * A user finishes a session or saves expressions/vocab -> upsert into search_user_embeddings
-- - Keep entity and user records in sync on edits; refresh embedding if content changed.
-- - Use the SQL functions above for fast semantic search that honors RLS.
-- =====================================================================
