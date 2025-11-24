-- ===================================================================== 
-- 0012_editorial_workflow.sql
-- Editorial pipeline for AI generated learning items with Admin review
-- States: Draft → Auto QA → In Review → Approved → Published → Deprecated
-- Roles:
--   - Admin: full control
--   - AI: can create Draft, move to Auto QA, attach flags and diffs
--   - Others: no access
-- Links:
--   - Items can target zero or more coaches
--   - On publish, your server can sync to coach catalogs or drills tables
-- =====================================================================

-- Helpful: standard touch function (idempotent, defined earlier too)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Optional role helper for AI automation
create or replace function public.is_ai()
returns boolean
language sql
stable
as $$
  -- Expect a custom JWT claim "role" = 'ai'
  select coalesce((auth.jwt() ->> 'role') = 'ai', false);
$$;

-- =====================================================================
-- Main editorial items table
-- =====================================================================

create table if not exists public.editorial_items (
  id                uuid primary key default gen_random_uuid(),
  kind              text not null
                      check (kind in ('drill','scenario','qbank','rubric','copy','tagset')),
  title             text not null,
  slug              text unique,
  summary           text,
  body              jsonb not null default '{}'::jsonb,     -- full schema payload for the item
  taxonomy          jsonb not null default '{}'::jsonb,     -- topics, skills, frameworks: SBAR, STAR, PEEL
  difficulty        text,                                   -- A1..C2 or Beginner..Advanced
  language          text,                                   -- for example 'en'
  state             text not null default 'Draft'
                      check (state in ('Draft','Auto QA','In Review','Approved','Published','Deprecated')),
  version           integer not null default 1,
  flags             jsonb not null default '{}'::jsonb,     -- aggregate flags from auto QA
  reading_level     text,                                   -- optional readability bucket
  exam_mapping      jsonb not null default '{}'::jsonb,     -- band or exam mapping metadata
  accessibility     jsonb not null default '{}'::jsonb,     -- alt guidance
  created_by        uuid references public.profiles(id) on delete set null,
  updated_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.editorial_items is
  'Content units that flow through the AI → Admin editorial pipeline before catalog sync.';

create unique index if not exists editorial_items_kind_slug_idx
  on public.editorial_items (kind, slug);

drop trigger if exists trg_touch_editorial_items on public.editorial_items;
create trigger trg_touch_editorial_items
before update on public.editorial_items
for each row execute function public.touch_updated_at();

-- Link editorial items to target coaches for eventual catalog placement
create table if not exists public.editorial_item_coach_targets (
  editorial_item_id uuid not null references public.editorial_items(id) on delete cascade,
  coach_id          text not null,
  primary key (editorial_item_id, coach_id)
);

-- Version history with diffs for audit
create table if not exists public.editorial_versions (
  id                uuid primary key default gen_random_uuid(),
  editorial_item_id uuid not null references public.editorial_items(id) on delete cascade,
  version           integer not null,
  state             text not null
                      check (state in ('Draft','Auto QA','In Review','Approved','Published','Deprecated')),
  diff              jsonb not null default '{}'::jsonb,     -- JSON patch or semantic diff
  notes             text,                                   -- human changelog
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (editorial_item_id, version)
);

create index if not exists editorial_versions_item_idx
  on public.editorial_versions (editorial_item_id, version desc);

-- Auto QA flags, each atomic and queryable
create table if not exists public.editorial_flags (
  id                uuid primary key default gen_random_uuid(),
  editorial_item_id uuid not null references public.editorial_items(id) on delete cascade,
  flag_type         text not null
                      check (flag_type in ('duplication','safety','accuracy','reading_level','exam_mapping','accessibility','bias','other')),
  payload           jsonb not null default '{}'::jsonb,     -- details and evidence
  severity          text not null default 'info'            -- info, warn, block
                      check (severity in ('info','warn','block')),
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists editorial_flags_item_idx
  on public.editorial_flags (editorial_item_id, created_at desc);

-- State transition log with guardrails
create table if not exists public.editorial_transitions (
  id                uuid primary key default gen_random_uuid(),
  editorial_item_id uuid not null references public.editorial_items(id) on delete cascade,
  from_state        text not null
                      check (from_state in ('Draft','Auto QA','In Review','Approved','Published','Deprecated')),
  to_state          text not null
                      check (to_state in ('Draft','Auto QA','In Review','Approved','Published','Deprecated')),
  actor_id          uuid references public.profiles(id) on delete set null,
  actor_role        text,                                  -- 'admin' or 'ai'
  notes             text,
  created_at        timestamptz not null default now()
);

create index if not exists editorial_transitions_item_idx
  on public.editorial_transitions (editorial_item_id, created_at desc);

-- =====================================================================
-- Guard: only valid transitions, and who can do them
-- =====================================================================

create or replace function public.enforce_editorial_transition()
returns trigger
language plpgsql
as $$
declare
  is_admin boolean := public.is_admin();
  is_ai    boolean := public.is_ai();
begin
  if new.state = old.state then
    return new;
  end if;

  -- Allowed graph:
  -- Draft -> Auto QA (AI or Admin)
  -- Auto QA -> In Review (AI or Admin)
  -- In Review -> Approved (Admin)
  -- Approved -> Published (Admin)
  -- Any -> Deprecated (Admin)
  -- Admin may also send back to Draft or In Review
  if not (
     (old.state = 'Draft'     and new.state = 'Auto QA'    and (is_ai or is_admin)) or
     (old.state = 'Auto QA'   and new.state = 'In Review'  and (is_ai or is_admin)) or
     (old.state = 'In Review' and new.state = 'Approved'   and is_admin) or
     (old.state = 'Approved'  and new.state = 'Published'  and is_admin) or
     (new.state = 'Deprecated' and is_admin) or
     (is_admin and new.state in ('Draft','In Review'))   -- admin send back
  ) then
    raise exception 'Invalid editorial state transition from % to % for your role', old.state, new.state;
  end if;

  -- Bump version whenever moving out of In Review or on Admin edits
  if (old.state = 'In Review' and new.state in ('Approved','Draft'))
     or is_admin then
    new.version := greatest(old.version + 1, new.version);
  end if;

  -- Log transition
  insert into public.editorial_transitions (editorial_item_id, from_state, to_state, actor_id, actor_role, notes)
  values (old.id, old.state, new.state, auth.uid(), case when is_admin then 'admin' when is_ai then 'ai' else 'user' end, null);

  return new;
end $$;

drop trigger if exists trg_editorial_state_guard on public.editorial_items;
create trigger trg_editorial_state_guard
before update on public.editorial_items
for each row
when (old.state is distinct from new.state)
execute function public.enforce_editorial_transition();

-- =====================================================================
-- Convenience view for Admin Review Queue
-- =====================================================================

create or replace view public.v_editorial_review_queue as
select
  i.id,
  i.kind,
  i.title,
  i.slug,
  i.summary,
  i.difficulty,
  i.language,
  i.state,
  i.version,
  i.taxonomy,
  i.exam_mapping,
  i.accessibility,
  i.flags,
  array_agg(t.coach_id order by t.coach_id) as coach_targets,
  coalesce(
    (select jsonb_agg(jsonb_build_object(
        'id', f.id,
        'type', f.flag_type,
        'severity', f.severity,
        'payload', f.payload,
        'created_at', f.created_at
     ) order by f.created_at desc)
     from public.editorial_flags f where f.editorial_item_id = i.id),
    '[]'::jsonb
  ) as flag_list,
  i.created_at,
  i.updated_at
from public.editorial_items i
left join public.editorial_item_coach_targets t on t.editorial_item_id = i.id
where i.state in ('Auto QA','In Review')
group by i.id;

-- =====================================================================
-- RLS enable
-- =====================================================================

alter table if exists public.editorial_items            enable row level security;
alter table if exists public.editorial_item_coach_targets enable row level security;
alter table if exists public.editorial_versions         enable row level security;
alter table if exists public.editorial_flags            enable row level security;
alter table if exists public.editorial_transitions      enable row level security;

-- =====================================================================
-- RLS policies (idempotent, Admin and AI)
-- =====================================================================

do $$
begin
  -- Admin full access on all editorial tables
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_items'
      and policyname = 'editorial_items admin all'
  ) then
    create policy "editorial_items admin all"
    on public.editorial_items
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_item_coach_targets'
      and policyname = 'editorial_targets admin all'
  ) then
    create policy "editorial_targets admin all"
    on public.editorial_item_coach_targets
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_versions'
      and policyname = 'editorial_versions admin all'
  ) then
    create policy "editorial_versions admin all"
    on public.editorial_versions
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_flags'
      and policyname = 'editorial_flags admin all'
  ) then
    create policy "editorial_flags admin all"
    on public.editorial_flags
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_transitions'
      and policyname = 'editorial_transitions admin all'
  ) then
    create policy "editorial_transitions admin all"
    on public.editorial_transitions
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  -- AI permissions on editorial_items
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_items'
      and policyname = 'editorial_items ai create_draft'
  ) then
    create policy "editorial_items ai create_draft"
    on public.editorial_items
    for insert to authenticated
    with check (public.is_ai());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_items'
      and policyname = 'editorial_items ai read_own_and_review'
  ) then
    create policy "editorial_items ai read_own_and_review"
    on public.editorial_items
    for select to authenticated
    using (public.is_admin() or public.is_ai());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_items'
      and policyname = 'editorial_items ai update_draft_autoqa'
  ) then
    create policy "editorial_items ai update_draft_autoqa"
    on public.editorial_items
    for update to authenticated
    using (
      public.is_ai()
      and state in ('Draft','Auto QA','In Review')
    )
    with check (
      public.is_ai()
    );
  end if;

  -- AI permissions on editorial_flags
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_flags'
      and policyname = 'editorial_flags ai create'
  ) then
    create policy "editorial_flags ai create"
    on public.editorial_flags
    for insert to authenticated
    with check (public.is_ai());
  end if;

  -- AI permissions on editorial_versions
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'editorial_versions'
      and policyname = 'editorial_versions ai append'
  ) then
    create policy "editorial_versions ai append"
    on public.editorial_versions
    for insert to authenticated
    with check (public.is_ai());
  end if;
