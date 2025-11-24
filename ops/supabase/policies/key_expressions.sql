-- =====================================================================
-- Polaris Core - RLS Policies for public.key_expressions
-- File: ops/supabase/policies/key_expressions.sql
--
-- Assumptions (aligns with Expressions Pack flow)
--   • Table public.key_expressions has at least:
--       id uuid primary key
--       user_id uuid not null                   -- owner of the expression
--       session_id uuid                         -- FK -> public.sessions(id)
--       coach_id text                           -- target coach code
--       text_original text not null             -- as spoken by user
--       text_upgrade text                       -- corrected/improved version
--       phonetics jsonb                         -- pronunciation notes
--       tags text[]                             -- skills, topics
--       state public.expression_state not null default 'private_user'
--            -- 'private_user' | 'candidate_exemplar' | 'published_exemplar' | 'deprecated'
--       is_exemplar boolean not null default false
--       risk_flags jsonb not null default '{}'::jsonb
--       created_at timestamptz default now()
--       updated_at timestamptz default now()
--   • Table public.sessions(id, user_id) exists
--   • Helper: public.is_admin() returns boolean
--
-- Intent
--   • Admins: full access
--   • Owners: can read/insert/update their own expressions
--   • Catalog browsing: any authenticated user may read "published_exemplar"
--     rows (global catalog), but never modify them
--   • Promotion to exemplar and any cross-user edits are admin only
--   • Deletion is admin only
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
      and c.relname = 'key_expressions'
  ) then
    raise notice 'public.key_expressions not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.key_expressions enable row level security;
  revoke all on public.key_expressions from anon;

  -- Drop existing policies (including generic 0009 ones) for idempotency
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'key_expressions'
  loop
    execute format('drop policy %I on public.key_expressions;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "keyexp_admin_all"
  on public.key_expressions
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Owner SELECT: read own expressions
  ----------------------------------------------------------------------
  create policy "keyexp_owner_select"
  on public.key_expressions
  as permissive
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.sessions s
      where s.id = key_expressions.session_id
        and s.user_id = auth.uid()
    )
  );

  ----------------------------------------------------------------------
  -- Catalog SELECT: read published exemplars (global, read-only)
  -- Note: expose only safe columns from your API for catalog views.
  ----------------------------------------------------------------------
  create policy "keyexp_catalog_select"
  on public.key_expressions
  as permissive
  for select
  to authenticated
  using (
    state = 'published_exemplar'
    and is_exemplar = true
  );

  ----------------------------------------------------------------------
  -- Owner INSERT: user may insert for own session only
  ----------------------------------------------------------------------
  create policy "keyexp_owner_insert"
  on public.key_expressions
  as permissive
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.sessions s
      where s.id = key_expressions.session_id
        and s.user_id = auth.uid()
    )
    -- Owner-created records must start private and non-exemplar
    and coalesce(state::text, 'private_user') = 'private_user'
    and coalesce(is_exemplar, false) = false
  );

  ----------------------------------------------------------------------
  -- Owner UPDATE: allow updating own private items (fix text, add notes)
  -- but block self-promotion to exemplar or published states.
  ----------------------------------------------------------------------
  create policy "keyexp_owner_update"
  on public.key_expressions
  as permissive
  for update
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.sessions s
      where s.id = key_expressions.session_id
        and s.user_id = auth.uid()
    )
  )
  with check (
    user_id = auth.uid()
    and state in ('private_user','deprecated')
    and is_exemplar = false
  );

  ----------------------------------------------------------------------
  -- Helpful indexes for common filters (guarded on column existence)
  ----------------------------------------------------------------------
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'key_expressions'
      and column_name  = 'user_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'key_expressions'
      and column_name  = 'created_at'
  ) then
    create index if not exists idx_keyexp_user_created
      on public.key_expressions (user_id, created_at desc);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'key_expressions'
      and column_name  = 'state'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'key_expressions'
      and column_name  = 'coach_id'
  ) then
    create index if not exists idx_keyexp_state_coach
      on public.key_expressions (state, coach_id);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'key_expressions'
      and column_name  = 'session_id'
  ) then
    create index if not exists idx_keyexp_session
      on public.key_expressions (session_id);
  end if;

end$$;

-- =====================================================================
-- Notes
--   • Promotion flow:
--       - System/AI proposes: set state -> 'candidate_exemplar' (run as admin or via SECURITY DEFINER RPC)
--       - Admin edits & approves: set is_exemplar = true, state -> 'published_exemplar'
--   • To strictly control promotion/demotion, perform those mutations via
--     RPC functions marked SECURITY DEFINER rather than direct table writes.
--   • Consider a VIEW for public catalog reads (limit columns) and point
--     the app to that view while keeping this base table locked down.
-- =====================================================================
