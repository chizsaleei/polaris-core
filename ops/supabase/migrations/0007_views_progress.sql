-- =====================================================================
-- 0007_views_progress.sql
-- Polaris Core: progress and analytics views using Manila day boundary
-- =====================================================================
-- Prereqs:
-- - public.profiles
-- - public.sessions  (id, user_id, coach_key, started_at, ended_at)
-- - public.attempts  (id, session_id, drill_id, coach_key, score, created_at, plus either:
--                     metrics jsonb with key "wpm" OR words_per_minute numeric)
--   Note: user_id comes via sessions.id = attempts.session_id
-- - public.drills    (id, coach_key, ... arbitrary columns like title/name/slug/skill/etc.)
-- Notes:
-- - We DROP existing views first to avoid column-name mismatch errors.
-- - Minutes are computed from timestamps rather than a stored duration.
-- - WPM is read in a schema-agnostic way:
--     coalesce( (to_jsonb(a)->'metrics'->>'wpm')::numeric,
--               (to_jsonb(a)->>'words_per_minute')::numeric )
-- - We avoid referencing a specific drills column like d.topic. Instead we build a label:
--     coalesce(to_jsonb(d)->>'topic', to_jsonb(d)->>'title', to_jsonb(d)->>'name',
--              to_jsonb(d)->>'slug', 'drill-'||d.id::text)
-- =====================================================================

-- Clean up existing views
drop view if exists public.v_activity_30d_mnl cascade;
drop view if exists public.v_up_next_simple cascade;
drop view if exists public.v_user_rubric_trends_weekly cascade;
drop view if exists public.v_user_weekly_card_mnl cascade;
drop view if exists public.v_user_daily_sessions_mnl cascade;
drop view if exists public.v_user_progress cascade;

-- Helper: Manila local date
create or replace function public.mnl_date(ts timestamptz)
returns date
language sql
stable
as $$
  select (ts at time zone 'Asia/Manila')::date
$$;

comment on function public.mnl_date is
  'Returns the Asia/Manila local calendar date for a given timestamptz.';

-- View: v_user_daily_sessions_mnl
create or replace view public.v_user_daily_sessions_mnl as
with base as (
  select
    s.user_id,
    s.coach_key,
    public.mnl_date(coalesce(s.ended_at, s.started_at)) as day_mnl,
    greatest(
      0,
      extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))
    )::bigint as sess_sec
  from public.sessions s
),
attempts_per_day as (
  select
    s.user_id,
    s.coach_key,
    public.mnl_date(a.created_at) as day_mnl,
    count(a.id) as attempts_count
  from public.attempts a
  join public.sessions s on s.id = a.session_id
  group by 1,2,3
)
select
  b.user_id,
  b.coach_key,
  b.day_mnl,
  count(*) as sessions_count,
  round(sum(b.sess_sec)::numeric / 60.0, 2) as minutes_total,
  coalesce(apd.attempts_count, 0) as attempts_total
from base b
left join attempts_per_day apd
  on apd.user_id = b.user_id
 and apd.coach_key = b.coach_key
 and apd.day_mnl = b.day_mnl
group by b.user_id, b.coach_key, b.day_mnl, apd.attempts_count;

comment on view public.v_user_daily_sessions_mnl is
  'Daily sessions per user and coach with Manila day boundary. Includes minutes and attempts.';

-- View: v_user_weekly_card_mnl
create or replace view public.v_user_weekly_card_mnl as
with days as (
  select
    s.user_id,
    public.mnl_date(a.created_at) as day_mnl,
    s.coach_key,
    count(a.id) as attempts_count
  from public.attempts a
  join public.sessions s on s.id = a.session_id
  where a.created_at >= (now() - interval '7 days')
  group by 1,2,3
),
mins as (
  select
    s.user_id,
    public.mnl_date(coalesce(s.ended_at, s.started_at)) as day_mnl,
    s.coach_key,
    greatest(
      0,
      extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))
    )::bigint as sess_sec
  from public.sessions s
  where coalesce(s.ended_at, s.started_at) >= (now() - interval '7 days')
),
topics as (
  select
    s.user_id,
    coalesce(
      to_jsonb(d)->>'topic',
      to_jsonb(d)->>'title',
      to_jsonb(d)->>'name',
      to_jsonb(d)->>'slug',
      'drill-'||d.id::text
    ) as topic_label,
    count(*) as c
  from public.attempts a
  join public.sessions s on s.id = a.session_id
  join public.drills d on d.id = a.drill_id
  where a.created_at >= (now() - interval '7 days')
  group by 1,2
),
ranked_topics as (
  select
    t.*,
    row_number() over (partition by user_id order by c desc, topic_label) as rn
  from topics t
),
top_topics as (
  select
    user_id,
    string_agg(topic_label, ', ' order by c desc) filter (where rn <= 3) as top_topics_7d
  from ranked_topics
  group by user_id
)
select
  u.user_id,
  min(u.day_mnl) as week_start_mnl,
  max(u.day_mnl) as week_end_mnl,
  sum(u.attempts_count) as attempts_7d,
  round(sum(coalesce(m.sess_sec,0))::numeric / 60.0, 2) as minutes_7d,
  coalesce(tt.top_topics_7d, '') as top_topics_7d
