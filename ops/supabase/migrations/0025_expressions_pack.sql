-- ===============================================================
-- 0025_expressions_pack.sql
-- Per-session Expressions Pack captured from user utterances,
-- private by default, with optional admin curation to exemplars.
-- States: private_user -> candidate_exemplar -> published_exemplar -> deprecated
-- Assumes: profiles, sessions; defines helpers idempotently if missing.
-- Date: 2025-11-14
-- ===============================================================

-- ---------- Helpers: enums and utility functions (idempotent) ----------
do $$
begin
  -- expression_state enum
  if not exists (select 1 from pg_type where typname = 'expression_state') then
    create type public.expression_state as enum (
      'private_user',
      'candidate_exemplar',
      'published_exemplar',
      'deprecated'
    );
  end if;

  -- touch_updated_at
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
    end;
    $fn$;
  end if;

  -- is_admin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin'
      and n.nspname = 'public'
  ) then
    create or replace function public.is_admin() returns boolean
    language sql stable
    as $fn$
      select false
    $fn$;
  end if;
end $$;

-- ===============================================================
-- Packs
-- ===============================================================
create table if not exists public.expression_packs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  session_id         uuid references public.sessions(id) on delete set null,
  coach_key          text,                                -- which coach this pack came from
  lang               text default 'en',
  skill              text,                                -- speaking, pronunciation, vocabulary
  topic              text,                                -- optional tag like IELTS Part 2, ICU consent
  difficulty         text,                                -- easy, medium, hard or band 5..8, etc
  state              public.expression_state not null default 'private_user',
  ai_generated       boolean not null default true,       -- pack content harvested by AI
  risk_flags         jsonb not null default '[]'::jsonb,  -- duplication, tone, safety, level
  risk_level         int default 0,                       -- 0 ok, 1 low, 2 medium, 3 high
  notes              text,                                -- free text admin or system notes
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_expression_packs_user
  on public.expression_packs(user_id, created_at desc);
create index if not exists idx_expression_packs_state
  on public.expression_packs(state, coach_key);
create index if not exists idx_expression_packs_session
  on public.expression_packs(session_id);

drop trigger if exists trg_touch_expression_packs on public.expression_packs;
create trigger trg_touch_expression_packs
before update on public.expression_packs
for each row execute function public.touch_updated_at();

alter table public.expression_packs enable row level security;

revoke all on public.expression_packs from anon, authenticated;

drop policy if exists "packs read own" on public.expression_packs;
create policy "packs read own"
  on public.expression_packs
  for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "packs insert self" on public.expression_packs;
create policy "packs insert self"
  on public.expression_packs
  for insert
  to authenticated
  with check (auth.uid() = user_id or public.is_admin());

drop policy if exists "packs update own or admin" on public.expression_packs;
create policy "packs update own or admin"
  on public.expression_packs
  for update
  to authenticated
  using (
    public.is_admin()
    or (auth.uid() = user_id and state = 'private_user')
  )
  with check (true);

drop policy if exists "packs delete own private or admin" on public.expression_packs;
create policy "packs delete own private or admin"
  on public.expression_packs
  for delete
  to authenticated
  using (
    public.is_admin()
    or (auth.uid() = user_id and state = 'private_user')
  );

-- ===============================================================
-- Items within a pack
-- ===============================================================
create table if not exists public.expression_items (
  id                 uuid primary key default gen_random_uuid(),
  pack_id            uuid not null references public.expression_packs(id) on delete cascade,
  user_id            uuid not null references public.profiles(id) on delete cascade, -- denormalized for RLS
  item_index         int not null,                          -- 0-based order within pack
  source_text        text,                                  -- original user line
  upgraded_text      text,                                  -- corrected or improved version
  collocations       text[],                                -- key collocations
  pronunciation_note text,                                  -- brief hint
  example_prompt     text,                                  -- re-say prompt
  tags               text[] default '{}'::text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index if not exists uq_expression_items_pack_idx
  on public.expression_items(pack_id, item_index);

create index if not exists idx_expression_items_user
  on public.expression_items(user_id, created_at desc);

drop trigger if exists trg_touch_expression_items on public.expression_items;
create trigger trg_touch_expression_items
before update on public.expression_items
for each row execute function public.touch_updated_at();

alter table public.expression_items enable row level security;

revoke all on public.expression_items from anon, authenticated;

drop policy if exists "items read own" on public.expression_items;
create policy "items read own"
  on public.expression_items
  for select
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "items insert own" on public.expression_items;
create policy "items insert own"
  on public.expression_items
  for insert
  to authenticated
  with check (auth.uid() = user_id or public.is_admin());

drop policy if exists "items update own or admin" on public.expression_items;
create policy "items update own or admin"
  on public.expression_items
  for update
  to authenticated
  using (auth.uid() = user_id or public.is_admin())
  with check (true);

drop policy if exists "items delete own or admin" on public.expression_items;
create policy "items delete own or admin"
  on public.expression_items
  for delete
  to authenticated
  using (auth.uid() = user_id or public.is_admin());

-- ===============================================================
-- Favorites for spaced review
-- ===============================================================
create table if not exists public.expression_favorites (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  item_id        uuid not null references public.expression_items(id) on delete cascade,
  favored_at     timestamptz not null default now(),
  primary key (user_id, item_id)
);

alter table public.expression_favorites enable row level security;
revoke all on public.expression_favorites from anon, authenticated;

drop policy if exists "favorites read own" on public.expression_favorites;
create policy "favorites read own"
  on public.expression_favorites
  for select to authenticated
  using (auth.uid() = user_id or public.is_admin());

drop policy if exists "favorites upsert own" on public.expression_favorites;
create policy "favorites upsert own"
  on public.expression_favorites
  for insert to authenticated
  with check (auth.uid() = user_id or public.is_admin());

drop policy if exists "favorites delete own" on public.expression_favorites;
create policy "favorites delete own"
  on public.expression_favorites
  for delete to authenticated
  using (auth.uid() = user_id or public.is_admin());

-- ===============================================================
-- Reports to flag risky items
-- ===============================================================
create table if not exists public.expression_reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid not null references public.profiles(id) on delete cascade,
  item_id       uuid not null references public.expression_items(id) on delete cascade,
  reason        text not null,                 -- wrong, unsafe, offensive, duplicate, other
  details       text,
  created_at    timestamptz not null default now()
);

