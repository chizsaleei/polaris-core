-- =====================================================================
-- Polaris Core - RLS Policies for public.product_recommendations
-- File: ops/supabase/policies/product_recommendations.sql
--
-- Assumptions (fits “Recommend” and “Growth” features):
--   Table public.product_recommendations has (at minimum):
--     id               uuid primary key
--     user_id          uuid                        -- null for global recs
--     coach_id         text                        -- optional coach scoping
--     tier_allow       text[] default '{Free,Pro,VIP}'::text[]  -- tiers allowed
--     country_allow    text[] default '{}'::text[] -- ISO country allow-list (empty = all)
--     kind             text not null               -- 'affiliate' | 'internal' | 'shopify' | ...
--     sku              text                        -- optional SKU or external id
--     title            text not null
--     url              text not null               -- tracked outbound link
--     price_cents      int                         -- nullable for “learn more”
--     currency         text default 'USD'
--     tags             text[] default '{}'
--     priority         int default 0               -- higher = earlier
--     active           boolean default true
--     starts_at        timestamptz                 -- optional publish window
--     ends_at          timestamptz                 -- optional publish window
--     risk_flags       jsonb default '{}'::jsonb   -- auto-QA flags
--     created_by       uuid                        -- admin
--     created_at       timestamptz default now()
--     updated_at       timestamptz default now()
--
-- Other objects assumed:
--   • public.is_admin() -> boolean
--   • public.profiles(id uuid pk, tier text, country text, ...), RLS-enabled
--
-- Intent:
--   • Admin: full CRUD (create, curate, publish/deprecate)
--   • Users (authenticated): read-only, see only active items within window and
--       - explicitly targeted to them (user_id = auth.uid()), OR
--       - global items (user_id is null) that match their tier/country filters
--   • No anonymous access
--   • All writes should go through Admin or service role
-- =====================================================================

do $$
begin
  -- Ensure table exists
  if not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'product_recommendations'
  ) then
    raise notice 'public.product_recommendations not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS
  alter table public.product_recommendations enable row level security;

  -- Drop existing policies for idempotency
  for policy_name in
    select policyname
      from pg_policies
     where schemaname = 'public'
       and tablename = 'product_recommendations'
  loop
    execute format('drop policy %I on public.product_recommendations;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "pr_admin_all"
  on public.product_recommendations
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Helper predicates used in USING to keep logic readable
  --   in_window: now() between starts_at and ends_at if provided
  --   allowed_by_tier/country: match user profile to row filters when global
  -- Notes:
  --   We embed these as SQL expressions directly inside USING.
  ----------------------------------------------------------------------

  ----------------------------------------------------------------------
  -- Authenticated users: SELECT targeted-to-me items
  ----------------------------------------------------------------------
  create policy "pr_user_select_targeted"
  on public.product_recommendations
  as permissive
  for select
  to authenticated
  using (
       active
   and (starts_at is null or now() >= starts_at)
   and (ends_at   is null or now() <= ends_at)
   and user_id = auth.uid()
  );

  ----------------------------------------------------------------------
  -- Authenticated users: SELECT global items that match tier/country filters
  -- We look up the viewer's profile to apply tier & country constraints.
  ----------------------------------------------------------------------
  create policy "pr_user_select_global"
  on public.product_recommendations
  as permissive
  for select
  to authenticated
  using (
       active
   and (starts_at is null or now() >= starts_at)
   and (ends_at   is null or now() <= ends_at)
   and user_id is null
   and exists (
         select 1
           from public.profiles p
          where p.id = auth.uid()
            -- Tier allow: if row has an allow-list, user's tier must be in it.
            and (
                  p.tier is null
               or tier_allow is null
               or cardinality(tier_allow) = 0
               or p.tier = any(tier_allow)
                )
            -- Country allow: if row has allow-list, user's country must be in it.
            and (
                  p.country is null
               or country_allow is null
               or cardinality(country_allow) = 0
               or p.country = any(country_allow)
                )
       )
  );

  ----------------------------------------------------------------------
  -- Deny all writes for non-admins by omission (no insert/update/delete policy)
  -- Admins already covered by pr_admin_all.
  ----------------------------------------------------------------------

  ----------------------------------------------------------------------
  -- Useful indexes for browse & personalization
  ----------------------------------------------------------------------
  create index if not exists idx_pr_active_window
    on public.product_recommendations (active, starts_at, ends_at);

  create index if not exists idx_pr_user_target
    on public.product_recommendations (user_id, active, priority);

  create index if not exists idx_pr_coach_priority
    on public.product_recommendations (coach_id, priority desc);

  create index if not exists idx_pr_kind_tags
    on public.product_recommendations using gin (tags);

end$$;

-- =====================================================================
-- Optional: guard rails via CHECK constraints (run once during a migration)
-- Uncomment and move into a migration if you have not set them yet.
-- alter table public.product_recommendations
--   add constraint chk_pr_kind
--     check (kind in ('affiliate','internal','shopify','info'));
--
-- alter table public.product_recommendations
--   add constraint chk_pr_price_nonneg
--     check (price_cents is null or price_cents >= 0);
--
-- alter table public.product_recommendations
--   add constraint chk_pr_dates
--     check (starts_at is null or ends_at is null or starts_at <= ends_at);
-- =====================================================================