from days u
left join mins m
  on m.user_id = u.user_id
 and m.day_mnl = u.day_mnl
 and m.coach_key = u.coach_key
left join top_topics tt
  on tt.user_id = u.user_id
group by u.user_id, tt.top_topics_7d;

comment on view public.v_user_weekly_card_mnl is
  'Weekly card for the last 7 days per user with attempts, minutes, and simple top topics.';

-- View: v_user_progress
create or replace view public.v_user_progress as
with sess as (
  select
    s.user_id,
    count(*) as sessions_count,
    round(
      sum(
        greatest(0, extract(epoch from (coalesce(s.ended_at, now()) - s.started_at)))::bigint
      )::numeric / 60.0,
      2
    ) as minutes_total,
    max(coalesce(s.ended_at, s.started_at)) as last_active_at
  from public.sessions s
  group by 1
),
att as (
  select
    s.user_id,
    count(*) as attempts_count,
    avg(
      coalesce(
        nullif((to_jsonb(a)->'metrics'->>'wpm')::numeric, 0),
        nullif((to_jsonb(a)->>'words_per_minute')::numeric, 0)
      )
    ) as avg_wpm,
    avg(a.score) as avg_score
  from public.attempts a
  join public.sessions s on s.id = a.session_id
  group by 1
),
first_last as (
  select
    s.user_id,
    min(public.mnl_date(a.created_at)) as first_day_mnl,
    max(public.mnl_date(a.created_at)) as last_day_mnl
  from public.attempts a
  join public.sessions s on s.id = a.session_id
  group by 1
)
select
  p.id as user_id,
  coalesce(s.sessions_count, 0) as sessions_count,
  coalesce(s.minutes_total, 0) as minutes_total,
  coalesce(a.attempts_count, 0) as attempts_count,
  coalesce(a.avg_wpm, 0) as avg_wpm,
  coalesce(a.avg_score, 0) as avg_score,
  fl.first_day_mnl,
  fl.last_day_mnl,
  s.last_active_at
from public.profiles p
left join sess s on s.user_id = p.id
left join att  a on a.user_id = p.id
left join first_last fl on fl.user_id = p.id;

comment on view public.v_user_progress is
  'Lifetime user progress including sessions, minutes, attempts, average WPM, and last activity.';

-- View: v_user_rubric_trends_weekly
create or replace view public.v_user_rubric_trends_weekly as
select
  s.user_id,
  s.coach_key,
  date_trunc('week', (a.created_at at time zone 'Asia/Manila'))::date as week_start_mnl,
  count(*) as attempts_count,
  avg(a.score) as avg_score,
  avg(
    coalesce(
      nullif((to_jsonb(a)->'metrics'->>'wpm')::numeric, 0),
      nullif((to_jsonb(a)->>'words_per_minute')::numeric, 0)
    )
  ) as avg_wpm
from public.attempts a
join public.sessions s on s.id = a.session_id
group by 1,2,3
order by user_id, coach_key, week_start_mnl;

comment on view public.v_user_rubric_trends_weekly is
  'Weekly average score and WPM per user and coach using Manila weeks.';

-- View: v_up_next_simple
create or replace view public.v_up_next_simple as
with topic_perf as (
  select
    s.user_id,
    s.coach_key,
    coalesce(
      to_jsonb(d)->>'topic',
      to_jsonb(d)->>'title',
      to_jsonb(d)->>'name',
      to_jsonb(d)->>'slug',
      'drill-'||d.id::text
    ) as topic_label,
    count(*) as n,
    avg(a.score) as avg_score
  from public.attempts a
  join public.sessions s on s.id = a.session_id
  join public.drills d on d.id = a.drill_id
  group by 1,2,3
),
ranked as (
  select
    tp.*,
    row_number() over (partition by user_id, coach_key order by avg_score asc, n desc, topic_label) as rn
  from topic_perf tp
)
select
  user_id,
  coach_key,
  topic_label as suggested_topic,
  n as attempts_on_topic,
  round(coalesce(avg_score, 0)::numeric, 3) as avg_score
from ranked
where rn <= 5
order by user_id, coach_key, avg_score asc, attempts_on_topic desc;

comment on view public.v_up_next_simple is
  'Simple next step suggestions per user and coach based on lowest average topic score.';

-- Convenience: v_activity_30d_mnl
create or replace view public.v_activity_30d_mnl as
select
  s.user_id,
  public.mnl_date(coalesce(s.ended_at, s.started_at)) as day_mnl,
  count(*) as sessions_count,
  round(
    sum(
      greatest(0, extract(epoch from (coalesce(s.ended_at, now()) - s.started_at)))::bigint
    )::numeric / 60.0,
    2
  ) as minutes_total
from public.sessions s
where coalesce(s.ended_at, s.started_at) >= (now() - interval '30 days')
group by 1,2
order by user_id, day_mnl;

comment on view public.v_activity_30d_mnl is
  'Sessions and minutes per user for the last 30 days using Manila day boundary.';
