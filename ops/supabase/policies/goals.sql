-- =====================================================================
-- Polaris Core - RLS Policies for public.goals
-- File: ops/supabase/policies/goals.sql
--
-- Assumptions
--   • Table public.goals has at least:
--       id uuid primary key
--       user_id uuid not null                -- owner
--       coach_id text                        -- coach code the goal relates to
--       title text not null
--       description text
--       target_date date
--       status text not null default 'active'  -- active | paused | done | archived
--       tags text[]
--       created_at timestamptz default now()
--       updated_at timestamptz default now()
--   • Helper function public.is_admin() returns boolean
--
-- Intent
--   • Admins: full access
--   • Owners: full CRUD of their own goals
--   • No cross user reads of private goals
-- =====================================================================

do $$
declare
  policy_name text;
begin
  -- Ensure the table exists
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'goals'
  ) then
    raise notice 'public.goals not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.goals enable row level security;
  revoke all on public.goals from anon;

  -- Drop existing policies (including ones from migrations) for idempotency
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'goals'
  loop
    execute format('drop policy %I on public.goals;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "goals_admin_all"
  on public.goals
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Owner SELECT: read own goals
  ----------------------------------------------------------------------
  create policy "goals_owner_select"
  on public.goals
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Owner INSERT: create goals for self
  ----------------------------------------------------------------------
  create policy "goals_owner_insert"
  on public.goals
  as permissive
  for insert
  to authenticated
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Owner UPDATE: update own goals
  ----------------------------------------------------------------------
  create policy "goals_owner_update"
  on public.goals
  as permissive
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Owner DELETE: delete own goals
  ----------------------------------------------------------------------
  create policy "goals_owner_delete"
  on public.goals
  as permissive
  for delete
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Helpful indexes (guarded on column existence)
  ----------------------------------------------------------------------
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'goals'
      and column_name  = 'status'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'goals'
      and column_name  = 'target_date'
  ) then
    create index if not exists idx_goals_user_status_date
      on public.goals (user_id, status, target_date);
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'goals'
      and column_name  = 'created_at'
  ) then
    create index if not exists idx_goals_user_created
      on public.goals (user_id, created_at desc);
  end if;

end$$;

-- =====================================================================
-- Notes
--   • If later you add shared or team goals, introduce a share table and
--     extend SELECT using an exists() against that relation.
--   • Consider a check constraint to restrict status values.
-- =====================================================================
