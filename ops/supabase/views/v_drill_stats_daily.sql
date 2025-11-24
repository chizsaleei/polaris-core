-- =====================================================================
-- Polaris Core - Analytics View: v_drill_stats_daily
-- File: ops/supabase/views/v_drill_stats_daily.sql
--
-- Purpose:
--   Per-day drill analytics with an attempt_date column for filtering.
--   Mirrors the main v_drill_stats metrics, grouped by day.
--
-- Actual tables/columns (0001_init.sql):
--   public.drills (
--     id uuid primary key,
--     coach_key text,
--     type drill_type,
--     title text,
--     prompt text,
--     tags jsonb,
--     time_estimate_minutes int,
--     difficulty smallint,
--     gating boolean,
--     rubric_id uuid,
--     state item_state,
--     is_public boolean,
--     created_by uuid,
--     created_at timestamptz,
--     updated_at timestamptz
--   )
--
--   public.attempts (
--     id uuid primary key,
--     session_id uuid not null,
--     drill_id uuid,
--     prompt text,
--     response text,
--     feedback jsonb,
--     wins text[],
--     fixes text[],
--     next_prompt text,
--     score int,
--     created_at timestamptz
--   )
--
--   public.sessions (
--     id uuid primary key,
--     user_id uuid not null,
--     coach_key text,
--     tier tier_plan,
--     status session_status,
--     tool_used text,
--     started_at timestamptz,
--     submitted_at timestamptz,
--     ended_at timestamptz,
--     duration_sec int,
--     score numeric,
--     words_per_minute numeric,
--     notes text
--   )
--
-- Notes:
--   - Normalizes attempt score to 0..1 per drill. If any score > 1 for a
--     drill, scores are treated as 0..100 and divided by 100.
--   - Pass rule: inferred as score >= 0.7 (or >= 70 on 0..100 scale).
--   - attempt_date uses date_trunc('day', coalesce(session.submitted_at, attempt.created_at)) in UTC.
--   - Uses sessions.duration_sec and sessions.words_per_minute where available.
-- =====================================================================

create or replace view public.v_drill_stats_daily as
with attempts_scored as (
  select
    d.id                        as drill_id,
    d.coach_key,
    d.type,
    d.difficulty,
    d.time_estimate_minutes,
    d.created_at                as drill_created_at,

    s.user_id,
    s.submitted_at,
    date_trunc(
      'day',
      coalesce(s.submitted_at, a.created_at)
    )::date                     as attempt_date,

    -- detect per-drill score scale
    max(a.score) over (partition by a.drill_id) as max_score_for_drill,

    -- raw inputs
    a.score                     as score_raw,
    s.words_per_minute          as wpm,
    s.duration_sec              as duration_sec
  from public.drills d
  join public.attempts a
    on a.drill_id = d.id
  left join public.sessions s
    on s.id = a.session_id
),
normalized as (
  select
    drill_id,
    coach_key,
    type,
    difficulty,
    time_estimate_minutes,
    drill_created_at,
    user_id,
    submitted_at,
    attempt_date,
    wpm,
    duration_sec,
    case
      when max_score_for_drill is not null and max_score_for_drill > 1.0
        then (score_raw / 100.0)::numeric
      else score_raw::numeric
    end as score_norm,
    case
      when score_raw is null then null
      when max_score_for_drill is not null and max_score_for_drill > 1.0
        then score_raw >= 70
      else score_raw >= 0.7
    end as passed_inferred
  from attempts_scored
)
select
  attempt_date,                  -- filter on this
  drill_id,
  coach_key,
  type,
  difficulty,
  time_estimate_minutes,
  drill_created_at,

  count(*)                        as attempts_total,
  count(distinct user_id)         as users_total,

  count(*) filter (where passed_inferred is true) as passes_total,
  case
    when count(*) > 0
    then (count(*) filter (where passed_inferred is true))::numeric / count(*)::numeric
    else null
  end as pass_rate,

  avg(score_norm)                 as avg_score,
  percentile_cont(0.5) within group (order by score_norm) as p50_score,
  percentile_cont(0.9) within group (order by score_norm) as p90_score,

  avg(duration_sec)               as avg_duration_sec,
  avg(wpm)                        as avg_wpm,

  max(submitted_at)               as last_attempt_at
from normalized
group by
  attempt_date,
  drill_id,
  coach_key,
  type,
  difficulty,
  time_estimate_minutes,
  drill_created_at
order by attempt_date desc, drill_id;

comment on view public.v_drill_stats_daily is
  'Per-day drill metrics with attempt_date for filtering: attempts, users, pass rate, scores (normalized), timing.';
