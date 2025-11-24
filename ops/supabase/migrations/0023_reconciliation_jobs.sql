-- ===============================================================
-- 0023_reconciliation_jobs.sql
-- Payment and entitlement reconciliation jobs, runs, and findings
-- Safe-by-default RLS. Admin-only visibility. Server uses service role.
-- Date: 2025-11-14
-- ===============================================================

-- Status enum for reconciliation lifecycle
do $$
begin
  if not exists (select 1 from pg_type where typname = 'recon_status') then
    create type public.recon_status as enum (
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'partial'
    );
  end if;
end $$;

-- Job type enum to keep the system extensible
do $$
begin
  if not exists (select 1 from pg_type where typname = 'recon_job_type') then
    create type public.recon_job_type as enum (
      'adyen_settlements',      -- compare Adyen events vs internal payments_events and entitlements
      'entitlements_audit',     -- scan access vs payments_events
      'affiliates_payouts'      -- check affiliate clicks, attributions, and payouts
    );
  end if;
end $$;

-- Utility: touch_updated_at if not defined earlier
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
    end;
    $fn$;
  end if;
end $$;

-- Optional is_admin guard
do $$
begin
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

-- ===============================================================
-- Jobs define the scope, time window, and parameters for a run
-- ===============================================================
create table if not exists public.recon_jobs (
  id               uuid primary key default gen_random_uuid(),
  job_type         public.recon_job_type not null,
  date_from        date not null,
  date_to          date not null,
  params           jsonb not null default '{}'::jsonb, -- merchant_account, currency, coach_key, etc.
  created_by       uuid references public.profiles(id) on delete set null,
  status           public.recon_status not null default 'queued',
  attempts         int not null default 0,
  last_error       text,
  scheduled_for    timestamptz,                         -- when a worker should pick it up
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint chk_recon_dates check (date_from <= date_to)
);

create index if not exists idx_recon_jobs_status on public.recon_jobs(status);
create index if not exists idx_recon_jobs_window on public.recon_jobs(date_from, date_to);
create index if not exists idx_recon_jobs_type on public.recon_jobs(job_type);

drop trigger if exists trg_touch_recon_jobs on public.recon_jobs;
create trigger trg_touch_recon_jobs
before update on public.recon_jobs
for each row execute function public.touch_updated_at();

alter table public.recon_jobs enable row level security;
revoke all on public.recon_jobs from anon, authenticated;

drop policy if exists "recon_jobs admin read" on public.recon_jobs;
create policy "recon_jobs admin read"
on public.recon_jobs
for select to authenticated
using (public.is_admin());

drop policy if exists "recon_jobs admin write" on public.recon_jobs;
create policy "recon_jobs admin write"
on public.recon_jobs
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ===============================================================
-- Runs capture each attempt of a job. Useful for retries
-- ===============================================================
create table if not exists public.recon_runs (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.recon_jobs(id) on delete cascade,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         public.recon_status not null default 'running',
  worker_notes   text,
  stats          jsonb not null default '{}'::jsonb, -- counters: scanned, matched, missing, fixed
  error          text
);

create index if not exists idx_recon_runs_job on public.recon_runs(job_id);
create index if not exists idx_recon_runs_status on public.recon_runs(status);

alter table public.recon_runs enable row level security;
revoke all on public.recon_runs from anon, authenticated;

drop policy if exists "recon_runs admin read" on public.recon_runs;
create policy "recon_runs admin read"
on public.recon_runs
for select to authenticated
using (public.is_admin());

drop policy if exists "recon_runs admin write" on public.recon_runs;
create policy "recon_runs admin write"
on public.recon_runs
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ===============================================================
-- Findings are the detailed differences and proposed actions
-- ===============================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'recon_diff_type') then
    create type public.recon_diff_type as enum (
      'missing_internal_event',     -- exists in provider but not in payments_events
      'missing_provider_event',     -- exists in internal but not in provider
      'amount_mismatch',
      'status_mismatch',
      'currency_mismatch',
      'missing_entitlement',
      'extra_entitlement'
    );
  end if;
end $$;

create table if not exists public.recon_findings (
  id                    uuid primary key default gen_random_uuid(),
  job_id                uuid not null references public.recon_jobs(id) on delete cascade,
  run_id                uuid references public.recon_runs(id) on delete set null,
  diff_type             public.recon_diff_type not null,
  provider              text not null default 'adyen',
  merchant_reference    text,           -- your reference
  psp_reference         text,           -- provider reference when present
  user_id               uuid references public.profiles(id) on delete set null,
  expected_amount_minor bigint,
  actual_amount_minor   bigint,
  expected_currency     text,
  actual_currency       text,
  expected_status       text,
  actual_status         text,
  details               jsonb not null default '{}'::jsonb, -- any extra context
  suggested_action      text,           -- "grant entitlement", "revoke", "refund", "investigate"
  resolved              boolean not null default false,
  resolved_by           uuid references public.profiles(id) on delete set null,
  resolved_at           timestamptz
);