end $$;

-- =====================================================================
-- Indexes and pg_trgm for title search
-- =====================================================================

-- Enable pg_trgm if needed
create extension if not exists pg_trgm;

create index if not exists editorial_items_state_kind_idx
  on public.editorial_items (state, kind);

create index if not exists editorial_items_updated_idx
  on public.editorial_items (updated_at desc);

create index if not exists editorial_items_title_trgm_idx
  on public.editorial_items using gin (title gin_trgm_ops);

-- =====================================================================
-- Defensive revoke (RLS governs access)
-- =====================================================================

do $$
declare
  r record;
begin
  for r in
    select quote_ident(schemaname) s, quote_ident(tablename) t
    from pg_tables
    where schemaname = 'public'
      and tablename in (
        'editorial_items',
        'editorial_item_coach_targets',
        'editorial_versions',
        'editorial_flags',
        'editorial_transitions'
      )
  loop
    execute format('revoke all on table %s.%s from public;', r.s, r.t);
  end loop;
end $$;

-- Notes for app:
-- 1) AI creates editorial_items (Draft) with body, taxonomy, difficulty, and targets
-- 2) AI runs auto QA, writes flags, moves to Auto QA, then to In Review
-- 3) Admin reviews via v_editorial_review_queue, edits, increments version, sets Approved
-- 4) Admin sets Published then server copies to coach catalogs or drills with audit link
-- 5) Deprecated is used to retire items and keep history
-- =====================================================================
