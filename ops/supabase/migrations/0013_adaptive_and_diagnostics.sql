-- ===================================================================== 
-- 0013_adaptive_and_diagnostics.sql
-- Adaptive user model, calibration, and diagnostics blueprints and runs
-- Works with:
--   drills, drill_sets, drill_items (from 0003)
--   profiles and sessions (from 0002)
-- States used by runs: created → in_progress → completed → cancelled
-- =====================================================================

-- Touch helper (shared pattern)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $touch$
begin
  new.updated_at := now();
  return new;
end
$touch$;

-- Assume is_admin() already created in earlier migrations
-- Fallback to a stub if missing (does not override existing)
do $$
begin
  if not exists (
    select 1
    from pg_proc
    where proname = 'is_admin'
      and pronamespace = 'public'::regnamespace
  ) then
    create function public.is_admin()
    returns boolean
    language sql
    stable
    as $fn$
      select false
    $fn$;
  end if;
end $$;

-- =========================
-- Adaptive data structures
-- =========================

-- Skill model per user, per coach, per topic
create table if not exists public.adaptive_user_skill (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  coach_id       text not null,                               -- for example 'claire-swales'
  topic          text not null,                               -- taxonomy path like 'IELTS|Part2' or 'ICU|Handoff'
  level_score    numeric(5,2) not null default 0.00,          -- normalized 0 to 1
  confidence     numeric(5,2) not null default 0.50,          -- 0 to 1
  exposures      integer not null default 0,
  last_mastered  timestamptz,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  primary key (user_id, coach_id, topic)
);

drop trigger if exists trg_touch_adaptive_user_skill on public.adaptive_user_skill;
create trigger trg_touch_adaptive_user_skill
before update on public.adaptive_user_skill
for each row execute function public.touch_updated_at();

-- Calibration info on drills for adaptive routing
-- One row per drill and topic tag that matters for routing
create table if not exists public.adaptive_item_calibration (
  drill_id       uuid not null references public.drills(id) on delete cascade,
  coach_id       text not null,
  topic          text not null,
  difficulty     text,                              -- A1..C2 or Beginner..Advanced
  target_level   numeric(5,2) not null default 0.5, -- rough level center 0 to 1
  discriminant   numeric(5,2) not null default 0.8, -- how well it separates
  exposure_cap   integer not null default 1000,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (drill_id, topic)
);

drop trigger if exists trg_touch_adaptive_item_calibration on public.adaptive_item_calibration;
create trigger trg_touch_adaptive_item_calibration
before update on public.adaptive_item_calibration
for each row execute function public.touch_updated_at();

create index if not exists aic_coach_topic_idx
  on public.adaptive_item_calibration (coach_id, topic)
  where active;

-- History of adaptive selections and outcomes
create table if not exists public.adaptive_history (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  drill_id      uuid not null references public.drills(id) on delete cascade,
  coach_id      text not null,
  topic         text not null,
  served_at     timestamptz not null default now(),
  outcome_score numeric(5,2),                 -- 0 to 1, null until graded
  duration_sec  integer,
  notes         text
);

create index if not exists ah_user_time_idx
  on public.adaptive_history (user_id, served_at desc);

create index if not exists ah_user_topic_idx
  on public.adaptive_history (user_id, coach_id, topic);

-- Simple next item function
-- Strategy:
--  1) read user level for coach + topic or default to 0.5
--  2) prefer drills near target_level within band
--  3) avoid repeats from today
--  4) fallback to any active calibrated drill for coach
create or replace function public.adaptive_next_drill(
  p_user_id uuid,
  p_coach_id text,
  p_topic text
) returns uuid
language plpgsql
stable
as $next$
declare
  v_level numeric(5,2);
  v_today date := current_date;
  v_drill uuid;
