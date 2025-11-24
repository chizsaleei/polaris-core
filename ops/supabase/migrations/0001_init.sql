-- Polaris Core – Initial schema (Supabase/Postgres)
-- Scope: PayPal + PayMongo billing, provider-agnostic entitlements, RLS first.
-- Apply as first migration.

-- ============ EXTENSIONS ============
create extension if not exists pgcrypto;
create extension if not exists pg_trgm;
create extension if not exists pg_stat_statements;
create extension if not exists plpgsql;
-- Supabase exposes pg_cron under the "extensions" schema
create extension if not exists pg_cron with schema extensions;

-- ============ ENUMS ============
create type tier_plan as enum ('free','pro','vip');
create type payment_provider as enum ('paymongo','paypal');
create type entitlement_status as enum ('active','canceled','expired','past_due');
create type payment_status as enum (
  'pending','webhook_received','webhook_rejected',
  'entitlement_granted','entitlement_revoked','error'
);
create type session_status as enum ('started','submitted','completed','aborted');
create type drill_type as enum ('speaking','scenario','qbank','feedback','rubric');
create type item_state as enum ('draft','auto_qa','in_review','approved','published','deprecated');
create type expression_state as enum ('private_user','candidate_exemplar','published_exemplar','deprecated');
create type user_role as enum ('user','admin');
create type event_type as enum (
  'onboarding_completed','coach_selected','practice_started','practice_submitted','feedback_viewed',
  'vocab_saved','day_completed','plan_upgraded','payment_status','coach_switched','drill_opened'
);

-- ============ TABLES ============

-- Profiles 1:1 with auth.users
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  full_name text,
  profession text,
  goals text,
  domains text[],
  country text,
  language text,
  preferred_difficulty smallint check (preferred_difficulty between 1 and 5),
  tier tier_plan not null default 'free',
  role user_role not null default 'user',
  active_coach_key text,
  coach_cooldown_ends_at timestamptz
);

create table if not exists public.coaches (
  key text primary key,
  display_name text not null,
  tagline text,
  audience text,
  benefits text,
  tools text[],
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rubrics (
  id uuid primary key default gen_random_uuid(),
  coach_key text references public.coaches(key) on delete set null,
  title text not null,
  version text not null default 'v1',
  spec jsonb not null,
  state item_state not null default 'approved',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.catalogs (
  id uuid primary key default gen_random_uuid(),
  coach_key text references public.coaches(key) on delete cascade,
  title text not null,
  description text,
  tags jsonb,
  state item_state not null default 'approved',
  is_public boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_catalogs_coach on public.catalogs(coach_key);

create table if not exists public.drills (
  id uuid primary key default gen_random_uuid(),
  catalog_id uuid references public.catalogs(id) on delete cascade,
  coach_key text references public.coaches(key) on delete cascade,
  type drill_type not null,
  title text not null,
  prompt text not null,
  tags jsonb,
  time_estimate_minutes int,
  difficulty smallint check (difficulty between 1 and 5),
  gating boolean not null default false,
  rubric_id uuid references public.rubrics(id) on delete set null,
  state item_state not null default 'approved',
  is_public boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_drills_coach_type on public.drills(coach_key, type);
create index if not exists idx_drills_public on public.drills(is_public, state);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  coach_key text references public.coaches(key) on delete set null,
  tier tier_plan not null,
  status session_status not null default 'started',
  tool_used text,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  ended_at timestamptz,
  duration_sec int,
  score numeric,
  words_per_minute numeric,
  notes text
);
create index if not exists idx_sessions_user_time on public.sessions(user_id, started_at desc);

create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  drill_id uuid references public.drills(id) on delete set null,
  prompt text not null,
  response text,
  feedback jsonb,
  wins text[],
  fixes text[],
  next_prompt text,
  score int,
  created_at timestamptz not null default now()
);
create index if not exists idx_attempts_session on public.attempts(session_id);

create table if not exists public.expressions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  source_attempt_id uuid references public.attempts(id) on delete set null,
  text_original text not null,
  text_upgraded text,
  collocations text[],
  pronunciation jsonb,
  examples text[],
  state expression_state not null default 'private_user',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_expressions_user on public.expressions(user_id);

create table if not exists public.spaced_review_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  expression_id uuid not null references public.expressions(id) on delete cascade,
  next_review_at timestamptz not null,
  interval_days int not null default 1,
  ease_factor numeric not null default 2.5,
  repetitions int not null default 0,
  suspended boolean not null default false,
  unique(user_id, expression_id)
);

create table if not exists public.weekly_recaps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  week_start_date date not null,
  summary jsonb not null,
  next_drills jsonb not null,
  created_at timestamptz not null default now(),
  unique(user_id, week_start_date)
);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider payment_provider not null,
  plan tier_plan not null,
  status entitlement_status not null default 'active',
  current_coach_key text,
  session_minutes_per_day int,
  tools_limit int,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  cancel_at timestamptz,
  latest_event_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_entitlements_user on public.entitlements(user_id);

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider payment_provider not null,
  provider_event_id text not null,
  user_id uuid references public.profiles(id) on delete set null,
  subscription_ref text,
  plan tier_plan,
  status payment_status not null,
  hmac_verified boolean not null default false,
  payload jsonb not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(provider, provider_event_id)
);

