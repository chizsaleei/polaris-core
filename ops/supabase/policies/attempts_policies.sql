-- =====================================================================
-- Polaris Core - RLS Policies for public.attempts
-- File: ops/supabase/policies/attempts_policies.sql
--
-- Assumptions (flexible):
--   • Table public.attempts exists
--   • It has a user identifier column, either:
--       - user_id uuid
--       - OR profile_id uuid
--   • Optional columns used for indexes if present:
--       - drill_id uuid
--       - session_id uuid
--       - created_at timestamptz
--
-- Helper:
--   • public.is_admin() returns boolean (defined in core migrations)
--
-- Intent:
--   • Admins: full read and write
--   • Users: can insert their own attempts
--   • Users: can read and update only their own attempts
--   • Delete: admin only
-- =====================================================================

do $$
declare
  policy_name text;
  v_user_col  text;
begin
  -- Ensure table exists
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'attempts'
  ) then
    raise notice 'public.attempts not found. Skipping attempts policies.';
    return;
  end if;

  -- Detect which user column is present (user_id or profile_id)
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'attempts'
      and column_name  = 'user_id'
  ) then
    v_user_col := 'user_id';
  elsif exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'attempts'
      and column_name  = 'profile_id'
  ) then
    v_user_col := 'profile_id';
  else
    raise notice 'public.attempts has no user_id/profile_id column; skipping RLS policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.attempts enable row level security;
  revoke all on public.attempts from anon;

  -- Drop existing policies for a clean, idempotent install
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'attempts'
  loop
    execute format('drop policy %I on public.attempts;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admins: full access (select/insert/update/delete)
  ----------------------------------------------------------------------
  execute $sql$
    create policy "attempts_admin_all"
    on public.attempts
    as permissive
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  $sql$;

  ----------------------------------------------------------------------
  -- Owners: read own attempts
  ----------------------------------------------------------------------
  execute format($sql$
    create policy "attempts_owner_select"
    on public.attempts
    as permissive
    for select
    to authenticated
    using (%I = auth.uid());
  $sql$, v_user_col);

  ----------------------------------------------------------------------
  -- Owners: insert attempts for themselves
  ----------------------------------------------------------------------
  execute format($sql$
    create policy "attempts_owner_insert"
    on public.attempts
    as permissive
    for insert
    to authenticated
    with check (%I = auth.uid());
  $sql$, v_user_col);

  ----------------------------------------------------------------------
  -- Owners: update only their own attempts
  -- (App decides which columns are editable)
  ----------------------------------------------------------------------
  execute format($sql$
    create policy "attempts_owner_update"
    on public.attempts
    as permissive
    for update
    to authenticated
    using (%I = auth.uid())
    with check (%I = auth.uid());
  $sql$, v_user_col, v_user_col);

  ----------------------------------------------------------------------
  -- Helpful indexes (created only if relevant columns exist)
  ----------------------------------------------------------------------

  -- Index on (user, created_at) if created_at exists
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'attempts'
      and column_name  = 'created_at'
  ) then
    execute format($sql$
      create index if not exists idx_attempts_user_created
        on public.attempts (%I, created_at desc);
    $sql$, v_user_col);
  end if;

  -- Index on (drill_id, created_at) if both exist
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'attempts'
      and column_name  = 'drill_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'attempts'
      and column_name  = 'created_at'
  ) then
    execute $sql$
      create index if not exists idx_attempts_drill_created
        on public.attempts (drill_id, created_at desc);
    $sql$;
  end if;

  -- Index on session_id if it exists
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'attempts'
      and column_name  = 'session_id'
  ) then
    execute $sql$
      create index if not exists idx_attempts_session
        on public.attempts (session_id);
    $sql$;
  end if;

end$$;

-- =====================================================================
-- End of policies/attempts_policies.sql
-- =====================================================================
