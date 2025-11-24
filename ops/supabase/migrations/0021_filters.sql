-- ====================================================================
-- 0021_filters.sql
-- Saved filters, facet views, and date-range aware filtering helpers.
-- Fits the Polaris browse model: filter by coach, type, difficulty, date.
-- Topic facets can be added later once topic column is finalized.
-- Date: 2025-11-14
-- ====================================================================

do $$
begin
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
    end $fn$;
  end if;

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

-- ====================================================================
-- Saved filter presets (per user)
-- ====================================================================

create table if not exists public.saved_filters (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  name         text not null,                 -- e.g. "IELTS Band 7 drills", "Quick 5-min Physician"
  -- criteria is a JSON blob the app understands. Suggested shape:
  -- {
  --   "coachKeys": ["chase_krashen","dr_claire", ...],
  --   "types": ["speaking_drill","scenario","qbank","rubric"],
  --   "difficulties": ["easy","medium","hard"],
  --   "dateFrom": "2025-01-01T00:00:00Z",
  --   "dateTo": "2025-01-31T23:59:59Z",
  --   "runtimeMaxSec": 600
  -- }
  criteria     jsonb not null default '{}'::jsonb,
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_saved_filters_user on public.saved_filters(user_id);
create index if not exists idx_saved_filters_name on public.saved_filters(name);

drop trigger if exists trg_touch_saved_filters on public.saved_filters;
create trigger trg_touch_saved_filters
before update on public.saved_filters
for each row execute function public.touch_updated_at();

alter table public.saved_filters enable row level security;

-- Users can manage their own saved filters
drop policy if exists "saved_filters user read" on public.saved_filters;
create policy "saved_filters user read"
on public.saved_filters
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "saved_filters user write" on public.saved_filters;
create policy "saved_filters user write"
on public.saved_filters
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "saved_filters user update" on public.saved_filters;
create policy "saved_filters user update"
on public.saved_filters
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "saved_filters user delete" on public.saved_filters;
create policy "saved_filters user delete"
on public.saved_filters
for delete
to authenticated
using (auth.uid() = user_id);

-- Admin can manage all
drop policy if exists "saved_filters admin manage" on public.saved_filters;
create policy "saved_filters admin manage"
on public.saved_filters
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

revoke all on public.saved_filters from anon;

-- ====================================================================
-- Facet views for Browse (coach/type/difficulty/date buckets)
-- Assumes drills.state = 'published' for live catalog.
-- Uses coach_key and created_at for dating.
-- ====================================================================

-- Coach facets
create or replace view public.v_drill_facets_coach as
select
  d.coach_key,
  count(*) as item_count
from public.drills d
where d.state = 'published'
group by d.coach_key
order by item_count desc;

-- Type facets
create or replace view public.v_drill_facets_type as
select
  d.type,
  count(*) as item_count
from public.drills d
where d.state = 'published'
group by d.type
order by item_count desc;

-- Difficulty facets
create or replace view public.v_drill_facets_difficulty as
select
  d.difficulty,
  count(*) as item_count
from public.drills d
where d.state = 'published'
group by d.difficulty
order by item_count desc;

-- Date facets: daily, weekly, monthly buckets based on created_at
create or replace view public.v_drill_facets_date_daily as
select
  date_trunc('day', d.created_at) as day,
  count(*) as item_count
from public.drills d
where d.state = 'published'
group by 1
order by 1 desc;

create or replace view public.v_drill_facets_date_weekly as
select
  date_trunc('week', d.created_at) as week,
  count(*) as item_count
from public.drills d
where d.state = 'published'
group by 1
order by 1 desc;

create or replace view public.v_drill_facets_date_monthly as
select
  date_trunc('month', d.created_at) as month,
  count(*) as item_count
from public.drills d
where d.state = 'published'
group by 1
order by 1 desc;

-- Optional helpful composite view (counts by multiple dimensions at once)
create or replace view public.v_drill_facets_overview as
with base as (
  select id, coach_key, type, difficulty, created_at
  from public.drills
  where state = 'published'
)
select
  (select count(*) from base)                                               as total_published,
  (select jsonb_agg(jsonb_build_object('coach_key', coach_key, 'count', c))
     from (select coach_key, count(*) as c from base group by coach_key order by c desc) s) as by_coach,
  (select jsonb_agg(jsonb_build_object('type', type, 'count', c))
     from (select type, count(*) as c from base group by type order by c desc) s)         as by_type,
  (select jsonb_agg(jsonb_build_object('difficulty', difficulty, 'count', c))
     from (select difficulty, count(*) as c from base group by difficulty order by c desc) s) as by_difficulty,
  (select jsonb_agg(jsonb_build_object('day', bucket_day, 'count', c))
     from (
       select date_trunc('day', created_at) as bucket_day, count(*) as c
       from base
       group by 1
       order by 1 desc
       limit 30
     ) s) as by_day_last_30
;

-- ====================================================================
-- Filtering helper: returns drill ids that match optional filters
-- Includes DATE FILTER: p_date_from / p_date_to
-- Uses coach_key, type, difficulty and created_at.
-- ====================================================================

create or replace function public.filter_drills(
  p_coach_keys    text[]      default null,
  p_types         text[]      default null,
  p_difficulties  text[]      default null,
  p_date_from     timestamptz default null,
  p_date_to       timestamptz default null
)
returns table(drill_id uuid)
language sql
stable
as $fn$
  select d.id
  from public.drills d
  where d.state = 'published'
    and (p_coach_keys   is null or d.coach_key::text   = any(p_coach_keys))
    and (p_types        is null or d.type::text        = any(p_types))
    and (p_difficulties is null or d.difficulty::text  = any(p_difficulties))
    and (p_date_from    is null or d.created_at >= p_date_from)
    and (p_date_to      is null or d.created_at <  p_date_to)
$fn$;

grant execute on function public.filter_drills(
  text[], text[], text[], timestamptz, timestamptz
) to anon, authenticated;

-- Convenience wrapper that accepts a JSON criteria blob
-- Supports both "coachKeys" (preferred) and legacy "coachIds" as text keys
create or replace function public.filter_drills_json(p_criteria jsonb)
returns table(drill_id uuid)
language sql
stable
as $fn$
  select *
  from public.filter_drills(
    coalesce(
      (select array_agg(v)
         from jsonb_array_elements_text(p_criteria->'coachKeys') v),
      (select array_agg(v)
         from jsonb_array_elements_text(p_criteria->'coachIds') v),
      null
    ),
    coalesce(
      (select array_agg(v)
         from jsonb_array_elements_text(p_criteria->'types') v),
      null
    ),
    coalesce(
      (select array_agg(v)
         from jsonb_array_elements_text(p_criteria->'difficulties') v),
      null
    ),
    (p_criteria->>'dateFrom')::timestamptz,
    (p_criteria->>'dateTo')::timestamptz
  )
$fn$;

grant execute on function public.filter_drills_json(jsonb) to anon, authenticated;

-- ====================================================================
-- Helpful indexes for fast filtering
-- ====================================================================

create index if not exists idx_drills_state_created on public.drills(state, created_at desc);
create index if not exists idx_drills_coach_key on public.drills(coach_key);
create index if not exists idx_drills_type on public.drills(type);
create index if not exists idx_drills_difficulty on public.drills(difficulty);
create index if not exists idx_drills_created_at on public.drills(created_at);

-- ====================================================================
-- Notes:
-- - Coach dimension uses coach_key (text) across facets and filters.
-- - Date filter is implemented using created_at in both views and functions.
-- - Topic filter and facets are intentionally omitted for now because the
--   current drills schema does not expose a topic column. They can be added
--   later once that column is defined.
-- ====================================================================
