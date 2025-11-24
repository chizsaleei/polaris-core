-- =====================================================================
-- Polaris Core - RLS Policies for public.limits
-- File: ops/supabase/policies/limits.sql
--
-- Assumed table (adjust if your schema differs):
--   id                  uuid primary key default gen_random_uuid()
--   user_id             uuid null              -- null means tier or global default
--   tier                text not null          -- 'free' | 'pro' | 'vip' or similar
--   coach_max           int  not null
--   daily_minutes_max   int  not null
--   session_minutes_max int  not null
--   cooldown_seconds    int  not null default 0
--   created_at          timestamptz default now()
--   updated_at          timestamptz default now()
--
-- Dependencies:
--   function public.is_admin() returns boolean
--
-- Policy intent:
--   • Users can read rows where user_id is null (tier defaults) or user_id = auth.uid()
--   • Only admins can create, update, or delete limits and overrides
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
      and c.relname = 'limits'
  ) then
    raise notice 'public.limits not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.limits enable row level security;
  revoke all on public.limits from anon;

  -- Drop existing policies to re-apply cleanly
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'limits'
  loop
    execute format('drop policy %I on public.limits;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "limits_admin_all"
  on public.limits
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Users: read tier defaults and their own overrides
  ----------------------------------------------------------------------
  create policy "limits_user_select_defaults_and_own"
  on public.limits
  as permissive
  for select
  to authenticated
  using (
    user_id is null
    or user_id = auth.uid()
  );

  ----------------------------------------------------------------------
  -- No user insert, update, or delete
  -- Those operations are admin only via limits_admin_all
  ----------------------------------------------------------------------

  ----------------------------------------------------------------------
  -- Helpful indexes (guarded on column existence)
  ----------------------------------------------------------------------
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'limits'
      and column_name  = 'user_id'
  ) then
    create index if not exists idx_limits_user_id
      on public.limits (user_id);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'limits'
      and column_name  = 'tier'
  ) then
    create index if not exists idx_limits_tier
      on public.limits (tier);
  end if;

end$$;

-- Optional constraints to harden data quality
-- alter table public.limits
--   add constraint chk_limits_tier check (tier in ('free','pro','vip'));
