-- =====================================================================
-- Polaris Core - Helper: public.is_admin()
-- File: ops/supabase/policies/is_admin.sql
--
-- Contract:
--   Returns TRUE if the caller (or provided uid) is an admin.
--   Admin is defined as:
--     • service_role JWT, OR
--     • profiles.is_admin = TRUE, OR
--     • profiles.role IN ('admin','owner')
--
-- Notes:
--   • Depends on table public.profiles with columns:
--       id uuid PK, is_admin boolean, role user_role
--   • Use in RLS policies: using (public.is_admin())
-- =====================================================================

-- Ensure the columns exist (idempotent)
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'profiles'
      and column_name  = 'id'
  ) then
    -- Add soft defaults only if missing
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'profiles'
        and column_name  = 'is_admin'
    ) then
      alter table public.profiles
        add column is_admin boolean not null default false;
    end if;

    if not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'profiles'
        and column_name  = 'role'
    ) then
      -- In older schemas this may already be user_role; this guard only
      -- runs when the column is missing.
      alter table public.profiles
        add column role text not null default 'user';
    end if;
  end if;
end $$;

-- Clean up old 1-arg version that had a default parameter
drop function if exists public.is_admin(uuid);

-- Core helper: 1-arg variant (no default; used by RPCs or server code)
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
as $fn$
  select coalesce(
           auth.role() = 'service_role'
           or exists (
                select 1
                from public.profiles p
                where p.id = uid
                  and (
                    coalesce(p.is_admin, false) = true
                    or p.role::text in ('admin','owner')
                  )
           ),
           false
         );
$fn$;

-- Zero-arg convenience wrapper for RLS policies
create or replace function public.is_admin()
returns boolean
language sql
stable
as $fn$
  select public.is_admin(auth.uid());
$fn$;

-- Optional guard that raises if not admin (useful in RPCs)
create or replace function public.assert_admin(uid uuid default auth.uid())
returns void
language plpgsql
stable
as $fn$
begin
  if not public.is_admin(uid) then
    raise exception 'admin privileges required';
  end if;
end;
$fn$;

-- Grants to allow usage from API
grant execute on function public.is_admin()          to anon, authenticated, service_role;
grant execute on function public.is_admin(uuid)      to anon, authenticated, service_role;
grant execute on function public.assert_admin(uuid)  to anon, authenticated, service_role;

-- =====================================================================
-- End of policies/is_admin.sql
-- =====================================================================
