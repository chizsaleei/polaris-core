-- =====================================================================
-- Polaris Core - RLS Policies for public.transcripts
-- File: ops/supabase/policies/transcripts.sql
--
-- Assumptions (aligns with earlier migrations / app usage)
--   • Table public.transcripts has at least:
--       id uuid primary key
--       session_id uuid not null              -- FK -> public.sessions(id)
--       user_id uuid not null                 -- owner (same as sessions.user_id)
--       source text not null                  -- 'upload' | 'realtime' | 'tts' | 'import'
--       lang text                             -- BCP-47 like 'en', 'en-US'
--       text text                             -- full transcript
--       words jsonb                           -- optional word timings/segments
--       risk_flags jsonb default '{}'::jsonb  -- safety/PII flags
--       is_private boolean default true       -- whether sharable to others in future
--       created_at timestamptz default now()
--       updated_at timestamptz default now()
--   • Table public.sessions(id, user_id) exists
--   • Helper: public.is_admin() returns boolean
--
-- Intent
--   • Admins: full access
--   • A user: can read own transcripts
--   • A user: can insert transcripts ONLY for own session
--   • A user: can update own transcripts (e.g., redact text);
--             detailed control over risk_flags should be via triggers/RPCs
--   • Delete: admin only
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
      and c.relname = 'transcripts'
  ) then
    raise notice 'public.transcripts not found. Skipping transcripts policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.transcripts enable row level security;
  revoke all on public.transcripts from anon;

  -- Drop existing policies for idempotency (including 0009 generic ones)
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'transcripts'
  loop
    execute format('drop policy %I on public.transcripts;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "transcripts_admin_all"
  on public.transcripts
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Owner SELECT: user may read own transcripts
  --   • directly by user_id
  --   • or via ownership of the session
  ----------------------------------------------------------------------
  create policy "transcripts_owner_select"
  on public.transcripts
  as permissive
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.sessions s
      where s.id = transcripts.session_id
        and s.user_id = auth.uid()
    )
  );

  ----------------------------------------------------------------------
  -- Owner INSERT: user can insert for own session only, and must set
  -- user_id = auth.uid().
  ----------------------------------------------------------------------
  create policy "transcripts_owner_insert"
  on public.transcripts
  as permissive
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.sessions s
      where s.id = transcripts.session_id
        and s.user_id = auth.uid()
    )
  );

  ----------------------------------------------------------------------
  -- Owner UPDATE: allow edits for the owner's transcripts.
  -- Detailed constraints on which fields may change (e.g. risk_flags)
  -- should be enforced via triggers or SECURITY DEFINER RPCs.
  ----------------------------------------------------------------------
  create policy "transcripts_owner_update"
  on public.transcripts
  as permissive
  for update
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
      from public.sessions s
      where s.id = transcripts.session_id
        and s.user_id = auth.uid()
    )
  )
  with check (
    user_id = auth.uid()
  );

  ----------------------------------------------------------------------
  -- Helpful indexes (guarded on column existence)
  ----------------------------------------------------------------------
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'transcripts'
      and column_name  = 'created_at'
  ) then
    create index if not exists idx_transcripts_user_created
      on public.transcripts (user_id, created_at desc);

    create index if not exists idx_transcripts_session_created
      on public.transcripts (session_id, created_at desc);
  end if;

end$$;

-- =====================================================================
-- Notes
--   • If you plan to allow sharing transcripts in the future, create a
--     view (e.g., public.v_shared_transcripts) and add a separate policy.
--   • For strong control over risk flag edits, expose an RPC and/or BEFORE
--     UPDATE trigger that validates allowed changes.
--   • Storage bucket policies for any audio blobs should reference
--     session_id/user_id consistently with these RLS rules.
-- =====================================================================