create table if not exists public.reconciliation_jobs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  details jsonb
);

create table if not exists public.affiliates (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  owner_user_id uuid references public.profiles(id) on delete set null,
  pct numeric not null default 10.0,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists public.referral_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount_cents int not null,
  status text not null default 'pending',
  granted_for text not null,
  payment_event_id uuid references public.payment_events(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  d date not null,
  minutes_used int not null default 0,
  drills_done int not null default 0,
  expressions_saved int not null default 0,
  unique(user_id, d)
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  type event_type not null,
  coach_key text,
  domain text,
  topic text,
  difficulty smallint,
  tier tier_plan,
  country text,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  rollout jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete set null,
  target_table text not null,
  target_id uuid not null,
  reason text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  handled_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  table_name text not null,
  row_id uuid,
  patch jsonb,
  created_at timestamptz not null default now()
);

-- Support tickets (optional but useful)
create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject text not null,
  state text not null default 'open',        -- open, pending, closed
  priority text not null default 'normal',   -- low, normal, high, urgent
  category text default 'other',
  tags text[] default '{}',
  last_message_at timestamptz,
  sla_due_at timestamptz,
  meta jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_tickets_user on public.tickets(user_id);
create index if not exists idx_tickets_lastmsg on public.tickets(last_message_at desc);

create table if not exists public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  author_type text not null,                 -- user, staff, system
  author_id uuid,
  body_text text not null,
  attachments jsonb default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_ticket_messages_ticket on public.ticket_messages(ticket_id);

-- ============ SEED – Coaches ============
insert into public.coaches(key, display_name, tagline, audience, benefits, tools) values
('chase_krashen','Chase Krashen','Academic English and exam strategist','Pre-college','Study skills, exam strategies','{DrillRunner,ShadowingPlayer,PronunciationHeatmap}'),
('dr_claire_swales','Dr. Claire Swales','Graduate admissions communicator','Applicants to MA/PhD','SOP, LoR, interview drills','{DrillRunner,FeedbackStudio}'),
('carter_goleman','Carter Goleman','Professional interview communicator','Job seekers','STAR stories, mock interviews','{DrillRunner,ShadowingPlayer}'),
('chelsea_lightbown','Chelsea Lightbown','English proficiency coach','IELTS/TOEFL/ESL','Band-raising speaking tasks','{DrillRunner,PronunciationHeatmap}'),
('dr_clark_atul','Dr. Clark Atul','Medical communication and exams','Physicians','SBAR, SOAP, MRCP-style drills','{DrillRunner}'),
('dr_crystal_benner','Dr. Crystal Benner','Nursing communication and exam','Nurses','Handoff, patient education','{DrillRunner}'),
('christopher_buffett','Christopher Buffett','Financial English and certification','Finance professionals','Case writing, CFA-style Qs','{DrillRunner}'),
('colton_covey','Colton Covey','Business English and leadership','Managers and leaders','Briefing, feedback, negotiation','{DrillRunner}'),
('cody_turing','Cody Turing','Technical English and certification','IT and cybersecurity','Explainers, incident roles','{DrillRunner}'),
('chloe_sinek','Chloe Sinek','Personal development and vision','General learners','Vision scripts, affirmations','{DrillRunner}')
on conflict (key) do nothing;

-- ============ VIEWS ============
create or replace view public.v_drill_stats as
select d.id as drill_id,
       d.coach_key,
       count(distinct s.id) filter (where s.status in ('submitted','completed')) as sessions,
       count(a.id) as attempts,
       avg(a.score) as avg_attempt_score,
       avg(s.score) as avg_session_score,
       avg(s.duration_sec) as avg_session_duration_sec,
       coalesce(sum((r.status = 'open')::int),0) as report_open_count
from public.drills d
left join public.sessions s on s.coach_key = d.coach_key and s.status in ('submitted','completed')
left join public.attempts a on a.drill_id = d.id
left join public.reports r on r.target_table = 'drills' and r.target_id = d.id
where d.state in ('approved','published') and d.is_public = true
group by d.id, d.coach_key;

create or replace view public.v_user_progress as
select p.id as user_id,
       p.full_name,
       p.tier,
       count(distinct s.id) as sessions,
       count(a.id) as attempts,
       avg(a.score) as avg_score,
       coalesce(sum(du.minutes_used),0) as total_minutes,
       coalesce(sum(du.drills_done),0) as drills_done,
       coalesce(sum(du.expressions_saved),0) as expressions_saved
from public.profiles p
left join public.sessions s on s.user_id = p.id and s.status in ('submitted','completed')
left join public.attempts a on a.session_id = s.id
left join public.daily_usage du on du.user_id = p.id
group by p.id, p.full_name, p.tier;

-- ============ FUNCTIONS (RPC) ============

-- Event logger
create or replace function public.log_event(e event_type, meta jsonb default '{}')
returns void language plpgsql security definer as $$
begin
  insert into public.events(user_id, type, metadata, created_at)
  values (auth.uid(), e, coalesce(meta,'{}'::jsonb), now());
end$$;
grant execute on function public.log_event(event_type, jsonb) to authenticated;

-- Update profile basics
create or replace function public.rpc_update_profile(
  p_full_name text,
  p_profession text,
  p_goals text,
  p_domains text[],
  p_preferred_difficulty smallint
) returns public.profiles
language plpgsql security definer as $$
declare v public.profiles; begin
  update public.profiles set
    full_name = p_full_name,
    profession = p_profession,
    goals = p_goals,
    domains = p_domains,
    preferred_difficulty = p_preferred_difficulty,
    updated_at = now()
  where id = auth.uid()
  returning * into v;
  return v;
end$$;
grant execute on function public.rpc_update_profile(text,text,text,text[],smallint) to authenticated;

-- Start a session
create or replace function public.rpc_start_session(
  p_coach_key text,
  p_tier tier_plan,
  p_tool_used text default null
) returns public.sessions
language plpgsql security definer as $$
declare v public.sessions; begin
  insert into public.sessions(user_id, coach_key, tier, status, tool_used)
  values (auth.uid(), p_coach_key, p_tier, 'started', p_tool_used)
  returning * into v;
  insert into public.daily_usage(user_id, d) values (auth.uid(), current_date)
  on conflict (user_id, d) do nothing;
  perform public.log_event('practice_started','{}');
  return v;
end$$;
grant execute on function public.rpc_start_session(text, tier_plan, text) to authenticated;

-- Finish a session
create or replace function public.rpc_finish_session(
  p_session_id uuid,
  p_score numeric,
  p_duration_sec int,
  p_wpm numeric default null
) returns public.sessions
language plpgsql security definer as $$
declare v public.sessions; begin
  update public.sessions set
    status = 'completed',
    submitted_at = coalesce(submitted_at, now()),
    ended_at = now(),
    score = p_score,
    duration_sec = p_duration_sec,
    words_per_minute = p_wpm
  where id = p_session_id and user_id = auth.uid()
  returning * into v;

  update public.daily_usage set
    minutes_used = minutes_used + greatest(1, ceil(p_duration_sec/60.0)::int),
    drills_done = drills_done + 1
  where user_id = auth.uid() and d = current_date;

  perform public.log_event('practice_submitted','{}');
  return v;
end$$;
grant execute on function public.rpc_finish_session(uuid, numeric, int, numeric) to authenticated;

-- Deterministic daily selection (fixed to return exactly drills columns)
create or replace function public.rpc_practice_now(
  p_limit int default 5
) returns setof public.drills
language sql security definer as $$
  select d.*
  from public.drills d
  where d.is_public = true and d.state in ('approved','published')
  order by md5(auth.uid()::text || current_date::text || d.id::text)
  limit p_limit;
$$;
grant execute on function public.rpc_practice_now(int) to authenticated;

-- Weekly pack
create or replace function public.rpc_get_weekly_pack()
returns jsonb language plpgsql security definer as $$
declare out jsonb; begin
  with agg as (
    select coalesce(sum(du.minutes_used),0) as minutes,
           coalesce(sum(du.drills_done),0) as drills,
           coalesce(sum(du.expressions_saved),0) as expressions
    from public.daily_usage du
    where du.user_id = auth.uid() and du.d >= current_date - interval '7 days'
  )
  select jsonb_build_object(
    'summary', jsonb_build_object('minutes', a.minutes, 'drills', a.drills, 'expressions', a.expressions),
    'next', jsonb_build_object('drills', (select jsonb_agg(id) from public.rpc_practice_now(5)))
  ) into out from agg a;
  return out;
end$$;
grant execute on function public.rpc_get_weekly_pack() to authenticated;

-- Save Expressions Pack
create or replace function public.rpc_save_expressions_pack(p_items jsonb)
returns int language plpgsql security definer as $$
declare c int; begin
  insert into public.expressions(user_id, source_attempt_id, text_original, text_upgraded, collocations, pronunciation, examples)
  select auth.uid(),
         (item->>'source_attempt_id')::uuid,
         item->>'text_original',
         item->>'text_upgraded',
         array(select jsonb_array_elements_text(coalesce(item->'collocations','[]'::jsonb))),
         item->'pronunciation',
         array(select jsonb_array_elements_text(coalesce(item->'examples','[]'::jsonb)))
  from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) as item;
  get diagnostics c = row_count;
  perform public.log_event('vocab_saved','{}');
  return c;
