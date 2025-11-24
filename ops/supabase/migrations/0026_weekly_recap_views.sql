-- ===============================================================
-- 0026_weekly_recap_views.sql
-- Weekly recap views for users, aligned to Manila time.
-- Produces per-user weekly minutes, attempts, average scores,
-- and top "topics" (using drills.type) to power Weekly Card and emails.
--
-- Assumes existing tables:
--   public.profiles(id)
--   public.sessions(
--     id,
--     user_id,
--     coach_key,
--     started_at timestamptz,
--     ended_at   timestamptz
--   )
--   public.attempts(
--     id,
--     session_id,
--     drill_id,
--     coach_key,
--     created_at timestamptz
--     -- plus result_score (added here if missing)
--   )
--   public.drills(
--     id,
--     type public.drill_type,
--     difficulty text
--     -- and other fields
--   )
--
-- Date: 2025-11-14
-- ===============================================================

-- ---------- Helper: Manila-local week bucket (week starts Monday) ----------
create or replace function public.manila_week_start(p_ts timestamptz)
returns date
language sql
immutable
as $fn$
  select (date_trunc('week', timezone('Asia/Manila', p_ts)))::date
$fn$;

comment on function public.manila_week_start is
'Returns the Monday date of the week for a given timestamp using Asia/Manila timezone.';

-- ===============================================================
-- Ensure attempts.result_score exists and backfill best effort
-- ===============================================================
alter table if exists public.attempts
  add column if not exists result_score numeric;

do $$
begin
  -- If a legacy "score" column exists, copy it into result_score where empty
  begin
    update public.attempts
    set result_score = score
    where result_score is null;
  exception
    when undefined_column then
      null;
  end;

  -- If a legacy "rating" column exists, copy it into result_score where still empty
  begin
    update public.attempts
    set result_score = rating
    where result_score is null;
  exception
    when undefined_column then
      null;
  end;
end $$;

-- ===============================================================
-- Base view: per-session minutes in Manila week
-- ===============================================================
create or replace view public.v_user_weekly_minutes as
with s as (
  select
    user_id,
    public.manila_week_start(coalesce(ended_at, started_at)) as week_start,
    greatest(
      0,
      coalesce(extract(epoch from (ended_at - started_at))::int, 0)
    ) as seconds_in_session
  from public.sessions
)
select
  user_id,
  week_start,
  sum(seconds_in_session)::int as total_seconds,
  round(sum(seconds_in_session)::numeric / 60.0, 1) as total_minutes,
  count(*) as sessions_count
from s
group by user_id, week_start;

comment on view public.v_user_weekly_minutes is
'Aggregates session minutes and session count per user per Manila-local week.';

-- ===============================================================
-- Base view: per-attempt stats in Manila week
-- Attempts represent graded drill submissions.
-- We derive user_id via sessions because attempts has session_id, not user_id.
-- ===============================================================
create or replace view public.v_user_weekly_attempts as
with a_user as (
  select
    s.user_id,
    public.manila_week_start(a.created_at) as week_start,
    a.result_score
  from public.attempts a
  join public.sessions s on s.id = a.session_id
)
select
  user_id,
  week_start,
  count(*) as attempts_count,
  round(avg(result_score)::numeric, 2) as avg_score
from a_user
group by user_id, week_start;

comment on view public.v_user_weekly_attempts is
'Counts drill attempts and averages result_score per user per Manila-local week.';

-- ===============================================================
-- Base view: top "topics" this week (by attempts)
-- Uses drills.type (enum drill_type) as a topic-like label.
-- Produces up to top 3 types per user-week.
-- ===============================================================
create or replace view public.v_user_weekly_topics as
with atp as (
  select
    s.user_id,
    public.manila_week_start(a.created_at) as week_start,
    d.type::text as topic,
    count(*) as c,
    max(a.created_at) as last_seen
  from public.attempts a
  join public.sessions s on s.id = a.session_id
  left join public.drills d on d.id = a.drill_id
  group by s.user_id, public.manila_week_start(a.created_at), d.type
),
ranked as (
  select
    user_id,
    week_start,
    topic,
    c,
    last_seen,
    row_number() over (
      partition by user_id, week_start
      order by c desc nulls last, last_seen desc nulls last, topic nulls last
    ) as rn
  from atp
)
select
  user_id,
  week_start,
  array_remove(
    array_agg(topic order by rn) filter (where rn <= 3),
    null
  ) as top_topics
from ranked
where rn <= 3
group by user_id, week_start;

comment on view public.v_user_weekly_topics is
'Top three drill types practiced per user-week, based on attempt counts.';

-- ===============================================================
-- Convenience: per-coach weekly activity
-- ===============================================================
create or replace view public.v_user_weekly_by_coach as
with s as (
  select
    user_id,
    coach_key,
    public.manila_week_start(coalesce(ended_at, started_at)) as week_start,
    greatest(
      0,
      coalesce(extract(epoch from (ended_at - started_at))::int, 0)
    ) as seconds_in_session
  from public.sessions
)
select
  user_id,
  coach_key,
  week_start,
  sum(seconds_in_session)::int as total_seconds,
  round(sum(seconds_in_session)::numeric / 60.0, 1) as total_minutes,
  count(*) as sessions_count
from s
group by user_id, coach_key, week_start;

comment on view public.v_user_weekly_by_coach is
'Breaks out weekly minutes and sessions per coach for a user.';

-- ===============================================================
-- Final recap view: the Weekly Card
-- Joins minutes, attempts, and topics.
-- ===============================================================
create or replace view public.v_user_weekly_recap as
select
  p.id as user_id,
  w.week_start,
  coalesce(w.total_minutes, 0) as total_minutes,
  coalesce(w.sessions_count, 0) as sessions_count,
  coalesce(a.attempts_count, 0) as attempts_count,
  a.avg_score,
  t.top_topics
from public.profiles p
left join public.v_user_weekly_minutes w
  on w.user_id = p.id
left join public.v_user_weekly_attempts a
  on a.user_id = p.id
 and a.week_start = w.week_start
left join public.v_user_weekly_topics t
  on t.user_id = p.id
 and t.week_start = w.week_start;

comment on view public.v_user_weekly_recap is
'Weekly recap metrics per user: minutes, sessions, attempts, avg_score, top_topics.';

-- ===============================================================
-- Optional materialized view for faster dashboards
-- ===============================================================
-- drop materialized view if exists public.mv_user_weekly_recap;
-- create materialized view public.mv_user_weekly_recap as
--   select * from public.v_user_weekly_recap;
-- create index if not exists ix_mv_user_weekly_recap_user_week
--   on public.mv_user_weekly_recap(user_id, week_start);

-- ===============================================================
-- Helpful indexes for time-bucketed queries
-- ===============================================================

-- Sessions: index by Manila week and user
create index if not exists ix_sessions_week_user
  on public.sessions (
    public.manila_week_start(coalesce(ended_at, started_at)),
    user_id
  );

-- Attempts: index by Manila week and session_id to support join to sessions
create index if not exists ix_attempts_week_session
  on public.attempts (
    public.manila_week_start(created_at),
    session_id
  );

-- Done
