-- =====================================================================
-- Polaris Core - RLS Policies for public.affiliate_payouts
-- File: ops/supabase/policies/affiliate_payouts.sql
--
-- Actual table (from 0019_affiliates.sql, simplified):
--   id                uuid primary key default gen_random_uuid()
--   affiliate_id      uuid not null references public.affiliates(id)
--   affiliate_user_id uuid references public.profiles(id) on delete set null
--   payee_user_id     uuid references public.profiles(id) on delete set null
--   amount_minor      bigint not null
--   currency          text not null default 'USD'
--   status            public.payout_status not null default 'pending'
--   period_start      date
--   period_end        date
--   notes             text
--   tx_ref            text
--   failure_reason    text
--   metadata          jsonb not null default '{}'::jsonb
--   created_by        uuid references public.profiles(id) on delete set null
--   scheduled_at      timestamptz
--   approved_at       timestamptz
--   paid_at           timestamptz
--   created_at        timestamptz not null default now()
--   updated_at        timestamptz not null default now()
--
-- Dependencies:
--   function public.is_admin() returns boolean
--
-- Policy intent:
--   • Admin has full CRUD
--   • Affiliates can read their own payout rows (affiliate_user_id)
--   • Payee can read payouts where they are payee_user_id
--   • Inserts/updates/deletes are service role or backend only
--
-- Date: 2025-11-14
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
      and c.relname = 'affiliate_payouts'
  ) then
    raise notice 'public.affiliate_payouts not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS
  alter table public.affiliate_payouts
    enable row level security;

  -- Public should never access payouts directly
  revoke all on public.affiliate_payouts from anon;

  -- Drop existing policies so we can reapply a clean, unified set
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename = 'affiliate_payouts'
  loop
    execute format('drop policy %I on public.affiliate_payouts;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control (select/insert/update/delete)
  ----------------------------------------------------------------------
  create policy "affiliate_payouts_admin_all"
  on public.affiliate_payouts
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Affiliates: read their own payouts (by affiliate_user_id)
  ----------------------------------------------------------------------
  create policy "affiliate_payouts_select_by_affiliate_owner"
  on public.affiliate_payouts
  as permissive
  for select
  to authenticated
  using (affiliate_user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Payee: read payouts where they are the payee_user_id
  ----------------------------------------------------------------------
  create policy "affiliate_payouts_select_by_payee"
  on public.affiliate_payouts
  as permissive
  for select
  to authenticated
  using (payee_user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Helpful indexes (aligned with 0019_affiliates.sql)
  ----------------------------------------------------------------------
  -- Owner + paid_at
  create index if not exists idx_aff_payouts_aff_owner_paid
    on public.affiliate_payouts (affiliate_user_id, paid_at desc);

  -- Status + created_at (for admin dashboards)
  create index if not exists idx_aff_payouts_status
    on public.affiliate_payouts (status, created_at desc);

  -- Payee lookups
  create index if not exists idx_aff_payouts_payee
    on public.affiliate_payouts (payee_user_id);

  -- Optional: time window queries by payout period
  create index if not exists idx_aff_payouts_period
    on public.affiliate_payouts (period_end, period_start);

end$$;

-- Optional constraint for status values (if you ever drop the enum)
-- alter table public.affiliate_payouts
--   add constraint chk_affiliate_payouts_status
--   check (status in ('pending','approved','paid','failed','reversed'));
