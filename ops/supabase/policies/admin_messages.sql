-- =====================================================================
-- Polaris Core - RLS Policies for public.admin_messages
-- File: ops/supabase/policies/admin_messages.sql
--
-- Requires:
--   • Table public.admin_messages (created in 0006_admin_messages.sql)
--   • Function public.is_admin() returns boolean
--
-- Intent (safe baseline):
--   • Admins: full read/write/delete
--   • Non-admin users: no direct access via RLS
--
-- Date: 2025-11-14
-- =====================================================================

-- Ensure is_admin() exists (idempotent, matches other migrations)
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin'
      and n.nspname = 'public'
  ) then
    create or replace function public.is_admin() returns boolean
    language sql stable as $fn$
      select false
    $fn$;
  end if;
end $$;

-- Enable RLS on the table
alter table public.admin_messages
  enable row level security;

-- Start from a clean permissions baseline
revoke all on public.admin_messages from anon, authenticated;

-- Drop old policies if they exist (idempotent)
do $$
begin
  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'admin_messages'
      and policyname = 'admin_messages_admin_all'
  ) then
    drop policy "admin_messages_admin_all" on public.admin_messages;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'admin_messages'
      and policyname = 'admin_messages_user_read'
  ) then
    drop policy "admin_messages_user_read" on public.admin_messages;
  end if;

  if exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'admin_messages'
      and policyname = 'admin_messages_user_update_read_flags'
  ) then
    drop policy "admin_messages_user_update_read_flags" on public.admin_messages;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Admins: full access (select/insert/update/delete)
-- ---------------------------------------------------------------------
create policy "admin_messages_admin_all"
on public.admin_messages
as permissive
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Helpful index for admin views
create index if not exists idx_admin_messages_created_at
  on public.admin_messages (created_at desc);

-- =====================================================================
-- End of policies/admin_messages.sql
-- =====================================================================
