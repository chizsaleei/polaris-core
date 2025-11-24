-- =====================================================================
-- Polaris Core - RLS Policies for public.user_deletions
-- File: ops/supabase/policies/user_deletions.sql
--
-- Assumed table (adjust if your schema differs):
--   id             uuid primary key default gen_random_uuid()
--   user_id        uuid not null                 -- owner of the account to delete
--   status         text not null default 'pending' -- 'pending' | 'processing' | 'completed' | 'failed'
--   reason         text                           -- optional free text by user
--   requested_by   uuid                           -- admin or system actor if initiated by support
--   scheduled_at   timestamptz                    -- when the job is planned to run
--   processed_at   timestamptz                    -- when completed or failed
--   error          text                           -- set on failure
--   created_at     timestamptz default now()
--   updated_at     timestamptz default now()
--
-- Dependencies:
--   function public.is_admin() returns boolean
--
-- Policy intent:
--   • Admins manage lifecycle and execution
--   • Users can submit and view their own requests
--   • Users may cancel only while 'pending' by deleting their row
--   • No user updates to avoid tampering with status or audit fields
-- =====================================================================

do $$
declare
  policy_name text;
begin
  -- Ensure table exists
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'user_deletions'
  ) then
    raise notice 'public.user_deletions not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.user_deletions enable row level security;
  revoke all on public.user_deletions from anon;

  -- Drop existing policies to re-apply idempotently
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'user_deletions'
  loop
    execute format('drop policy %I on public.user_deletions;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "user_deletions_admin_all"
  on public.user_deletions
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Users: INSERT a deletion request for themselves
  ----------------------------------------------------------------------
  create policy "user_deletions_user_insert_self"
  on public.user_deletions
  as permissive
  for insert
  to authenticated
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Users: SELECT their own requests
  ----------------------------------------------------------------------
  create policy "user_deletions_user_select_own"
  on public.user_deletions
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Users: DELETE their own request only while pending
  -- This acts as a cancel before processing starts
  ----------------------------------------------------------------------
  create policy "user_deletions_user_delete_pending"
  on public.user_deletions
  as permissive
  for delete
  to authenticated
  using (
    user_id = auth.uid()
    and status = 'pending'
  );

  ----------------------------------------------------------------------
  -- No user UPDATE. Status and audit fields are managed by admin or jobs.
  ----------------------------------------------------------------------

  ----------------------------------------------------------------------
  -- Helpful indexes
  ----------------------------------------------------------------------
  create index if not exists idx_user_deletions_user_created
    on public.user_deletions (user_id, created_at desc);

  create index if not exists idx_user_deletions_status
    on public.user_deletions (status, created_at desc);

  create index if not exists idx_user_deletions_user_status
    on public.user_deletions (user_id, status);

end$$;

-- Optional constraints and job guardrails
-- alter table public.user_deletions
--   add constraint chk_user_deletions_status
--   check (status in ('pending','processing','completed','failed'));
--
-- Example trigger to auto set processed_at when status changes to a terminal state
-- create or replace function public.user_deletions_guard()
-- returns trigger language plpgsql as $fn$
-- begin
--   if not public.is_admin() then
--     raise exception 'Only admins or system jobs may update deletion records';
--   end if;
--   if new.status in ('completed','failed') and new.processed_at is null then
--     new.processed_at := now();
--   end if;
--   return new;
-- end;
-- $fn$;
-- drop trigger if exists trg_user_deletions_guard on public.user_deletions;
-- create trigger trg_user_deletions_guard
--   before update on public.user_deletions
--   for each row execute function public.user_deletions_guard();
