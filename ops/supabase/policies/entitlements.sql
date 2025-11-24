-- =====================================================================
-- Polaris Core - RLS Policies for public.entitlements
-- File: ops/supabase/policies/entitlements.sql
--
-- Assumed table (aligns with 0018_entitlements.sql):
--   id              uuid primary key default gen_random_uuid()
--   user_id         uuid not null references public.profiles(id) on delete cascade
--   plan_id         uuid not null references public.tier_plans(id) on delete restrict
--   source          public.entitlement_source not null default 'paypal'
--   status          public.entitlement_status not null default 'active'
--   starts_at       timestamptz not null
--   ends_at         timestamptz
--   subscription_id uuid references public.subscriptions(id) on delete set null
--   reason          text
--   meta            jsonb not null default '{}'::jsonb
--   created_at      timestamptz not null default now()
--   updated_at      timestamptz not null default now()
--
-- Dependencies:
--   function public.is_admin() returns boolean
--
-- Policy intent:
--    Users may read only their own rows
--    Only admins or service-role jobs write entitlements
--    Use provider webhooks / server jobs to create or update rows
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
      and c.relname = 'entitlements'
  ) then
    raise notice 'public.entitlements not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.entitlements enable row level security;
  revoke all on public.entitlements from anon;

  -- Drop existing policies to re-apply cleanly (including ones from migrations)
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'entitlements'
  loop
    execute format('drop policy %I on public.entitlements;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control (select/insert/update/delete)
  ----------------------------------------------------------------------
  create policy "entitlements_admin_all"
  on public.entitlements
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Users: read their own entitlements
  ----------------------------------------------------------------------
  create policy "entitlements_user_select_own"
  on public.entitlements
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- No user insert, update, or delete
  -- Those operations are admin only or via service role.
  ----------------------------------------------------------------------

  ----------------------------------------------------------------------
  -- Helpful indexes (aligned with 0018_entitlements.sql)
  ----------------------------------------------------------------------
  create index if not exists ent_user_time_idx
    on public.entitlements (user_id, starts_at desc);

  create index if not exists ent_status_idx
    on public.entitlements (status);

  create index if not exists ent_active_window_idx
    on public.entitlements (user_id, ends_at);

end$$;

-- Optional constraints to harden data quality (adjust as needed)
-- alter table public.entitlements
--   add constraint chk_entitlements_status
--   check (status in ('active','scheduled','expired','canceled','revoked'));
