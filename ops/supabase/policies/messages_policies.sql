-- =====================================================================
-- Polaris Core - RLS Policies for public.ticket_messages (ticket threads)
-- File: ops/supabase/policies/messages_policies.sql
--
-- Assumptions
--   • Table public.ticket_messages has at least:
--       id uuid primary key
--       ticket_id uuid not null                 -- FK -> public.tickets(id)
--       author_type message_author not null     -- 'user' | 'admin' | 'ai_system'
--       author_id uuid                          -- profiles.id of author
--       visibility message_visibility not null default 'public'  -- 'public' | 'internal'
--       body_text text
--       body_html text
--       attachments jsonb not null default '[]'::jsonb
--       meta jsonb not null default '{}'::jsonb
--       created_at timestamptz default now()
--       updated_at timestamptz default now()
--   • Table public.tickets has at least: id, user_id
--   • Helper: public.is_admin() returns boolean
--
-- Intent
--   • Admins: full access to all messages
--   • Ticket owner: can read public messages (and own messages) on their tickets
--   • Ticket owner: can create public user messages on their tickets
--   • Ticket owner: can update their own public user messages
--   • Delete / internal notes: admin only
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
      and c.relname = 'ticket_messages'
  ) then
    raise notice 'public.ticket_messages not found. Skipping ticket message policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.ticket_messages enable row level security;
  revoke all on public.ticket_messages from anon;

  -- Drop existing policies for idempotency
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'ticket_messages'
  loop
    execute format('drop policy %I on public.ticket_messages;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "ticket_messages_admin_all"
  on public.ticket_messages
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Ticket owner: read public messages (and own messages) on their tickets
  ----------------------------------------------------------------------
  create policy "ticket_messages_owner_select"
  on public.ticket_messages
  as permissive
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.tickets t
      where t.id = ticket_messages.ticket_id
        and t.user_id = auth.uid()
    )
    and (
      ticket_messages.visibility = 'public'
      or ticket_messages.author_id = auth.uid()
    )
  );

  ----------------------------------------------------------------------
  -- Ticket owner: create public user messages on their tickets
  ----------------------------------------------------------------------
  create policy "ticket_messages_owner_insert"
  on public.ticket_messages
  as permissive
  for insert
  to authenticated
  with check (
    author_type = 'user'
    and author_id = auth.uid()
    and visibility = 'public'
    and exists (
      select 1
      from public.tickets t
      where t.id = ticket_messages.ticket_id
        and t.user_id = auth.uid()
    )
  );

  ----------------------------------------------------------------------
  -- Ticket owner: update their own public user messages
  ----------------------------------------------------------------------
  create policy "ticket_messages_owner_update"
  on public.ticket_messages
  as permissive
  for update
  to authenticated
  using (
    author_type = 'user'
    and author_id = auth.uid()
    and exists (
      select 1
      from public.tickets t
      where t.id = ticket_messages.ticket_id
        and t.user_id = auth.uid()
    )
  )
  with check (
    author_type = 'user'
    and author_id = auth.uid()
    and visibility = 'public'
    and exists (
      select 1
      from public.tickets t
      where t.id = ticket_messages.ticket_id
        and t.user_id = auth.uid()
    )
  );

  ----------------------------------------------------------------------
  -- Helpful index for owner views
  ----------------------------------------------------------------------
  create index if not exists idx_ticket_messages_author_created
    on public.ticket_messages (author_id, created_at desc);

end$$;

-- =====================================================================
-- End of policies/messages_policies.sql
-- =====================================================================
