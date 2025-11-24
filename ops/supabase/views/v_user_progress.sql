-- =====================================================================
-- Polaris Core – Analytics View: v_user_progress
-- File: ops/supabase/views/v_user_progress.sql
--
-- Purpose:
--   Per-user learning progress rollups with rolling 7d/28d windows,
--   minutes, attempts, pass rate, averages, and recent coach/topic.
--   Uses the Asia/Manila day boundary.
--
-- Actual tables/columns:
--   public.profiles (
--     id uuid primary key,
--     email text,
--     full_name text,
--     tier tier_plan not null default 'free',
--     active_coach_key text,
--     created_at timestamptz,
--     ...
--   )
--
--   public.sessions (
--     id uuid primary key,
--     user_id uuid not null,
--     coach_key text,
--     status session_status,
--     started_at timestamptz,
--     submitted_at timestamptz,
--     ended_at timestamptz,
--     duration_sec int,
--     score numeric,
--     words_per_minute numeric,
--     ...
--   )
--
--   public.attempts (
--     id uuid primary key,
--     session_id uuid not null references public.sessions(id),
--     drill_id uuid,
--     score int,
--     created_at timestamptz not null default now(),
--     ...
--   )
--
--   public.drills (
--     id uuid primary key,
--     coach_key text,
--     type drill_type,
--     title text,
--     prompt text,
--     tags jsonb,
--     time_estimate_minutes int,
--     difficulty smallint,
--     state item_state,
--     is_public boolean,
--     created_at timestamptz,
--     ...
--   )
-- =====================================================================

drop view if exists public.v_user_progress;

create or replace view public.v_user_progress as
with
-- --------------------------
-- Manila window boundaries
-- --------------------------
tz as (
  select 'Asia/Manila'::text as tz_name
),
now_mnl as (
  select (now() at time zone (select tz_name from tz)) as now_local
),
bounds as (
  select
    now_local,
    date_trunc('day', now_local)                           as today_local_start,
    date_trunc('day', now_local) - interval '7 days'       as start_7d,
    date_trunc('day', now_local) - interval '28 days'      as start_28d
  from now_mnl
),

-- --------------------------
-- Normalize sessions with minutes
-- --------------------------
sessions_norm as (
  select
    s.user_id,
    s.coach_key,
    s.started_at,
    s.ended_at,
    greatest(
      coalesce(s.duration_sec, 0)::numeric / 60.0,
      case
        when s.started_at is not null and s.ended_at is not null
          then extract(epoch from (s.ended_at - s.started_at)) / 60.0
        else 0
      end
    ) as minutes,
    coalesce(s.ended_at, s.started_at) as finished_at
  from public.sessions s
),

-- --------------------------
-- Normalize attempts and join drill meta
-- --------------------------
attempts_norm as (
  select
    s.user_id,
    a.drill_id,
    d.coach_key,
    coalesce(
      to_jsonb(d)->>'topic',
      to_jsonb(d)->>'title',
      to_jsonb(d)->>'name',
      to_jsonb(d)->>'slug',
      'drill-'||d.id::text
    )                                 as topic,
    a.created_at                      as submitted_at,
    a.score::numeric                  as score,
    s.words_per_minute::numeric       as wpm,
    case
      when a.score is null then null
      when a.score > 1 then a.score >= 70
      else a.score >= 0.7
    end                               as passed
  from public.attempts a
  join public.sessions s on s.id = a.session_id
  left join public.drills d on d.id = a.drill_id
),

-- --------------------------
-- Windowed aggregates from SESSIONS
-- --------------------------
sess_rollups as (
  select
    p.id as user_id,

    -- All-time minutes
    coalesce(sum(sn.minutes), 0)::numeric(12,2) as minutes_all,

    -- 28d window (Manila)
    coalesce(
      sum(sn.minutes) filter (
        where sn.started_at at time zone (select tz_name from tz)
              >= (select start_28d from bounds)
      ),
      0
    )::numeric(12,2) as minutes_28d,

    -- 7d window (Manila)
    coalesce(
      sum(sn.minutes) filter (
        where sn.started_at at time zone (select tz_name from tz)
              >= (select start_7d from bounds)
      ),
      0
    )::numeric(12,2) as minutes_7d,

    max(sn.finished_at) as last_session_at
  from public.profiles p
  left join sessions_norm sn on sn.user_id = p.id
  group by p.id
),