end$$;
grant execute on function public.rpc_save_expressions_pack(jsonb) to authenticated;

-- ============ RLS ============

alter table public.profiles enable row level security;
alter table public.coaches enable row level security;
alter table public.rubrics enable row level security;
alter table public.catalogs enable row level security;
alter table public.drills enable row level security;
alter table public.sessions enable row level security;
alter table public.attempts enable row level security;
alter table public.expressions enable row level security;
alter table public.spaced_review_queue enable row level security;
alter table public.weekly_recaps enable row level security;
alter table public.entitlements enable row level security;
alter table public.payment_events enable row level security;
alter table public.reconciliation_jobs enable row level security;
alter table public.affiliates enable row level security;
alter table public.referral_credits enable row level security;
alter table public.daily_usage enable row level security;
alter table public.events enable row level security;
alter table public.feature_flags enable row level security;
alter table public.settings enable row level security;
alter table public.reports enable row level security;
alter table public.audit_logs enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;

-- Helpers
create or replace function public.is_admin() returns boolean language sql stable as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin');
$$;

-- Profiles
create policy "profiles_self_select" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "profiles_self_update" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy "profiles_self_insert" on public.profiles for insert with check (id = auth.uid());

-- Readable public catalogs and admin write
create policy "coaches_public_read" on public.coaches for select using (true);
create policy "coaches_admin_write" on public.coaches for all using (public.is_admin()) with check (public.is_admin());

