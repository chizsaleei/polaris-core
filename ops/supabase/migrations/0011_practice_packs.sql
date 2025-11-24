-- ===================================================================== 
-- 0011_practice_packs.sql
-- User "Expressions / Practice Packs" generated at session end
-- States: Private-User → Candidate-Exemplar → Published-Exemplar → Deprecated
-- Rules:
--   - Owner can read/write their own packs and items
--   - Admin can do everything
--   - Published-Exemplar may be world-readable (catalog), assuming PII stripped
--   - Only Admin can move to Published-Exemplar or Deprecated
-- Prereqs: 0001..0010 (profiles, sessions, RLS baseline, is_admin())
-- =====================================================================

-- Packs (one per session end, but may be created without a session too)
create table if not exists public.practice_packs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  session_id       uuid references public.sessions(id) on delete set null,
  coach_id         text,                       -- coach context (for example 'claire-swales')
  title            text not null default 'Expressions Pack',
  summary          text,                       -- short human summary shown in Session Summary
  language         text,                       -- for example 'en'
  difficulty       text,                       -- A1..C2 or Beginner..Advanced
  topics           text[] not null default '{}',
  state            text not null default 'Private-User'
                    check (state in ('Private-User','Candidate-Exemplar','Published-Exemplar','Deprecated')),
  ai_scores        jsonb not null default '{}'::jsonb,   -- for example {"clarity":0.72,"wpm":132}
  flags            jsonb not null default '{}'::jsonb,   -- auto QA flags
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.practice_packs is
  'User-owned pack of upgraded expressions produced at session end.';

