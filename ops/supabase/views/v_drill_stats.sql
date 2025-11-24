-- =====================================================================
-- Polaris Core – Analytics View: v_drill_stats
-- File: ops/supabase/views/v_drill_stats.sql
--
-- Purpose:
--   Per-user, per-coach aggregate drill health:
--   sessions, attempts, average score, and last activity.
--
-- Actual tables/columns (0001_init.sql):
--   public.sessions (
--     id uuid primary key,
--     user_id uuid not null,
--     coach_key text,
--     status session_status,
--     started_at timestamptz,
--     ended_at timestamptz,
--     duration_sec int,
--     score numeric,
--     words_per_minute numeric
--   )
--
--   public.attempts (
--     id uuid primary key,
--     session_id uuid not null references public.sessions(id),
--     drill_id uuid,
--     score int,
--     created_at timestamptz not null default now()
--   )
--
-- Notes:
--   - Aggregates across all time per (user_id, coach_key).
--   - avg_score is average attempt score (int) normalized to numeric.
--   - last_activity is the latest of session end/start or attempt created_at.
--   - date is last_activity truncated to calendar day (UTC).
--   - View is read-only and respects base-table RLS.
-- =====================================================================

drop view if exists public.v_drill_stats;

create or replace view public.v_drill_stats as
with session_base as (
  select
    s.id as session_id,
    s.user_id,
    s.coach_key,
    coalesce(s.ended_at, s.started_at) as session_time
  from public.sessions s
  where s.status in ('submitted','completed')
),
agg as (
  select
    sb.user_id,
    sb.coach_key,
    count(distinct sb.session_id)              as sessions,
    count(a.id)                                as attempts,
    avg(a.score::numeric)                      as avg_score,
    max(coalesce(sb.session_time, a.created_at)) as last_activity
  from session_base sb
  left join public.attempts a
    on a.session_id = sb.session_id
  group by sb.user_id, sb.coach_key
)
select
  user_id,
  coach_key,
  sessions,
  attempts,
  avg_score,
  last_activity,
  date_trunc('day', last_activity)::date as date
from agg;

comment on view public.v_drill_stats is
  'Per-user, per-coach aggregates: sessions, attempts, avg_score, last_activity, and day (date).';

-- Helpful indexes for this view’s common filters/joins
-- Run once; harmless if already present.
create index if not exists idx_sessions_user_coach_time
  on public.sessions (user_id, coach_key, started_at desc);

create index if not exists idx_attempts_session_created_at
  on public.attempts (session_id, created_at desc);
