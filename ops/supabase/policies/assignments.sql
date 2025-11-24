-- =====================================================================
-- Polaris Core - RLS Policies for public.assignments
-- File: ops/supabase/policies/assignments.sql
--
-- Actual table (simplified to match existing schema):
--   id                  uuid primary key default gen_random_uuid()
--   user_id             uuid not null
--   coach_id / coach_key (not referenced by RLS)
--   set_id              uuid
--   title               text not null
--   description         text
--   due_at              timestamptz
--   -- next_scheduled_at may NOT exist in your schema
--   completed_at        timestamptz
--   notes               text
--   created_by          uuid
--   created_at          timestamptz not null default now()
--   updated_at          timestamptz not null default now()
--
-- Dependencies:
--   function public.is_admin() returns boolean
--
-- Policy intent:
--  • Users may read only their own assignments
--  • Users may insert their own assignments
--  • Users may update only their own assignments
--  • Only admins can delete (and also insert/update freely)
-- =====================================================================

do $$
declare
  policy_name text;
  has_next_scheduled boolean;
begin
  -- Ensure table exists
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'assignments'
  ) then
    raise notice 'public.assignments not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS
  alter table public.assignments enable row level security;

  -- Lock anon out; rely on RLS for authenticated users
  revoke all on public.assignments from anon;

  -- Drop existing policies to re-apply cleanly
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'assignments'
  loop
    execute format('drop policy %I on public.assignments;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control (select/insert/update/delete)
  ----------------------------------------------------------------------
  create policy "assignments_admin_all"
  on public.assignments
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Users: read own
  ----------------------------------------------------------------------
  create policy "assignments_user_select_own"
  on public.assignments
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Users: insert own
  ----------------------------------------------------------------------
  create policy "assignments_user_insert_own"
  on public.assignments
  as permissive
  for insert
  to authenticated
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Users: update own
  ----------------------------------------------------------------------
  create policy "assignments_user_update_own"
  on public.assignments
  as permissive
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Helpful indexes (only on columns that actually exist)
  ----------------------------------------------------------------------
  -- Index on (user_id, due_at) if due_at exists
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'assignments'
      and column_name  = 'due_at'
  ) then
    execute '
      create index if not exists idx_assignments_user_due
        on public.assignments (user_id, due_at)
    ';
  end if;

  -- Index on (user_id, updated_at) if updated_at exists
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'assignments'
      and column_name  = 'updated_at'
  ) then
    execute '
      create index if not exists idx_assignments_user_updated
        on public.assignments (user_id, updated_at desc)
    ';
  end if;

  -- Index on (user_id, next_scheduled_at) only if that column exists
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'assignments'
      and column_name  = 'next_scheduled_at'
  ) then
    execute '
      create index if not exists idx_assignments_user_next_scheduled
        on public.assignments (user_id, next_scheduled_at)
    ';
  end if;

end$$;

-- Optional hardening if you later add status/progress columns:
-- alter table public.assignments
--   add constraint chk_assignments_status
--   check (status in (''open'',''in_progress'',''done'',''skipped''));
-- alter table public.assignments
--   add constraint chk_assignments_progress
--   check (progress_pct between 0 and 100);
