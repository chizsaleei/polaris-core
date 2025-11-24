-- =====================================================================
-- 0004_assignments.sql
-- Polaris Core – Assignments and Assignment Attempts
-- Uses coaches.key (text) and existing drills, drill_sets
-- =====================================================================

-- Enums
do $$
begin
  if not exists (select 1 from pg_type where typname = 'assignment_state') then
    create type assignment_state as enum (
      'assigned','in_progress','completed','skipped','expired','cancelled'
    );
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'assignment_source') then
    create type assignment_source as enum ('drill','set');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'attempt_outcome') then
    create type attempt_outcome as enum ('pass','partial','fail','n_a');
  end if;
end$$;

-- ----------------------------
-- ASSIGNMENTS
-- ----------------------------
create table if not exists public.assignments (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  coach_key         text not null references public.coaches(key) on delete restrict,

  source            assignment_source not null,
  drill_id          uuid references public.drills(id) on delete cascade,
  set_id            uuid references public.drill_sets(id) on delete cascade,

  constraint assignments_target_ck
    check (
      (source = 'drill' and drill_id is not null and set_id is null)
      or
      (source = 'set' and set_id is not null and drill_id is null)
    ),

  title             text,
  description       text,
  tags              text[] not null default '{}',

  scheduled_for     date,
  due_at            timestamptz,
  priority          int not null default 5 check (priority between 1 and 10),

  state             assignment_state not null default 'assigned',
  created_by        uuid,
  started_at        timestamptz,
  completed_at      timestamptz,
  cancelled_at      timestamptz,

  attempts_count    int not null default 0,
  last_attempt_id   uuid,
  last_score        numeric(6,2),
  best_score        numeric(6,2),
  rubric_summary    jsonb default '{}'::jsonb,
  metrics_summary   jsonb default '{}'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_assignments_user      on public.assignments(user_id);
create index if not exists idx_assignments_coach     on public.assignments(coach_key);
create index if not exists idx_assignments_state     on public.assignments(state);
create index if not exists idx_assignments_due       on public.assignments(due_at);
create index if not exists idx_assignments_scheduled on public.assignments(scheduled_for);
create index if not exists idx_assignments_target    on public.assignments(source, drill_id, set_id);
create index if not exists idx_assignments_tags      on public.assignments using gin(tags);

drop trigger if exists trg_assignments_touch on public.assignments;
create trigger trg_assignments_touch
before update on public.assignments
for each row execute function public.tg_set_updated_at();

-- Prevent same-day duplicates
create unique index if not exists uq_assignments_user_day_drill
  on public.assignments(user_id, scheduled_for, drill_id)
  where drill_id is not null;

create unique index if not exists uq_assignments_user_day_set
  on public.assignments(user_id, scheduled_for, set_id)
  where set_id is not null;

-- ----------------------------
-- ASSIGNMENT ATTEMPTS
-- Named to avoid clashing with 0001 public.attempts
-- ----------------------------
create table if not exists public.assignment_attempts (
  id                uuid primary key default gen_random_uuid(),
  assignment_id     uuid not null references public.assignments(id) on delete cascade,
  user_id           uuid not null references public.profiles(id) on delete cascade,
  coach_key         text not null references public.coaches(key) on delete restrict,

  drill_id          uuid references public.drills(id) on delete set null,
  item_id           uuid references public.drill_items(id) on delete set null,

  started_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  duration_seconds  int check (duration_seconds is null or duration_seconds >= 0),

  input_payload     jsonb not null default '{}'::jsonb,
  transcript        jsonb default '[]'::jsonb,
  attachments       jsonb default '[]'::jsonb,
  metrics           jsonb default '{}'::jsonb,
  rubric_scores     jsonb default '{}'::jsonb,
  score             numeric(6,2),
  outcome           attempt_outcome not null default 'n_a',
  feedback          jsonb default '{}'::jsonb,
  flags             jsonb default '[]'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_aattempts_assignment on public.assignment_attempts(assignment_id);
create index if not exists idx_aattempts_user       on public.assignment_attempts(user_id);
create index if not exists idx_aattempts_coach      on public.assignment_attempts(coach_key);
create index if not exists idx_aattempts_drill      on public.assignment_attempts(drill_id);
create index if not exists idx_aattempts_outcome    on public.assignment_attempts(outcome);
create index if not exists idx_aattempts_created    on public.assignment_attempts(created_at);

drop trigger if exists trg_aattempts_touch on public.assignment_attempts;
create trigger trg_aattempts_touch
before update on public.assignment_attempts
for each row execute function public.tg_set_updated_at();

-- ----------------------------
-- Rollup after attempt insert
-- ----------------------------
create or replace function public.assignment_rollup_after_attempt()
returns trigger
language plpgsql
as $$
begin
  update public.assignments a
     set attempts_count  = a.attempts_count + 1,
         last_attempt_id = new.id,
         last_score      = coalesce(new.score, a.last_score),
         best_score      = greatest(coalesce(a.best_score, 0), coalesce(new.score, 0)),
         metrics_summary = a.metrics_summary || jsonb_build_object(
           'last_duration_seconds', new.duration_seconds,
           'last_wpm', (new.metrics->>'wpm')::numeric
         ),
         started_at      = coalesce(a.started_at, new.started_at),
         state           = case
                             when new.outcome in ('pass','partial') or new.submitted_at is not null
                               then 'completed'
                             else a.state
                           end,
         completed_at    = case
                             when (new.outcome in ('pass','partial') or new.submitted_at is not null)
                               then coalesce(a.completed_at, new.submitted_at, now())
                             else a.completed_at
                           end,
         updated_at      = now()
   where a.id = new.assignment_id;
  return new;
end
$$;

drop trigger if exists trg_aattempts_after_ins on public.assignment_attempts;
create trigger trg_aattempts_after_ins
after insert on public.assignment_attempts
for each row execute function public.assignment_rollup_after_attempt();

-- ----------------------------
-- Fast analytics helpers
-- ----------------------------
create or replace view public.v_assignment_latest as
select
  a.id,
  a.user_id,
  a.coach_key,
  a.source,
  a.drill_id,
  a.set_id,
  a.state,
  a.scheduled_for,
  a.due_at,
  a.attempts_count,
  a.last_score,
  a.best_score,
  a.metrics_summary,
  a.created_at,
  a.updated_at
from public.assignments a;

create or replace view public.v_assignment_attempts_daily as
select
  user_id,
  coach_key,
  date_trunc('day', created_at) as day,
  count(*)                      as attempts,
  avg(score)                    as avg_score,
  avg((metrics->>'wpm')::numeric) as avg_wpm
from public.assignment_attempts
group by 1,2,3;

comment on table public.assignments            is 'Scheduled work for a user targeting a drill or a set.';
comment on table public.assignment_attempts    is 'Each submission tied to an assignment.';
comment on view  public.v_assignment_latest    is 'Latest rollups per assignment for quick UI reads.';
comment on view  public.v_assignment_attempts_daily is 'Daily aggregates by user and coach.';

-- ----------------------------
-- RLS on
-- Policies can be defined in a later migration
-- ----------------------------
alter table public.assignments          enable row level security;
alter table public.assignment_attempts  enable row level security;

-- Suggested filtered indexes
create index if not exists idx_assignments_user_open
  on public.assignments(user_id, state, scheduled_for)
  where state in ('assigned','in_progress');

create index if not exists idx_aattempts_recent_user
  on public.assignment_attempts(user_id, created_at desc);