begin
  select level_score
  into v_level
  from public.adaptive_user_skill
  where user_id = p_user_id
    and coach_id = p_coach_id
    and topic = p_topic;

  if v_level is null then
    v_level := 0.5;
  end if;

  -- pick not served today and closest to level
  select a.drill_id
  into v_drill
  from public.adaptive_item_calibration a
  left join lateral (
    select 1
    from public.adaptive_history h
    where h.user_id = p_user_id
      and h.drill_id = a.drill_id
      and h.served_at::date = v_today
    limit 1
  ) r on true
  where a.coach_id = p_coach_id
    and a.topic = p_topic
    and a.active
    and r is null
  order by abs(a.target_level - v_level) asc, a.discriminant desc
  limit 1;

  if v_drill is null then
    -- fallback any active for coach
    select a.drill_id
    into v_drill
    from public.adaptive_item_calibration a
    where a.coach_id = p_coach_id
      and a.active
    order by a.created_at desc
    limit 1;
  end if;

  return v_drill;
end
$next$;

-- =========================
-- Diagnostics blueprints
-- =========================

-- A diagnostic form is a blueprint composed of sections and items
create table if not exists public.diagnostic_forms (
  id            uuid primary key default gen_random_uuid(),
  coach_id      text not null,         -- main coach focus
  code          text not null unique,  -- short key like 'IELTS-STARTER'
  title         text not null,
  summary       text,
  config        jsonb not null default '{}'::jsonb,  -- time limits, grading weights
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_touch_diagnostic_forms on public.diagnostic_forms;
create trigger trg_touch_diagnostic_forms
before update on public.diagnostic_forms
for each row execute function public.touch_updated_at();

create table if not exists public.diagnostic_form_sections (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references public.diagnostic_forms(id) on delete cascade,
  idx           integer not null,                        -- 1 based order
  title         text not null,
  target_topics text[] not null default '{}',            -- topics to update
  time_limit_sec integer,
  created_at    timestamptz not null default now()
);

create unique index if not exists dfs_form_idx_unique
  on public.diagnostic_form_sections (form_id, idx);

-- Each blueprint item either references an existing drill or provides an inline payload
create table if not exists public.diagnostic_form_items (
  id            uuid primary key default gen_random_uuid(),
  form_id       uuid not null references public.diagnostic_forms(id) on delete cascade,
  section_id    uuid not null references public.diagnostic_form_sections(id) on delete cascade,
  idx           integer not null,
  kind          text not null check (kind in ('reference','inline')),
  drill_id      uuid references public.drills(id) on delete set null,     -- for kind reference
  payload       jsonb not null default '{}'::jsonb,                        -- for kind inline
  rubric        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (section_id, idx)
);

create index if not exists dfi_form_idx
  on public.diagnostic_form_items (form_id);

-- =========================
-- Diagnostic runs
-- =========================

create table if not exists public.diagnostic_runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  form_id       uuid not null references public.diagnostic_forms(id) on delete restrict,
  state         text not null default 'created'
                  check (state in ('created','in_progress','completed','cancelled')),
  started_at    timestamptz,
  completed_at  timestamptz,
  score_total   numeric(6,2),
  duration_sec  integer,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists trg_touch_diagnostic_runs on public.diagnostic_runs;
create trigger trg_touch_diagnostic_runs
before update on public.diagnostic_runs
for each row execute function public.touch_updated_at();

create index if not exists dr_user_time_idx
  on public.diagnostic_runs (user_id, created_at desc);

create table if not exists public.diagnostic_run_items (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.diagnostic_runs(id) on delete cascade,
  section_id    uuid not null references public.diagnostic_form_sections(id) on delete restrict,
  form_item_id  uuid not null references public.diagnostic_form_items(id) on delete restrict,
  idx           integer not null,  -- order served
  drill_id      uuid references public.drills(id) on delete set null,  -- resolved drill
  status        text not null default 'pending'
                  check (status in ('pending','served','submitted','scored','skipped')),
  response_text text,
  response_url  text,          -- audio or file url in storage
  rubric        jsonb,         -- rubric snapshot used at serve time
  score         numeric(5,2),
  duration_sec  integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (run_id, idx)
);

drop trigger if exists trg_touch_diagnostic_run_items on public.diagnostic_run_items;
create trigger trg_touch_diagnostic_run_items
before update on public.diagnostic_run_items
for each row execute function public.touch_updated_at();

create index if not exists dri_run_idx
  on public.diagnostic_run_items (run_id, idx);

-- ================
-- Helper functions
-- ================

-- Start a run from a form blueprint
create or replace function public.diagnostic_start(
  p_user_id uuid,
  p_form_code text
) returns uuid
language plpgsql
as $start$
declare
  v_form_id uuid;
  v_run_id uuid;
  rec record;
  i_idx int;
begin
  select id
  into v_form_id
  from public.diagnostic_forms
  where code = p_form_code;

  if v_form_id is null then
    raise exception 'Diagnostic form % not found', p_form_code;
  end if;

  insert into public.diagnostic_runs (user_id, form_id, state, started_at)
  values (p_user_id, v_form_id, 'in_progress', now())
  returning id into v_run_id;

  for rec in
    select s.id as section_id,
           s.idx as sec_idx,
           fi.id as form_item_id,
           fi.idx as item_idx,
           fi.kind,
           fi.drill_id,
           fi.payload,
           fi.rubric
    from public.diagnostic_form_sections s
    join public.diagnostic_form_items fi on fi.section_id = s.id
    where s.form_id = v_form_id
    order by s.idx, fi.idx
  loop
    i_idx := (rec.sec_idx * 1000) + rec.item_idx;

    insert into public.diagnostic_run_items
      (run_id, section_id, form_item_id, idx, drill_id, status, rubric)
    values
      (v_run_id, rec.section_id, rec.form_item_id, i_idx, rec.drill_id, 'served', rec.rubric);
  end loop;

  return v_run_id;
end
$start$;

-- Submit a single item and update skill model lightly
create or replace function public.diagnostic_submit_item(
  p_run_item_id uuid,
  p_outcome_score numeric,
  p_duration_sec int,
  p_response_text text default null,
  p_response_url text default null
) returns void
language plpgsql
as $submit$
declare
  v_user_id uuid;
  v_run_id uuid;
  v_coach_id text;
  v_topic text;
  v_drill_id uuid;
  v_form_id uuid;
  v_section_id uuid;
  v_form_item_id uuid;
begin
  update public.diagnostic_run_items
  set status = 'scored',
      score = p_outcome_score,
      duration_sec = p_duration_sec,
      response_text = coalesce(p_response_text, response_text),
      response_url  = coalesce(p_response_url, response_url),
      updated_at = now()
  where id = p_run_item_id
  returning run_id, drill_id, section_id, form_item_id
  into v_run_id, v_drill_id, v_section_id, v_form_item_id;

  select user_id, form_id
  into v_user_id, v_form_id
  from public.diagnostic_runs
  where id = v_run_id;

  -- find coach and topic from form section or calibration for the drill
  select df.coach_id
  into v_coach_id
  from public.diagnostic_forms df
  where df.id = v_form_id;

  select unnest(s.target_topics)
  into v_topic
  from public.diagnostic_form_sections s
  where s.id = v_section_id
  limit 1;

  if v_topic is null then
    select topic
    into v_topic
    from public.adaptive_item_calibration
    where drill_id = v_drill_id
    limit 1;
  end if;

  if v_topic is not null then
    insert into public.adaptive_user_skill (
      user_id,
      coach_id,
      topic,
      level_score,
      confidence,
      exposures,
      last_mastered
    )
    values (
      v_user_id,
      v_coach_id,
      v_topic,
      greatest(0, least(1, coalesce(p_outcome_score, 0.5))),
      0.6,
      1,
      case when p_outcome_score >= 0.8 then now() end
    )
    on conflict (user_id, coach_id, topic) do update
      set level_score = greatest(
            0,
            least(
              1,
              0.7 * public.adaptive_user_skill.level_score
            + 0.3 * coalesce(excluded.level_score, 0.5)
            )
          ),
          confidence  = least(1, public.adaptive_user_skill.confidence + 0.05),
          exposures   = public.adaptive_user_skill.exposures + 1,
          last_mastered = case
            when p_outcome_score >= 0.8 then now()
            else public.adaptive_user_skill.last_mastered
          end,
          updated_at  = now();
  end if;

  if v_drill_id is not null then
    insert into public.adaptive_history (
      user_id,
      drill_id,
      coach_id,
      topic,
      outcome_score,
      duration_sec
    )
    values (
      v_user_id,
      v_drill_id,
      v_coach_id,
      coalesce(v_topic, 'general'),
      p_outcome_score,
      p_duration_sec
    );
  end if;
end
$submit$;

-- Complete a run and roll up score
create or replace function public.diagnostic_complete_run(p_run_id uuid)
returns void
language sql
as $complete$
  update public.diagnostic_runs r
  set state = 'completed',
      completed_at = now(),
      duration_sec = (
        select coalesce(sum(duration_sec), 0)
        from public.diagnostic_run_items i
        where i.run_id = r.id
      ),
      score_total = (
        select avg(score)::numeric(6,2)
        from public.diagnostic_run_items i
        where i.run_id = r.id
          and i.status = 'scored'
      ),
      updated_at = now()
  where r.id = p_run_id;
$complete$;

-- =========================
-- RLS
-- =========================

alter table if exists public.adaptive_user_skill          enable row level security;
alter table if exists public.adaptive_item_calibration    enable row level security;
alter table if exists public.adaptive_history             enable row level security;
alter table if exists public.diagnostic_forms             enable row level security;
alter table if exists public.diagnostic_form_sections     enable row level security;
alter table if exists public.diagnostic_form_items        enable row level security;
alter table if exists public.diagnostic_runs              enable row level security;
alter table if exists public.diagnostic_run_items         enable row level security;

-- Admin and user policies (idempotent)
do $$
begin
  -- Admin full control
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_user_skill'
      and policyname = 'adaptive admin all'
  ) then
    create policy "adaptive admin all"
    on public.adaptive_user_skill
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_item_calibration'
      and policyname = 'calibration admin all'
  ) then
    create policy "calibration admin all"
    on public.adaptive_item_calibration
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_history'
      and policyname = 'ah admin read'
  ) then
    create policy "ah admin read"
    on public.adaptive_history
    for select to authenticated
    using (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_forms'
      and policyname = 'df admin all'
  ) then
    create policy "df admin all"
    on public.diagnostic_forms
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_form_sections'
      and policyname = 'dfs admin all'
  ) then
    create policy "dfs admin all"
    on public.diagnostic_form_sections
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_form_items'
      and policyname = 'dfi admin all'
  ) then
    create policy "dfi admin all"
    on public.diagnostic_form_items
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_runs'
      and policyname = 'dr admin all'
  ) then
    create policy "dr admin all"
    on public.diagnostic_runs
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_run_items'
      and policyname = 'dri admin all'
  ) then
    create policy "dri admin all"
    on public.diagnostic_run_items
    for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  -- User access: adaptive_user_skill
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_user_skill'
      and policyname = 'adaptive user read_own'
  ) then
    create policy "adaptive user read_own"
    on public.adaptive_user_skill
    for select to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_user_skill'
      and policyname = 'adaptive user insert_own'
  ) then
    create policy "adaptive user insert_own"
    on public.adaptive_user_skill
    for insert to authenticated
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_user_skill'
      and policyname = 'adaptive user update_own'
  ) then
    create policy "adaptive user update_own"
    on public.adaptive_user_skill
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;

  -- User access: adaptive_history
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_history'
      and policyname = 'ah user read_own'
  ) then
    create policy "ah user read_own"
    on public.adaptive_history
    for select to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_history'
      and policyname = 'ah user insert_own'
  ) then
    create policy "ah user insert_own"
    on public.adaptive_history
    for insert to authenticated
    with check (auth.uid() = user_id);
  end if;

  -- User access: diagnostics runs and items
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_runs'
      and policyname = 'dr user read_own'
  ) then
    create policy "dr user read_own"
    on public.diagnostic_runs
    for select to authenticated
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_runs'
      and policyname = 'dr user insert_own'
  ) then
    create policy "dr user insert_own"
    on public.diagnostic_runs
    for insert to authenticated
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_runs'
      and policyname = 'dr user update_own'
  ) then
    create policy "dr user update_own"
    on public.diagnostic_runs
    for update to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_run_items'
      and policyname = 'dri user read_by_run'
  ) then
    create policy "dri user read_by_run"
    on public.diagnostic_run_items
    for select to authenticated
    using (
      exists (
        select 1
        from public.diagnostic_runs r
        where r.id = run_id
          and r.user_id = auth.uid()
      )
    );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_run_items'
      and policyname = 'dri user insert_by_run'
  ) then
    create policy "dri user insert_by_run"
    on public.diagnostic_run_items
    for insert to authenticated
    with check (
      exists (
        select 1
        from public.diagnostic_runs r
        where r.id = run_id
          and r.user_id = auth.uid()
      )
    );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_run_items'
      and policyname = 'dri user update_by_run'
  ) then
    create policy "dri user update_by_run"
    on public.diagnostic_run_items
    for update to authenticated
    using (
      exists (
        select 1
        from public.diagnostic_runs r
        where r.id = run_id
          and r.user_id = auth.uid()
      )
    )
    with check (
      exists (
        select 1
        from public.diagnostic_runs r
        where r.id = run_id
          and r.user_id = auth.uid()
      )
    );
  end if;

  -- Forms and calibration read only to users
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_forms'
      and policyname = 'df user read'
  ) then
    create policy "df user read"
    on public.diagnostic_forms
    for select to authenticated
    using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_form_sections'
      and policyname = 'dfs user read'
  ) then
    create policy "dfs user read"
    on public.diagnostic_form_sections
    for select to authenticated
    using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'diagnostic_form_items'
      and policyname = 'dfi user read'
  ) then
    create policy "dfi user read"
    on public.diagnostic_form_items
    for select to authenticated
    using (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'adaptive_item_calibration'
      and policyname = 'calibration user read'
  ) then
    create policy "calibration user read"
    on public.adaptive_item_calibration
    for select to authenticated
    using (true);
  end if;
end $$;

-- Indexes for diagnostics analytics
create index if not exists dr_state_idx
  on public.diagnostic_runs (state);

create index if not exists dri_status_idx
  on public.diagnostic_run_items (status);

-- Defensive revoke (RLS governs access)
do $$
declare
  r record;
begin
  for r in
    select quote_ident(schemaname) as s, quote_ident(tablename) as t
    from pg_tables
    where schemaname = 'public'
      and tablename in (
        'adaptive_user_skill',
        'adaptive_item_calibration',
        'adaptive_history',
        'diagnostic_forms',
        'diagnostic_form_sections',
        'diagnostic_form_items',
        'diagnostic_runs',
        'diagnostic_run_items'
      )
  loop
    execute format('revoke all on table %s.%s from public;', r.s, r.t);
  end loop;
end $$;

-- Notes:
-- 1) Server or client can call diagnostic_start(auth.uid(), 'FORM_CODE') to create a run
-- 2) For each served item, client submits to diagnostic_submit_item with score and duration
-- 3) On finish, call diagnostic_complete_run(run_id)
-- 4) adaptive_next_drill can power Practice Now by passing user, coach, topic
-- =====================================================================
