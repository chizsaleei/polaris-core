-- =====================================================================
-- Polaris Core - RLS Policies for public.resource_sends
-- File: ops/supabase/policies/resource_sends.sql
--
-- Assumptions (aligns with “Support & success”, “Drip”, “Library share” flows)
--   Table public.resource_sends has at least:
--     id                uuid primary key
--     sender_id         uuid not null          -- owner who initiated the send (creator, system on behalf of admin)
--     recipient_id      uuid                   -- user receiving (nullable for email-only sends)
--     coach_id          text                   -- optional coach scoping
--     resource_type     text not null          -- 'drill' | 'pack' | 'session' | 'link' | 'note' | ...
--     resource_id       text                   -- id of referenced resource
--     delivery_channel  text not null          -- 'in_app' | 'email' | 'sms' | 'push'
--     status            text not null default 'queued'  -- 'queued' | 'sent' | 'failed' | 'opened'
--     payload           jsonb not null default '{}'::jsonb -- safe metadata for templating
--     risk_flags        jsonb not null default '{}'::jsonb -- auto-QA output
--     created_at        timestamptz default now()
--     updated_at        timestamptz default now()
--
--   • Helper function public.is_admin() returns boolean
--   • All writes from system jobs should use service role or SECURITY DEFINER RPCs
--
-- Intent
--   • Admins: full access
--   • Sender: full CRUD on own rows (with guardrails on deletes)
--   • Recipient: can read own incoming rows (no direct edits)
--   • No cross-tenant leakage
--   • Recipient status transitions (‘opened’) should be done through RPC to keep audit trail
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
      and c.relname = 'resource_sends'
  ) then
    raise notice 'public.resource_sends not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.resource_sends enable row level security;
  revoke all on public.resource_sends from anon;

  -- Drop existing policies (idempotent)
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'resource_sends'
  loop
    execute format('drop policy %I on public.resource_sends;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "rs_admin_all"
  on public.resource_sends
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Sender SELECT: read own sends
  ----------------------------------------------------------------------
  create policy "rs_sender_select"
  on public.resource_sends
  as permissive
  for select
  to authenticated
  using (sender_id = auth.uid());

  ----------------------------------------------------------------------
  -- Recipient SELECT: read items addressed to me (in-app inbox, recap)
  ----------------------------------------------------------------------
  create policy "rs_recipient_select"
  on public.resource_sends
  as permissive
  for select
  to authenticated
  using (recipient_id = auth.uid());

  ----------------------------------------------------------------------
  -- Sender INSERT: create sends as myself
  ----------------------------------------------------------------------
  create policy "rs_sender_insert"
  on public.resource_sends
  as permissive
  for insert
  to authenticated
  with check (sender_id = auth.uid());

  ----------------------------------------------------------------------
  -- Sender UPDATE: edit own sends
  -- Recipients do not update directly. Use SECURITY DEFINER RPCs if you
  -- need to allow recipients to mark 'opened' while preserving audit rules.
  ----------------------------------------------------------------------
  create policy "rs_sender_update"
  on public.resource_sends
  as permissive
  for update
  to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

  ----------------------------------------------------------------------
  -- Sender DELETE: allow deleting own rows only while still 'queued'
  -- Prevent historical tampering. Admins bypass via rs_admin_all.
  ----------------------------------------------------------------------
  create policy "rs_sender_delete"
  on public.resource_sends
  as permissive
  for delete
  to authenticated
  using (sender_id = auth.uid() and status = 'queued');

  ----------------------------------------------------------------------
  -- Helpful indexes for dashboards and inbox views
  ----------------------------------------------------------------------
  create index if not exists idx_rs_sender_created
    on public.resource_sends (sender_id, created_at desc);

  create index if not exists idx_rs_recipient_created
    on public.resource_sends (recipient_id, created_at desc);

  create index if not exists idx_rs_status_channel
    on public.resource_sends (status, delivery_channel);

  create index if not exists idx_rs_coach_type
    on public.resource_sends (coach_id, resource_type);

end$$;

-- =====================================================================
-- Recommended RPC for recipient open events (optional but safer)
-- Use a SECURITY DEFINER function to let recipients mark their own item as opened
-- without granting broad UPDATE rights via RLS.
-- =====================================================================
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname  = 'mark_resource_send_opened'
  ) then
    create or replace function public.mark_resource_send_opened(p_id uuid)
    returns void
    language plpgsql
    security definer
    set search_path = public
    as $f$
    begin
      update public.resource_sends
         set status    = 'opened',
             updated_at = now()
       where id           = p_id
         and recipient_id = auth.uid()
         and status in ('sent'); -- only transition from sent

      if not found then
        raise notice 'No matching row to mark opened (wrong owner or state).';
      end if;
    end;
    $f$;

    -- Lock down execution to authenticated users
    revoke all on function public.mark_resource_send_opened(uuid) from public;
    grant execute on function public.mark_resource_send_opened(uuid) to authenticated;
  end if;
end$$;

-- =====================================================================
-- Notes
--  • System jobs that change status to 'sent' or 'failed' should run with
--    service role or via SECURITY DEFINER RPC to bypass sender-only updates.
--  • Consider CHECK constraints for status and delivery_channel enumerations.
--  • Keep payload free of PII when possible; use indirection via resource_id.
-- =====================================================================
