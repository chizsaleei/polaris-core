-- =====================================================================
-- triggers/updated_at.sql
-- Purpose: Unified trigger function to keep `updated_at` fresh on INSERT/UPDATE
-- Usage: Run after your tables are created (0001..0029). Idempotent.
-- Behavior:
--   - On UPDATE: bumps updated_at only if any field other than updated_at changed
--   - On INSERT: sets updated_at to now() if not provided
--
-- Date: 2025-11-14 (Asia/Manila)
-- =====================================================================

-- 1) Trigger function (shared by all tables)
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    -- Compare row data excluding updated_at to avoid infinite churn
    if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
      new.updated_at := now();
    end if;
    return new;

  elsif tg_op = 'INSERT' then
    if new.updated_at is null then
      new.updated_at := now();
    end if;
    return new;
  end if;

  return new;
end;
$$;

comment on function public.tg_set_updated_at() is
  'Sets updated_at = now() on UPDATE when other fields change; ensures non-null on INSERT';

-- =====================================================================
-- 2) Attach triggers to all real tables in "public" that have updated_at
--    This is dynamic and idempotent (safe to re-run).
-- =====================================================================

do $$
declare
  r record;
  trig_name text;
begin
  -- For each BASE TABLE in public schema that has an "updated_at" column
  for r in
    select
      n.nspname as table_schema,
      c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'  -- 'r' = ordinary table
      and exists (
        select 1
        from information_schema.columns col
        where col.table_schema = n.nspname
          and col.table_name   = c.relname
          and col.column_name  = 'updated_at'
      )
  loop
    trig_name := 'trg_set_updated_at_' || r.table_name;

    -- Drop existing trigger with the same name so re-runs stay clean
    execute format(
      'drop trigger if exists %I on %I.%I;',
      trig_name,
      r.table_schema,
      r.table_name
    );

    -- Create BEFORE INSERT OR UPDATE trigger using the shared function
    execute format(
      'create trigger %I
         before insert or update on %I.%I
         for each row
         execute function public.tg_set_updated_at();',
      trig_name,
      r.table_schema,
      r.table_name
    );
  end loop;
end $$;

-- Done.
