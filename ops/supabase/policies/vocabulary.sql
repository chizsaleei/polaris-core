-- =====================================================================
-- Polaris Core - RLS Policies for public.vocabulary
-- File: ops/supabase/policies/vocabulary.sql
--
-- Assumptions
--   - Table public.vocabulary has at least:
--       id uuid primary key
--       user_id uuid not null                -- owner of the vocab item
--       session_id uuid                      -- FK -> public.sessions(id)
--       coach_id text                        -- coach code
--       term text not null
--       meaning text
--       pronunciation text
--       topic text
--       difficulty text                      -- A1...C2 or simple scale
--       tags text[]
--       state text not null default 'private_user'
--            -- 'private_user' | 'candidate_exemplar' | 'published_exemplar' | 'deprecated'
--       is_exemplar boolean not null default false
--       risk_flags jsonb not null default '{}'::jsonb
--       created_at timestamptz default now()
--       updated_at timestamptz default now()
--   - Table public.sessions(id, user_id) exists
--   - Helper function public.is_admin() returns boolean
--
-- Intent
--   - Admins: full access
--   - Owners: may read and update own private items
--   - Catalog: all authenticated may read published exemplars
--   - Inserts must be owned by the actor and start private
--   - Deletes are admin only
-- =====================================================================

do $$
declare
  policy_name text;
begin
  -- Ensure the table exists
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'vocabulary'
  ) then
    raise notice 'public.vocabulary not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.vocabulary enable row level security;
  revoke all on public.vocabulary from anon;

  -- Drop existing policies for idempotency (including 0009 generic ones)
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'vocabulary'
  loop
    execute format('drop policy %I on public.vocabulary;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "vocab_admin_all"
  on public.vocabulary
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Owner SELECT: read own vocabulary
  ----------------------------------------------------------------------
  create policy "vocab_owner_select"
  on public.vocabulary
  as permissive
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.sessions s
      where s.id = vocabulary.session_id
        and s.user_id = auth.uid()
    )
  );

  ----------------------------------------------------------------------
  -- Catalog SELECT: read published exemplars for discovery
  ----------------------------------------------------------------------
  create policy "vocab_catalog_select"
  on public.vocabulary
  as permissive
  for select
  to authenticated
  using (
    state = 'published_exemplar'
    and is_exemplar = true
  );

  ----------------------------------------------------------------------
  -- Owner INSERT: create private items tied to own session
  ----------------------------------------------------------------------
  create policy "vocab_owner_insert"
  on public.vocabulary
  as permissive
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and coalesce(state, 'private_user') = 'private_user'
    and coalesce(is_exemplar, false) = false
    and (
      session_id is null
      or exists (
        select 1
        from public.sessions s
        where s.id = vocabulary.session_id
          and s.user_id = auth.uid()
      )
    )
  );

  ----------------------------------------------------------------------
  -- Owner UPDATE: edit own private or deprecated items only
  ----------------------------------------------------------------------
  create policy "vocab_owner_update"
  on public.vocabulary
  as permissive
  for update
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.sessions s
      where s.id = vocabulary.session_id
        and s.user_id = auth.uid()
    )
  )
  with check (
    user_id = auth.uid()
    and state in ('private_user','deprecated')
    and is_exemplar = false
  );

  ----------------------------------------------------------------------
  -- Helpful indexes
  ----------------------------------------------------------------------
  create index if not exists idx_vocab_user_created
    on public.vocabulary (user_id, created_at desc);

  create index if not exists idx_vocab_state_coach
    on public.vocabulary (state, coach_id);

  create index if not exists idx_vocab_topic_diff
    on public.vocabulary (topic, difficulty);

  create index if not exists idx_vocab_session
    on public.vocabulary (session_id);

end$$;

-- =====================================================================
-- Notes
--   - Promotion and demotion to exemplar should be done via SECURITY DEFINER
--     RPC endpoints to avoid bypass by non admins.
--   - Consider a limited VIEW for public catalog reads to hide PII columns.
--   - Deletion is not granted to non admins by policy design.
-- =====================================================================
