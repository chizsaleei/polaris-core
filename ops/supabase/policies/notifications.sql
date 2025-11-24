-- =====================================================================
-- Polaris Core - RLS Policies for public.notifications
-- File: ops/supabase/policies/notifications.sql
--
-- Assumed table (adjust column names if yours differ):
--   id            uuid primary key default gen_random_uuid()
--   user_id       uuid not null                  -- recipient
--   kind          text not null                  -- 'system' | 'weekly_recap' | 'billing' | ...
--   title         text not null
--   body          text                           -- optional plaintext or short markdown
--   data          jsonb default '{}'::jsonb      -- extra payload (urls, deeplinks, ids)
--   seen_at       timestamptz                    -- user has surfaced it in UI
--   read_at       timestamptz                    -- user explicitly opened it
--   created_by    uuid                           -- admin/service that created the notification
--   created_at    timestamptz default now()
--   updated_at    timestamptz default now()
--
-- Dependencies:
--   • function public.is_admin() returns boolean
--
-- Policy intent:
--   • Admins: full control (create/edit/delete for support ops and automations)
--   • Authenticated users: read only *their own* notifications; update only to set seen/read.
--   • No inserts/updates/deletes by non-admins beyond read/seen flags.
-- =====================================================================

do $$
declare
  policy_name text;
begin
  -- Ensure table exists before applying policies
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'notifications'
  ) then
    raise notice 'public.notifications not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.notifications enable row level security;
  revoke all on public.notifications from anon;

  -- Drop existing policies for clean re-apply (idempotent)
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'notifications'
  loop
    execute format('drop policy %I on public.notifications;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control (ALL)
  ----------------------------------------------------------------------
  create policy "notifications_admin_all"
  on public.notifications
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Users: SELECT their own notifications
  ----------------------------------------------------------------------
  create policy "notifications_user_select_own"
  on public.notifications
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Users: UPDATE their own notifications (mark seen/read)
  -- Note: RLS cannot restrict which columns change. Enforce column-level
  -- restrictions with a BEFORE UPDATE trigger if needed.
  ----------------------------------------------------------------------
  create policy "notifications_user_update_seen_read"
  on public.notifications
  as permissive
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- No INSERT/DELETE for non-admins (omitted on purpose).
  -- Admins already covered by notifications_admin_all.
  ----------------------------------------------------------------------

  ----------------------------------------------------------------------
  -- Helpful indexes for common UI queries (guarded on column existence)
  ----------------------------------------------------------------------
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'notifications'
      and column_name  = 'user_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'notifications'
      and column_name  = 'created_at'
  ) then
    create index if not exists idx_notifications_user_created
      on public.notifications (user_id, created_at desc);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'notifications'
      and column_name  = 'user_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'notifications'
      and column_name  = 'seen_at'
  ) then
    create index if not exists idx_notifications_user_seen
      on public.notifications (user_id, seen_at nulls first, created_at desc);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'notifications'
      and column_name  = 'user_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'notifications'
      and column_name  = 'read_at'
  ) then
    create index if not exists idx_notifications_user_read
      on public.notifications (user_id, read_at nulls first, created_at desc);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'notifications'
      and column_name  = 'kind'
  ) then
    create index if not exists idx_notifications_kind_user
      on public.notifications (kind, user_id, created_at desc);
  end if;

end$$;

-- =====================================================================
-- Optional hardening (add via a migration if desired):
-- 1) Restrict kind to a whitelist
-- alter table public.notifications
--   add constraint chk_notifications_kind
--   check (kind in ('system','weekly_recap','billing','practice','safety','admin'));
--
-- 2) Sanity: read_at/seen_at must be >= created_at
-- alter table public.notifications
--   add constraint chk_notifications_timestamps
--   check (
--     (read_at is null or read_at >= created_at) and
--     (seen_at is null or seen_at >= created_at)
--   );
-- =====================================================================