-- Items inside a pack (individual upgraded lines, collocations, notes, prompts)
create table if not exists public.practice_pack_items (
  id               uuid primary key default gen_random_uuid(),
  pack_id          uuid not null references public.practice_packs(id) on delete cascade,
  -- kind categorizes the item for UI grouping
  kind             text not null check (kind in ('corrected','upgrade','collocation','pronunciation','resay_prompt','note')),
  original_text    text,                        -- user utterance or baseline
  revised_text     text,                        -- upgraded phrasing to practice
  notes            text,                        -- teaching note / why upgrade
  phonetics        text,                        -- optional phonetic hints
  audio_url        text,                        -- signed URL to TTS pronunciation (Supabase storage), optional
  tags             text[] not null default '{}',
  risk_flags       text[] not null default '{}', -- duplication/safety/level risks at item level
  order_index      int not null default 0,       -- stable display order
  is_hidden        boolean not null default false, -- auto-hidden if risky, still visible to owner in private
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.practice_pack_items is
  'Line-level entries within a user practice pack.';

-- ------------------------------------------------------------
-- Timestamps upkeep
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_touch_practice_packs on public.practice_packs;
create trigger trg_touch_practice_packs
before update on public.practice_packs
for each row execute function public.touch_updated_at();

drop trigger if exists trg_touch_practice_pack_items on public.practice_pack_items;
create trigger trg_touch_practice_pack_items
before update on public.practice_pack_items
for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- Admin-only state transitions to Published-Exemplar / Deprecated
-- ------------------------------------------------------------
create or replace function public.enforce_pack_state_transitions()
returns trigger
language plpgsql
as $$
begin
  -- Only Admins can set Published-Exemplar or Deprecated
  if (new.state in ('Published-Exemplar','Deprecated')) and not public.is_admin() then
    raise exception 'Only Admin can publish or deprecate practice packs';
  end if;

  -- Owner may freely move between Private-User and Candidate-Exemplar
  -- Admin may move to any state (covered above)
  return new;
end $$;

drop trigger if exists trg_pack_state_guard on public.practice_packs;
create trigger trg_pack_state_guard
before update on public.practice_packs
for each row execute function public.enforce_pack_state_transitions();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table if exists public.practice_packs enable row level security;
alter table if exists public.practice_pack_items enable row level security;

-- Admin and owner policies (idempotent)
do $$
begin
  -- practice_packs: admin all
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_packs'
      and policyname = 'practice_packs admin all'
  ) then
    create policy "practice_packs admin all"
    on public.practice_packs
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  -- practice_packs: owner read
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_packs'
      and policyname = 'practice_packs owner read'
  ) then
    create policy "practice_packs owner read"
    on public.practice_packs
    for select
    to authenticated
    using (user_id = auth.uid());
  end if;

  -- practice_packs: owner insert
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_packs'
      and policyname = 'practice_packs owner write'
  ) then
    create policy "practice_packs owner write"
    on public.practice_packs
    for insert
    to authenticated
    with check (user_id = auth.uid());
  end if;

  -- practice_packs: owner update
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_packs'
      and policyname = 'practice_packs owner update'
  ) then
    create policy "practice_packs owner update"
    on public.practice_packs
    for update
    to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());
  end if;

  -- practice_pack_items: admin all
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_pack_items'
      and policyname = 'practice_pack_items admin all'
  ) then
    create policy "practice_pack_items admin all"
    on public.practice_pack_items
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  -- practice_pack_items: owner read
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_pack_items'
      and policyname = 'pack_items owner read'
  ) then
    create policy "pack_items owner read"
    on public.practice_pack_items
    for select
    to authenticated
    using (exists (
      select 1 from public.practice_packs p
      where p.id = practice_pack_items.pack_id
        and p.user_id = auth.uid()
    ));
  end if;

  -- practice_pack_items: owner insert
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_pack_items'
      and policyname = 'pack_items owner write'
  ) then
    create policy "pack_items owner write"
    on public.practice_pack_items
    for insert
    to authenticated
    with check (exists (
      select 1 from public.practice_packs p
      where p.id = practice_pack_items.pack_id
        and p.user_id = auth.uid()
    ));
  end if;

  -- practice_pack_items: owner update
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_pack_items'
      and policyname = 'pack_items owner update'
  ) then
    create policy "pack_items owner update"
    on public.practice_pack_items
    for update
    to authenticated
    using (exists (
      select 1 from public.practice_packs p
      where p.id = practice_pack_items.pack_id
        and p.user_id = auth.uid()
    ))
    with check (exists (
      select 1 from public.practice_packs p
      where p.id = practice_pack_items.pack_id
        and p.user_id = auth.uid()
    ));
  end if;

  -- Optional public read for sanitized exemplars in coach catalogs
  -- practice_packs: Published-Exemplar
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_packs'
      and policyname = 'practice_packs public exemplars'
  ) then
    create policy "practice_packs public exemplars"
    on public.practice_packs
    for select
    to anon, authenticated
    using (state = 'Published-Exemplar');
  end if;

  -- practice_pack_items: Published-Exemplar parent
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'practice_pack_items'
      and policyname = 'pack_items public exemplars'
  ) then
    create policy "pack_items public exemplars"
    on public.practice_pack_items
    for select
    to anon, authenticated
    using (exists (
      select 1 from public.practice_packs p
      where p.id = practice_pack_items.pack_id
        and p.state = 'Published-Exemplar'
    ));
  end if;
end $$;

-- ------------------------------------------------------------
-- Indexes
-- ------------------------------------------------------------
create index if not exists practice_packs_user_idx
  on public.practice_packs (user_id, created_at desc);

create index if not exists practice_packs_session_idx
  on public.practice_packs (session_id);

create index if not exists practice_packs_state_coach_idx
  on public.practice_packs (state, coach_id);

create index if not exists practice_pack_items_pack_order_idx
  on public.practice_pack_items (pack_id, order_index);

-- ------------------------------------------------------------
-- Defensive revoke (RLS governs access)
-- ------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select quote_ident(schemaname) s, quote_ident(tablename) t
    from pg_tables
    where schemaname = 'public'
      and tablename in ('practice_packs','practice_pack_items')
  loop
    execute format('revoke all on table %s.%s from public;', r.s, r.t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- Notes for application layer (not executed):
-- - When a session finishes:
--     * create practice_packs row (state = 'Private-User', topics, ai_scores, flags)
--     * bulk insert practice_pack_items with stable order_index
-- - If quality is high, server may set state to 'Candidate-Exemplar'
-- - Only Admin can set 'Published-Exemplar' or 'Deprecated'
-- - For embeddings (0010), app may upsert items into search_user_embeddings
--   to power private semantic search of the user's Library.
-- - For exemplars, Admin can choose a subset to also create catalog entries.
-- =====================================================================