-- --------------------------
-- Windowed aggregates from ATTEMPTS
-- --------------------------
att_rollups as (
  select
    p.id as user_id,

    -- All-time attempts
    count(an.*) as attempts_all,

    -- 28d attempts (Manila)
    count(an.*) filter (
      where an.submitted_at at time zone (select tz_name from tz)
            >= (select start_28d from bounds)
    ) as attempts_28d,

    -- 7d attempts (Manila)
    count(an.*) filter (
      where an.submitted_at at time zone (select tz_name from tz)
            >= (select start_7d from bounds)
    ) as attempts_7d,

    -- Distinct active days in 7d (Manila)
    count(distinct date_trunc('day', an.submitted_at at time zone (select tz_name from tz))) filter (
      where an.submitted_at at time zone (select tz_name from tz)
            >= (select start_7d from bounds)
    ) as days_active_7d,

    -- Scoring aggregates (28d)
    avg(an.score) filter (
      where an.submitted_at at time zone (select tz_name from tz)
            >= (select start_28d from bounds)
    )::numeric(6,3) as avg_score_28d,

    avg(an.wpm) filter (
      where an.submitted_at at time zone (select tz_name from tz)
            >= (select start_28d from bounds)
    )::numeric(6,2) as avg_wpm_28d,

    sum(case when an.passed is true then 1 else 0 end) filter (
      where an.submitted_at at time zone (select tz_name from tz)
            >= (select start_28d from bounds)
    ) as passes_28d,

    case
      when count(*) filter (
        where an.submitted_at at time zone (select tz_name from tz)
              >= (select start_28d from bounds)
      ) > 0
      then (
        sum(case when an.passed is true then 1 else 0 end) filter (
          where an.submitted_at at time zone (select tz_name from tz)
                >= (select start_28d from bounds)
        )::numeric
        /
        count(*) filter (
          where an.submitted_at at time zone (select tz_name from tz)
                >= (select start_28d from bounds)
        )::numeric
      )
      else null
    end as pass_rate_28d,

    max(an.submitted_at) as last_attempt_at
  from public.profiles p
  left join attempts_norm an on an.user_id = p.id
  group by p.id
),

-- --------------------------
-- Recent coach/topic signals (28d)
-- --------------------------
recent_focus as (
  select
    an.user_id,

    -- Top coach in the last 28d (by attempt count)
    (
      select an2.coach_key
      from attempts_norm an2
      where an2.user_id = an.user_id
        and an2.submitted_at at time zone (select tz_name from tz)
              >= (select start_28d from bounds)
      group by an2.coach_key
      order by count(*) desc nulls last
      limit 1
    ) as top_coach_id_28d,

    -- Top topic in the last 28d
    (
      select an3.topic
      from attempts_norm an3
      where an3.user_id = an.user_id
        and an3.submitted_at at time zone (select tz_name from tz)
              >= (select start_28d from bounds)
      group by an3.topic
      order by count(*) desc nulls last
      limit 1
    ) as top_topic_28d
  from attempts_norm an
  group by an.user_id
),

-- --------------------------
-- Profile base (tier + active coach)
-- --------------------------
profile_base as (
  select
    p.id                               as user_id,
    p.email,
    p.full_name,
    p.active_coach_key                 as active_coach_id,
    p.tier::text                       as tier_current,
    p.created_at                       as user_created_at
  from public.profiles p
)

select
  pb.user_id,
  pb.email,
  pb.full_name,
  pb.user_created_at,

  -- active selections
  pb.active_coach_id,
  pb.tier_current,

  -- session minutes
  sr.minutes_all,
  sr.minutes_28d,
  sr.minutes_7d,

  -- attempts and activity
  ar.attempts_all,
  ar.attempts_28d,
  ar.attempts_7d,
  ar.days_active_7d,

  -- performance (28d)
  ar.avg_score_28d,
  ar.avg_wpm_28d,
  ar.passes_28d,
  ar.pass_rate_28d,

  -- recency
  greatest(ar.last_attempt_at, sr.last_session_at) as last_activity_at,

  -- focus
  rf.top_coach_id_28d,
  rf.top_topic_28d
from profile_base pb
left join sess_rollups sr on sr.user_id = pb.user_id
left join att_rollups  ar on ar.user_id = pb.user_id
left join recent_focus rf on rf.user_id = pb.user_id
order by last_activity_at desc nulls last, minutes_28d desc nulls last;

comment on view public.v_user_progress is
  'Per-user progress with Manila day boundary: minutes, attempts, 7d/28d windows, pass rate, and recent coach/topic.';
