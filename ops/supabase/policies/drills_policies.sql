-- =====================================================================
-- Polaris Core - RLS Policies for Drills and Sets
-- File: ops/supabase/policies/drills_policies.sql
--
-- Targets and assumptions
--    public.drills      - atomic practice items or scenarios
--    public.drill_sets  - curated sets that group drills
--    Columns used by policies:
--       public.drills.state       item_state       -- 'draft'..'published','deprecated'
--       public.drills.coach_key   text
--       public.drill_sets.state   drill_state      -- 'draft'..'published','deprecated'
--       public.drill_sets.published_at timestamptz
--       public.drill_sets.coach_key text
--    Helper: public.is_admin() returns boolean
--
-- Intent
--    Admins: full access to everything
--    Users: read only Approved and Published content
--    No user writes to drills or sets. Writes are admin only.
-- =====================================================================

do $$
begin
  ----------------------------------------------------------------------
  -- DRILLS
  ----------------------------------------------------------------------
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'drills'
  ) then
    raise notice 'public.drills not found. Skipping drill policies.';
  else
    -- Enable RLS
    alter table public.drills enable row level security;

    -- Lock anon out explicitly (Supabase convention)
    revoke all on public.drills from anon;

    -- Drop old policies from this file, if present
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename  = 'drills'
        and policyname = 'drills_admin_all'
    ) then
      drop policy "drills_admin_all" on public.drills;
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename  = 'drills'
        and policyname = 'drills_read_published'
    ) then
      drop policy "drills_read_published" on public.drills;
    end if;

    -- Drop older generic policies from 0009_rls_policies that we are
    -- intentionally replacing with stricter semantics.
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename  = 'drills'
        and policyname = 'catalog read published drills'
    ) then
      drop policy "catalog read published drills" on public.drills;
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename  = 'drills'
        and policyname = 'creator manage own drills (draft)'
    ) then
      drop policy "creator manage own drills (draft)" on public.drills;
    end if;

    --------------------------------------------------------------------
    -- Admin full access
    --------------------------------------------------------------------
    create policy "drills_admin_all"
    on public.drills
    as permissive
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

    --------------------------------------------------------------------
    -- Users: read only Approved / Published drills
    --------------------------------------------------------------------
    create policy "drills_read_published"
    on public.drills
    as permissive
    for select
    to authenticated
    using (
      public.is_admin()
      or state in ('approved','published')
    );

    --------------------------------------------------------------------
    -- Helpful indexes for browse filters
    --------------------------------------------------------------------
    create index if not exists idx_drills_state
      on public.drills (state);
  end if;

  ----------------------------------------------------------------------
  -- DRILL SETS
  ----------------------------------------------------------------------
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'drill_sets'
  ) then
    raise notice 'public.drill_sets not found. Skipping drill set policies.';
  else
    -- Enable RLS
    alter table public.drill_sets enable row level security;

    -- Lock anon out explicitly
    revoke all on public.drill_sets from anon;

    -- Drop old policies from this file, if present
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename  = 'drill_sets'
        and policyname = 'drill_sets_admin_all'
    ) then
      drop policy "drill_sets_admin_all" on public.drill_sets;
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename  = 'drill_sets'
        and policyname = 'drill_sets_read_published'
    ) then
      drop policy "drill_sets_read_published" on public.drill_sets;
    end if;

    -- Drop older generic policies from 0009_rls_policies
    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename  = 'drill_sets'
        and policyname = 'catalog read published drill_sets'
    ) then
      drop policy "catalog read published drill_sets" on public.drill_sets;
    end if;

    if exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename  = 'drill_sets'
        and policyname = 'creator manage own drill_sets (draft)'
    ) then
      drop policy "creator manage own drill_sets (draft)" on public.drill_sets;
    end if;

    --------------------------------------------------------------------
    -- Admin full access
    --------------------------------------------------------------------
    create policy "drill_sets_admin_all"
    on public.drill_sets
    as permissive
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());

    --------------------------------------------------------------------
    -- Users: read only Approved / Published sets
    -- We accept either:
    --   - state in ('approved','published'), or
    --   - published_at is not null (explicit publish timestamp)
    --------------------------------------------------------------------
    create policy "drill_sets_read_published"
    on public.drill_sets
    as permissive
    for select
    to authenticated
    using (
      public.is_admin()
      or state in ('approved','published')
      or published_at is not null
    );

    --------------------------------------------------------------------
    -- Helpful indexes for catalog queries
    --------------------------------------------------------------------
    create index if not exists idx_drill_sets_published_at
      on public.drill_sets (published_at desc);

    create index if not exists idx_drill_sets_state
      on public.drill_sets (state);

    create index if not exists idx_drill_sets_coach_key
      on public.drill_sets (coach_key);
  end if;
end$$;

-- =====================================================================
-- End of policies/drills_policies.sql
-- =====================================================================