create index if not exists idx_expression_reports_item
  on public.expression_reports(item_id);
create index if not exists idx_expression_reports_reporter
  on public.expression_reports(reporter_id, created_at desc);

alter table public.expression_reports enable row level security;
revoke all on public.expression_reports from anon, authenticated;

drop policy if exists "reports read own or admin" on public.expression_reports;
create policy "reports read own or admin"
  on public.expression_reports
  for select to authenticated
  using (auth.uid() = reporter_id or public.is_admin());

drop policy if exists "reports insert own" on public.expression_reports;
create policy "reports insert own"
  on public.expression_reports
  for insert to authenticated
  with check (auth.uid() = reporter_id or public.is_admin());

-- ===============================================================
-- Exemplar catalog for coaches
-- ===============================================================
create table if not exists public.expression_exemplars (
  id                 uuid primary key default gen_random_uuid(),
  source_item_id     uuid references public.expression_items(id) on delete set null,
  coach_key          text not null,
  lang               text default 'en',
  skill              text,
  topic              text,
  difficulty         text,
  upgraded_text      text not null,
  example_prompt     text,
  tags               text[] default '{}'::text[],
  state              public.expression_state not null default 'candidate_exemplar',
  created_by         uuid references public.profiles(id) on delete set null, -- admin who promoted
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_expression_exemplars_state_coach
  on public.expression_exemplars(state, coach_key);

drop trigger if exists trg_touch_expression_exemplars on public.expression_exemplars;
create trigger trg_touch_expression_exemplars
before update on public.expression_exemplars
for each row execute function public.touch_updated_at();

alter table public.expression_exemplars enable row level security;
revoke all on public.expression_exemplars from anon, authenticated;

-- Public can read only published exemplars
drop policy if exists "exemplars read published" on public.expression_exemplars;
create policy "exemplars read published"
  on public.expression_exemplars
  for select to anon, authenticated
  using (state = 'published_exemplar');

-- Admin can manage exemplars
drop policy if exists "exemplars admin write" on public.expression_exemplars;
create policy "exemplars admin write"
  on public.expression_exemplars
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ===============================================================
-- Admin RPC to promote items to exemplars
-- ===============================================================
create or replace function public.admin_promote_expressions(
  p_target_coach text,
  p_item_ids uuid[],
  p_skill text default null,
  p_topic text default null,
  p_difficulty text default null,
  p_state public.expression_state default 'candidate_exemplar'
) returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_admin boolean := public.is_admin();
  v_cnt   int := 0;
begin
  if not v_admin then
    raise exception 'Only admin can promote expressions';
  end if;

  insert into public.expression_exemplars (
    source_item_id,
    coach_key,
    lang,
    skill,
    topic,
    difficulty,
    upgraded_text,
    example_prompt,
    tags,
    state,
    created_by
  )
  select
    i.id,
    p_target_coach,
    'en',
    coalesce(p_skill, ep.skill),
    coalesce(p_topic, ep.topic),
    coalesce(p_difficulty, ep.difficulty),
    i.upgraded_text,
    i.example_prompt,
    i.tags,
    coalesce(p_state, 'candidate_exemplar'),
    auth.uid()
  from public.expression_items i
  join public.expression_packs ep on ep.id = i.pack_id
  where i.id = any(p_item_ids);

  get diagnostics v_cnt = row_count;
  return v_cnt;
end;
$fn$;

revoke all on function public.admin_promote_expressions(
  text, uuid[], text, text, text, public.expression_state
) from public;
grant execute on function public.admin_promote_expressions(
  text, uuid[], text, text, text, public.expression_state
) to authenticated;

-- ===============================================================
-- Views for convenience
-- ===============================================================
create or replace view public.v_expressions_library as
select
  ep.id as pack_id,
  ep.user_id,
  ep.session_id,
  ep.coach_key,
  ep.lang,
  ep.skill,
  ep.topic,
  ep.difficulty,
  ep.state,
  ep.created_at,
  ep.updated_at,
  count(ei.id) as items_count
from public.expression_packs ep
left join public.expression_items ei on ei.pack_id = ep.id
group by ep.id;

create or replace view public.v_exemplars_catalog as
select
  ee.id,
  ee.coach_key,
  ee.lang,
  ee.skill,
  ee.topic,
  ee.difficulty,
  ee.upgraded_text,
  ee.example_prompt,
  ee.tags,
  ee.created_at
from public.expression_exemplars ee
where ee.state = 'published_exemplar';

-- Note:
-- - v_expressions_library inherits RLS from expression_packs/items.
-- - v_exemplars_catalog exposes only published_exemplar items to all.

-- ===============================================================
-- Minimal GIN indexes for tags search
-- ===============================================================
create index if not exists gin_expression_items_tags
  on public.expression_items using gin (tags);
create index if not exists gin_expression_exemplars_tags
  on public.expression_exemplars using gin (tags);

-- Done
