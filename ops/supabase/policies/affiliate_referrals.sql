-- =====================================================================
-- Polaris Core - RLS Policies for public.affiliate_referrals
-- File: ops/supabase/policies/affiliate_referrals.sql
--
-- Expected table (adjust to your actual schema if needed):
--   id                uuid primary key default gen_random_uuid()
--   affiliate_id      uuid not null              -- FK to affiliate entity
--   affiliate_user_id uuid not null              -- owner user of the affiliate
--   -- referred_user_id uuid                     -- optional, referred user
--   referral_code     text not null              -- public code used during signup
--   status            text not null              -- 'clicked' | 'signed_up' | 'qualified' | 'paid'
--   first_touch_at    timestamptz
--   last_touch_at     timestamptz
--   metadata          jsonb not null default '{}'::jsonb
--   created_at        timestamptz not null default now()
--   updated_at        timestamptz not null default now()
--
-- Dependencies:
--   function public.is_admin() returns boolean
--
-- Policy intent:
--   - Admin has full CRUD
--   - Affiliates can read their own referral rows (affiliate_user_id)
--   - Optionally, referred signed in users can read rows where they are the referred user
--     if a referred_user_id column exists
--   - Inserts and updates are server side only via jobs or webhooks
--   - Deletes are admin only
--
-- Date: 2025-11-14 (Asia/Manila)
-- =====================================================================

do $$
declare
  policy_name text;
  has_referred_user boolean;
begin
  -- Ensure table exists
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'affiliate_referrals'
  ) then
    raise notice 'public.affiliate_referrals not found. Skipping policies.';
    return;
  end if;

  -- Check whether referred_user_id column exists in this project
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'affiliate_referrals'
      and column_name  = 'referred_user_id'
  ) into has_referred_user;

  -- Enable RLS
  alter table public.affiliate_referrals
    enable row level security;

  -- Block unauthenticated completely
  revoke all on public.affiliate_referrals from anon;

  -- Drop existing policies to reapply a clean set
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'affiliate_referrals'
  loop
    execute format('drop policy %I on public.affiliate_referrals;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control (select, insert, update, delete)
  ----------------------------------------------------------------------
  create policy "affiliate_referrals_admin_all"
  on public.affiliate_referrals
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Affiliates: can read their own referrals
  -- Rows where affiliate_user_id matches current auth user
  ----------------------------------------------------------------------
  create policy "affiliate_referrals_select_by_affiliate_owner"
  on public.affiliate_referrals
  as permissive
  for select
  to authenticated
  using (affiliate_user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Referred users: may read referrals that reference their account
  -- Only created if the referred_user_id column actually exists
  ----------------------------------------------------------------------
  if has_referred_user then
    create policy "affiliate_referrals_select_by_referred_user"
    on public.affiliate_referrals
    as permissive
    for select
    to authenticated
    using (referred_user_id = auth.uid());
  end if;

  ----------------------------------------------------------------------
  -- No user inserts, updates, or deletes
  -- Use service role for writing via jobs or webhooks
  ----------------------------------------------------------------------

  ----------------------------------------------------------------------
  -- Helpful indexes
  ----------------------------------------------------------------------
  create index if not exists idx_aff_referrals_aff_owner_last_touch
    on public.affiliate_referrals (affiliate_user_id, last_touch_at desc);

  create index if not exists idx_aff_referrals_affiliate_id_status
    on public.affiliate_referrals (affiliate_id, status);

  -- Only create referred_user index if column exists
  if has_referred_user then
    create index if not exists idx_aff_referrals_referred_user
      on public.affiliate_referrals (referred_user_id);
  end if;

  create index if not exists idx_aff_referrals_code
    on public.affiliate_referrals (referral_code);

end$$;

-- Optional constraint for status values
-- alter table public.affiliate_referrals
--   add constraint chk_affiliate_referrals_status
--   check (status in ('clicked','signed_up','qualified','paid'));
