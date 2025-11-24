-- =====================================================================
-- Polaris Core - RLS Policies for public.tickets
-- File: ops/supabase/policies/tickets_policies.sql
--
-- Assumptions
--   • Table public.tickets has at least:
--       id uuid primary key
--       user_id uuid not null                -- ticket owner
--       subject text not null
--       state ticket_state not null default 'open'  -- open | pending_admin | pending_user | resolved | closed | archived
--       priority ticket_priority not null default 'normal'
--       assigned_to uuid                     -- admin user id (nullable)
--       tags text[]                          -- optional
--       meta jsonb                           -- optional (or metadata)
--       created_at timestamptz default now()
--       updated_at timestamptz default now()
--   • Helper function public.is_admin() returns boolean
--
-- Intent
--   • Admins: full read and write on all tickets
--   • Users: can create tickets for themselves
--   • Users: can select and update only their own tickets
--   • Delete: admin only
--
-- Notes
--   • Column-level restrictions should be enforced in API layer.
--     For example, only admins change state, priority, assigned_to.
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
      and c.relname = 'tickets'
  ) then
    raise notice 'public.tickets not found. Skipping tickets policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.tickets enable row level security;
  revoke all on public.tickets from anon;

  -- Drop old policies for idempotency (including ones from earlier migrations)
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'tickets'
  loop
    execute format('drop policy %I on public.tickets;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "tickets_admin_all"
  on public.tickets
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Owner: can read their own tickets
  ----------------------------------------------------------------------
  create policy "tickets_owner_select"
  on public.tickets
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Owner: can create tickets for themselves
  ----------------------------------------------------------------------
  create policy "tickets_owner_insert"
  on public.tickets
  as permissive
  for insert
  to authenticated
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Owner: can update their own tickets
  -- App should restrict which columns are editable by non-admins
  ----------------------------------------------------------------------
  create policy "tickets_owner_update"
  on public.tickets
  as permissive
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Helpful indexes
  ----------------------------------------------------------------------
  create index if not exists idx_tickets_user_created
    on public.tickets (user_id, created_at desc);

  create index if not exists idx_tickets_state_created
    on public.tickets (state, created_at desc);

  create index if not exists idx_tickets_assigned
    on public.tickets (assigned_to, state);

end$$;

-- =====================================================================
-- End of policies/tickets_policies.sql
-- =====================================================================
