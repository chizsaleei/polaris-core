-- =====================================================================
-- Polaris Core - RLS Policies for public.sessions
-- File: ops/supabase/policies/sessions_policies.sql
--
-- Assumptions
--   • Table public.sessions has at least:
--       id uuid primary key
--       user_id uuid not null
--       coach_key text                      -- in current schema
--       status session_status
--       started_at timestamptz
--       submitted_at timestamptz
--       created_at timestamptz              -- optional in older schemas
--       updated_at timestamptz
--   • Helper: public.is_admin() returns boolean
--
-- Intent
--   • Admins: full access
--   • Users: can insert their own session rows
--   • Users: can select and update only their own rows
--   • Delete: admin only
-- =====================================================================

do $$
declare
  policy_name text;
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'sessions'
  ) then
    raise notice 'public.sessions not found. Skipping sessions policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.sessions enable row level security;
  revoke all on public.sessions from anon;

  -- Drop existing policies for idempotency (including 0001/0009 defaults)
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'sessions'
  loop
    execute format('drop policy %I on public.sessions;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin full access
  ----------------------------------------------------------------------
  create policy "sessions_admin_all"
  on public.sessions
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Owners can read their own sessions
  ----------------------------------------------------------------------
  create policy "sessions_owner_select"
  on public.sessions
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Owners can insert their own sessions
  -- App must set user_id = auth.uid()
  ----------------------------------------------------------------------
  create policy "sessions_owner_insert"
  on public.sessions
  as permissive
  for insert
  to authenticated
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Owners can update their own sessions
  -- App should only allow safe fields to change server side
  ----------------------------------------------------------------------
  create policy "sessions_owner_update"
  on public.sessions
  as permissive
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Helpful indexes (guarded on column existence)
  ----------------------------------------------------------------------
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'sessions'
      and column_name  = 'created_at'
  ) then
    create index if not exists idx_sessions_user_created
      on public.sessions (user_id, created_at desc);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'sessions'
      and column_name  = 'started_at'
  ) then
    create index if not exists idx_sessions_user_started
      on public.sessions (user_id, started_at desc);

    if exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'sessions'
        and column_name  = 'coach_key'
    ) then
      create index if not exists idx_sessions_coach_time
        on public.sessions (coach_key, started_at desc);
    end if;
  end if;

end$$;

-- =====================================================================
-- End of policies/sessions_policies.sql
-- =====================================================================
