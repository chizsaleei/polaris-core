-- =====================================================================
-- 0029_remove_adyen.sql
-- Purpose: Safely remove legacy Adyen-specific schema artifacts if they exist.
-- This migration is idempotent and does nothing if 0022_adyen_core.sql
-- (or equivalent) was never applied.
-- Order of operations:
--   1) Drop views depending on Adyen tables
--   2) Drop RLS policies on Adyen tables
--   3) Drop triggers on Adyen tables
--   4) Drop Adyen functions (best-effort)
--   5) Drop Adyen tables
--   6) Drop Adyen enum types
-- =====================================================================

-- 0) Quick notice to logs about presence of Adyen artifacts
DO $$
DECLARE
  rels int;
BEGIN
  SELECT count(*) INTO rels
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m') AND c.relname LIKE 'adyen%';
  IF rels = 0 THEN
    RAISE NOTICE 'No Adyen artifacts found. 0029_remove_adyen.sql will be a no-op.';
  ELSE
    RAISE NOTICE 'Adyen artifacts detected. Proceeding with cleanup.';
  END IF;
END$$;

-- 1) Drop views that might depend on Adyen tables ----------------------
DROP VIEW IF EXISTS public.v_adyen_events_flat CASCADE;

-- 2) Drop RLS policies on Adyen tables --------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'adyen_payments', 'adyen_payment_intents', 'adyen_orders',
        'adyen_captures', 'adyen_events', 'adyen_price_map'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END$$;

-- Disable RLS if tables exist (so drops cannot be blocked by policies)
DO $$
BEGIN
  IF to_regclass('public.adyen_payments') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.adyen_payments DISABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.adyen_payment_intents') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.adyen_payment_intents DISABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.adyen_orders') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.adyen_orders DISABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.adyen_captures') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.adyen_captures DISABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.adyen_events') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.adyen_events DISABLE ROW LEVEL SECURITY';
  END IF;
  IF to_regclass('public.adyen_price_map') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.adyen_price_map DISABLE ROW LEVEL SECURITY';
  END IF;
END$$;

-- 3) Drop triggers on Adyen tables ------------------------------------
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN
    SELECT tg.tgname, n.nspname, c.relname
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT tg.tgisinternal
      AND n.nspname = 'public'
      AND c.relname IN (
        'adyen_payments','adyen_payment_intents','adyen_orders',
        'adyen_captures','adyen_events','adyen_price_map'
      )
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', t.tgname, t.nspname, t.relname);
  END LOOP;
END$$;

-- 4) Drop likely Adyen functions (best-effort with guarded signatures) -
DO $$
BEGIN
  BEGIN
    EXECUTE 'DROP FUNCTION IF EXISTS public.adyen_log_event(text, text, text, jsonb, timestamptz)';
  EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN
    EXECUTE 'DROP FUNCTION IF EXISTS public.adyen_log_event(text, text, jsonb, timestamptz)';
  EXCEPTION WHEN undefined_function THEN NULL; END;
  BEGIN
    EXECUTE 'DROP FUNCTION IF EXISTS public.adyen_try_lock(text)';
  EXCEPTION WHEN undefined_function THEN NULL; END;
END$$;

-- 5) Drop Adyen tables -------------------------------------------------
DROP TABLE IF EXISTS public.adyen_captures      CASCADE;
DROP TABLE IF EXISTS public.adyen_orders        CASCADE;
DROP TABLE IF EXISTS public.adyen_payments      CASCADE;
DROP TABLE IF EXISTS public.adyen_payment_intents CASCADE;
DROP TABLE IF EXISTS public.adyen_events        CASCADE;
DROP TABLE IF EXISTS public.adyen_price_map     CASCADE;

-- 6) Drop Adyen enum types --------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'adyen_payment_status') THEN
    EXECUTE 'DROP TYPE public.adyen_payment_status';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'adyen_order_status') THEN
    EXECUTE 'DROP TYPE public.adyen_order_status';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'adyen_capture_status') THEN
    EXECUTE 'DROP TYPE public.adyen_capture_status';
  END IF;
END$$;

-- 7) Final notice ------------------------------------------------------
DO $$
BEGIN
  RAISE NOTICE 'Adyen cleanup migration 0029 executed.';
END$$;
