-- =====================================================================
-- Polaris Core - RLS Policies for public.user_exports
-- File: ops/supabase/policies/user_exports.sql
--
-- Assumed table (adjust if your schema differs):
--   id             uuid primary key default gen_random_uuid()
--   user_id        uuid not null                  -- requester and owner
--   status         text not null default 'pending' -- 'pending' | 'processing' | 'ready' | 'failed'
--   storage_path   text                           -- e.g., 'exports/{user_id}/{id}.zip'
--   size_bytes     bigint                         -- optional
--   error          text                           -- set if failed
--   requested_by   uuid                           -- admin or system actor (nullable)
--   created_at     timestamptz default now()
--   updated_at     timestamptz default now()
--   completed_at   timestamptz                    -- when ready
--
-- Dependencies:
--   function public.is_admin() returns boolean
-- Notes:
--   Download access should be controlled by signed URLs at the storage layer.
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
      and c.relname = 'user_exports'
  ) then
    raise notice 'public.user_exports not found. Skipping policies.';
    return;
  end if;

  -- Enable RLS and lock anon out
  alter table public.user_exports enable row level security;
  revoke all on public.user_exports from anon;

  -- Drop existing policies to re-apply idempotently
  for policy_name in
    select policyname
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'user_exports'
  loop
    execute format('drop policy %I on public.user_exports;', policy_name);
  end loop;

  ----------------------------------------------------------------------
  -- Admin: full control
  ----------------------------------------------------------------------
  create policy "user_exports_admin_all"
  on public.user_exports
  as permissive
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

  ----------------------------------------------------------------------
  -- Users: create export requests for themselves
  ----------------------------------------------------------------------
  create policy "user_exports_user_insert_self"
  on public.user_exports
  as permissive
  for insert
  to authenticated
  with check (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Users: read their own export rows
  ----------------------------------------------------------------------
  create policy "user_exports_user_select_own"
  on public.user_exports
  as permissive
  for select
  to authenticated
  using (user_id = auth.uid());

  ----------------------------------------------------------------------
  -- Users: delete their own rows only if pending or failed
  -- Prevents removing audit trails for completed exports
  ----------------------------------------------------------------------
  create policy "user_exports_user_delete_own_pending_failed"
  on public.user_exports
  as permissive
  for delete
  to authenticated
  using (
    user_id = auth.uid()
    and status in ('pending','failed')
  );

  ----------------------------------------------------------------------
  -- No user UPDATE. Status, storage_path, and timestamps are controlled
  -- by server jobs and admins. Admin already covered above.
  ----------------------------------------------------------------------

  ----------------------------------------------------------------------
  -- Helpful indexes
  ----------------------------------------------------------------------
  create index if not exists idx_user_exports_user_created
    on public.user_exports (user_id, created_at desc);

  create index if not exists idx_user_exports_status_created
    on public.user_exports (status, created_at desc);

  create index if not exists idx_user_exports_user_status
    on public.user_exports (user_id, status);

end$$;

-- Optional hardening (place in a migration if you use these constraints)
-- alter table public.user_exports
--   add constraint chk_user_exports_status
--   check (status in ('pending','processing','ready','failed'));
--
-- Ensure completed_at set only when ready (enforce via trigger if desired)
-- Example trigger sketch:
-- create or replace function public.user_exports_guard()
-- returns trigger language plpgsql as $fn$
-- begin
--   if not public.is_admin() then
--     -- non admins should never reach here due to policy, but double guard
--     raise exception 'Only admins or system jobs may update export records';
--   end if;
--   if new.status = 'ready' and new.completed_at is null then
--     new.completed_at := now();
--   end if;
--   return new;
-- end;
-- $fn$;
-- drop trigger if exists trg_user_exports_guard on public.user_exports;
-- create trigger trg_user_exports_guard
--   before update on public.user_exports
--   for each row execute function public.user_exports_guard();