create policy "rubrics_public_read" on public.rubrics for select using (state in ('approved','published'));
create policy "rubrics_admin_write" on public.rubrics for all using (public.is_admin()) with check (public.is_admin());

create policy "catalogs_public_read" on public.catalogs for select using (is_public = true and state in ('approved','published'));
create policy "catalogs_admin_write" on public.catalogs for all using (public.is_admin()) with check (public.is_admin());

create policy "drills_public_read" on public.drills for select using (is_public = true and state in ('approved','published'));
create policy "drills_admin_write" on public.drills for all using (public.is_admin()) with check (public.is_admin());

-- User owned
create policy "sessions_owner" on public.sessions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "attempts_via_session" on public.attempts for all using (
  exists(select 1 from public.sessions s where s.id = attempts.session_id and s.user_id = auth.uid())
) with check (
  exists(select 1 from public.sessions s where s.id = attempts.session_id and s.user_id = auth.uid())
);

create policy "expressions_owner" on public.expressions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "review_queue_owner" on public.spaced_review_queue for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "weekly_recaps_owner" on public.weekly_recaps for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "daily_usage_owner" on public.daily_usage for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "events_owner_read" on public.events for select using (user_id = auth.uid() or public.is_admin());

-- Entitlements and payments
create policy "entitlements_read_self" on public.entitlements for select using (user_id = auth.uid() or public.is_admin());
create policy "entitlements_write_service" on public.entitlements for all
  using (auth.role() = 'service_role' or public.is_admin())
  with check (auth.role() = 'service_role' or public.is_admin());