create index if not exists idx_recon_findings_job on public.recon_findings(job_id);
create index if not exists idx_recon_findings_run on public.recon_findings(run_id);
create index if not exists idx_recon_findings_user on public.recon_findings(user_id);
create index if not exists idx_recon_findings_ref on public.recon_findings(merchant_reference);
create index if not exists idx_recon_findings_type on public.recon_findings(diff_type);

alter table public.recon_findings enable row level security;
revoke all on public.recon_findings from anon, authenticated;

drop policy if exists "recon_findings admin read" on public.recon_findings;
create policy "recon_findings admin read"
on public.recon_findings
for select to authenticated
using (public.is_admin());

drop policy if exists "recon_findings admin write" on public.recon_findings;
create policy "recon_findings admin write"
on public.recon_findings
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ===============================================================
-- Convenience view. Shows open findings with the latest status
-- ===============================================================
create or replace view public.v_recon_open as
select f.*
from public.recon_findings f
where not f.resolved;

-- ===============================================================
-- Helper functions for enqueuing and resolving
-- ===============================================================

-- Enqueue a job for a date window
create or replace function public.recon_enqueue_daily(
  p_job_type   public.recon_job_type,
  p_date_from  date,
  p_date_to    date,
  p_params     jsonb default '{}'::jsonb,
  p_created_by uuid default null,
  p_schedule_at timestamptz default null
) returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  insert into public.recon_jobs (
    job_type, date_from, date_to, params, created_by, status, scheduled_for
  )
  values (
    p_job_type,
    p_date_from,
    p_date_to,
    coalesce(p_params, '{}'::jsonb),
    p_created_by,
    'queued',
    p_schedule_at
  )
  returning id into v_id;

  return v_id;
end;
$fn$;

grant execute on function public.recon_enqueue_daily(
  public.recon_job_type, date, date, jsonb, uuid, timestamptz
) to authenticated, anon;

-- Mark a finding as resolved with an optional note
create or replace function public.recon_mark_resolved(
  p_finding_id uuid,
  p_user_id    uuid,
  p_note       text default null
) returns void
language plpgsql
as $fn$
begin
  update public.recon_findings
     set resolved   = true,
         resolved_by = p_user_id,
         resolved_at = now(),
         details    = case
                        when p_note is not null
                        then jsonb_set(details, '{resolution_note}', to_jsonb(p_note), true)
                        else details
                      end
   where id = p_finding_id;
end;
$fn$;

grant execute on function public.recon_mark_resolved(uuid, uuid, text) to authenticated;

-- Start a run for a job
create or replace function public.recon_run_start(p_job_id uuid)
returns uuid
language plpgsql
as $fn$
declare
  v_run_id uuid;
begin
  update public.recon_jobs
     set status    = 'running',
         attempts  = attempts + 1,
         updated_at = now()
   where id = p_job_id;

  insert into public.recon_runs(job_id)
  values (p_job_id)
  returning id into v_run_id;

  return v_run_id;
end;
$fn$;

grant execute on function public.recon_run_start(uuid) to authenticated, anon;

-- Finish a run and set job status
create or replace function public.recon_run_finish(
  p_run_id uuid,
  p_status public.recon_status,
  p_stats  jsonb default '{}'::jsonb,
  p_error  text default null
) returns void
language plpgsql
as $fn$
declare
  v_job_id uuid;
begin
  update public.recon_runs
     set finished_at = now(),
         status      = p_status,
         stats       = coalesce(p_stats, '{}'::jsonb),
         error       = p_error
   where id = p_run_id
   returning job_id into v_job_id;

  update public.recon_jobs
     set status     = p_status,
         last_error = p_error,
         updated_at = now()
   where id = v_job_id;
end;
$fn$;

grant execute on function public.recon_run_finish(
  uuid, public.recon_status, jsonb, text
) to authenticated, anon;

-- ===============================================================
-- Optional seed enqueue for yesterday. Comment out if not desired.
-- ===============================================================
-- select public.recon_enqueue_daily(
--   'adyen_settlements',
--   current_date - 1,
--   current_date - 1,
--   '{"currency":"USD"}'::jsonb,
--   null,
--   now()
-- );
