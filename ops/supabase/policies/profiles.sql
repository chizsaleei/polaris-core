-- =====================================================================
-- Polaris Core - RLS Policies for public.profiles
-- File: ops/supabase/policies/profiles.sql
--
-- Assumptions
--   • Table public.profiles has at least:
--       id uuid primary key                -- should match auth.uid()
--       email text                         -- optional, may be null or masked
--       full_name text
--       avatar_url text
--       tier text                          -- free | pro | vip
--       active_coach_id text               -- the currently selected coach
--       settings jsonb                     -- user preferences
--       is_public boolean default false    -- optional: whether basic fields are public
--       created_at timestamptz default now()
--       updated_at timestamptz default now()
--   • Helper: public.is_admin() returns boolean
--
-- Intent
--   • Admins have full access
--   • A user can insert his own profile row and read/update his own row
--   • Optional limited public read when is_public = true (if column exists)
--   • Delete is admin only
-- =====================================================================

do $$
declare
  policy_name   text;
  has_is_public boolean;
begin
  -- Ensure table exists
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'profiles'
  ) then
    raise notice 'public.profiles not found. Skipping profiles policies.';
    return;
  end if;

  -- Detect optional is_public column
  has_is_public := exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'profiles'
      and column_name  = 'is_public'
  );

  -- Enable RLS and lock anon out
  alter table public.profiles enable row level security;
  revoke all on public.profiles from anon;

  -- Drop existing policies for idempotency
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'profiles'
  loop
    execute format('drop policy %I on public.profiles;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin full access
  ----------------------------------------------------------------------
  create policy "profiles_admin_all"
  on public.profiles
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Self SELECT: read own profile
  ----------------------------------------------------------------------
  create policy "profiles_self_select"
  on public.profiles
  as permissive
  for select
  to authenticated
  using (id = auth.uid());

  ----------------------------------------------------------------------
  -- Optional public read for rows marked is_public (only if column exists)
  ----------------------------------------------------------------------
  if has_is_public then
    create policy "profiles_public_select"
    on public.profiles
    as permissive
    for select
    to authenticated
    using (is_public = true);
  end if;

  ----------------------------------------------------------------------
  -- Self INSERT: create own profile
  ----------------------------------------------------------------------
  create policy "profiles_self_insert"
  on public.profiles
  as permissive
  for insert
  to authenticated
  with check (id = auth.uid());

  ----------------------------------------------------------------------
  -- Self UPDATE: update own profile
  ----------------------------------------------------------------------
  create policy "profiles_self_update"
  on public.profiles
  as permissive
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

  ----------------------------------------------------------------------
  -- Helpful indexes
  ----------------------------------------------------------------------
  if has_is_public then
    create index if not exists idx_profiles_is_public
      on public.profiles (is_public);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'profiles'
      and column_name  = 'updated_at'
  ) then
    create index if not exists idx_profiles_updated_at
      on public.profiles (updated_at desc);
  end if;

end$$;

-- =====================================================================
-- Notes
--   • If you must hide sensitive fields from public reads, expose a
--     view like public.v_public_profiles and have your app read from it.
--   • Keep email edits server side to avoid leaking through RLS mistakes.
-- =====================================================================