create policy "payment_events_read_self" on public.payment_events for select using (user_id = auth.uid() or public.is_admin());
create policy "payment_events_write_service" on public.payment_events for all
  using (auth.role() = 'service_role' or public.is_admin())
  with check (auth.role() = 'service_role' or public.is_admin());

create policy "reconciliation_jobs_admin" on public.reconciliation_jobs for all using (public.is_admin()) with check (public.is_admin());

create policy "affiliates_admin" on public.affiliates for all using (public.is_admin()) with check (public.is_admin());
create policy "referral_credits_self_read" on public.referral_credits for select using (user_id = auth.uid() or public.is_admin());
create policy "referral_credits_admin_write" on public.referral_credits for all using (public.is_admin()) with check (public.is_admin());

create policy "feature_flags_read" on public.feature_flags for select using (true);
create policy "feature_flags_admin_write" on public.feature_flags for all using (public.is_admin()) with check (public.is_admin());

create policy "settings_admin" on public.settings for all using (public.is_admin()) with check (public.is_admin());
create policy "reports_read_admin" on public.reports for select using (public.is_admin());
create policy "reports_write_auth" on public.reports for insert with check (auth.role() in ('authenticated','service_role'));
create policy "audit_logs_admin" on public.audit_logs for select using (public.is_admin());

-- ============ TRIGGERS ============

-- updated_at helpers
create or replace function public.tg_set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end$$;

create trigger tg_profiles_updated before update on public.profiles for each row execute function public.tg_set_updated_at();
create trigger tg_coaches_updated before update on public.coaches for each row execute function public.tg_set_updated_at();
create trigger tg_rubrics_updated before update on public.rubrics for each row execute function public.tg_set_updated_at();
create trigger tg_catalogs_updated before update on public.catalogs for each row execute function public.tg_set_updated_at();
create trigger tg_drills_updated before update on public.drills for each row execute function public.tg_set_updated_at();
create trigger tg_expressions_updated before update on public.expressions for each row execute function public.tg_set_updated_at();
create trigger tg_entitlements_updated before update on public.entitlements for each row execute function public.tg_set_updated_at();
create trigger tg_feature_flags_updated before update on public.feature_flags for each row execute function public.tg_set_updated_at();
create trigger tg_settings_updated before update on public.settings for each row execute function public.tg_set_updated_at();

-- daily_usage expressions_saved increment
create or replace function public.tg_after_expression_insert()
returns trigger language plpgsql as $$
begin
  insert into public.daily_usage(user_id, d, expressions_saved)
  values (new.user_id, current_date, 1)
  on conflict (user_id, d) do update set expressions_saved = public.daily_usage.expressions_saved + 1;
  return new;
end$$;
create trigger tg_expressions_after_insert after insert on public.expressions
for each row execute function public.tg_after_expression_insert();

-- maintain tickets.last_message_at
create or replace function public.tg_ticket_touch()
returns trigger language plpgsql as $$
begin
  update public.tickets set last_message_at = new.created_at where id = new.ticket_id;
  return new;
end$$;
create trigger tg_ticket_messages_after_insert after insert on public.ticket_messages
for each row execute function public.tg_ticket_touch();

-- ============ SCHEDULED JOBS (pg_cron) ============

-- Weekly recap: Monday 07:00 Asia/Manila = Sunday 23:00 UTC
select cron.schedule('weekly_recaps', '0 23 * * 0', $$
  insert into public.weekly_recaps(user_id, week_start_date, summary, next_drills)
  select p.id, date_trunc('week', now() at time zone 'Asia/Manila')::date,
         (public.rpc_get_weekly_pack())->'summary',
         (public.rpc_get_weekly_pack())->'next'
  from public.profiles p
  on conflict (user_id, week_start_date) do nothing;
$$);

-- Nightly reconciliation placeholder 02:00 UTC
select cron.schedule('payments_reconcile', '0 2 * * *', $$
  insert into public.reconciliation_jobs(details)
  values (jsonb_build_object('note','run external reconciliation worker via Edge Function'));
$$);

-- ============ SECURITY DEFAULTS ============
revoke all on schema public from anon;
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from anon;
grant usage on schema public to authenticated;
