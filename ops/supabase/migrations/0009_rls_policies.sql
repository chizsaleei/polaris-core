-- =====================================================================
-- 0009_rls_policies.sql
-- Row Level Security enablement and baseline policies (idempotent, guarded)
-- Prereqs:
--   - public.is_admin() exists and returns true for admins
--   - This file will SKIP missing tables or missing columns
-- =====================================================================

-------------------------------
-- 0) Small helpers
-------------------------------
create or replace function public._has_table(p_schema text, p_table text)
returns boolean language sql stable as $$
  select exists(
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = p_schema
      and c.relname = p_table
      and c.relkind in ('r','p','m','v')
  );
$$;

create or replace function public._has_column(p_schema text, p_table text, p_column text)
returns boolean language sql stable as $$
  select exists(
    select 1
    from information_schema.columns
    where table_schema = p_schema
      and table_name   = p_table
      and column_name  = p_column
  );
$$;

create or replace function public._enable_rls_if_exists(p_schema text, p_table text)
returns void language plpgsql as $$
begin
  if public._has_table(p_schema, p_table) then
    execute format('alter table %I.%I enable row level security', p_schema, p_table);
  end if;
end;
$$;

-- Generic policy creator that skips if table or policy does not fit
create or replace function public._ensure_policy(
  p_schema text,
  p_table  text,
  p_policy text,
  p_cmd    text,   -- select | insert | update | delete | all
  p_roles  text,   -- 'authenticated' or 'anon, authenticated'
  p_using  text default null,
  p_check  text default null
) returns void
language plpgsql
security definer
as $fn$
declare
  stmt text;
begin
  if not public._has_table(p_schema, p_table) then
    return;
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = p_schema
      and tablename  = p_table
      and policyname = p_policy
  ) then
    return;
  end if;

  stmt := format('create policy %I on %I.%I for %s to %s',
                 p_policy, p_schema, p_table, p_cmd, p_roles);

  if p_cmd in ('select','update','delete','all') and p_using is not null then
    stmt := stmt || ' using (' || p_using || ')';
  end if;
  if p_cmd in ('insert','update','all') and p_check is not null then
    stmt := stmt || ' with check (' || p_check || ')';
  end if;

  execute stmt;
end;
$fn$;

-------------------------------
-- 1) Enable RLS on known tables
-------------------------------
-- User identity and sessions
select public._enable_rls_if_exists('public','profiles');
select public._enable_rls_if_exists('public','sessions');

-- Core content
select public._enable_rls_if_exists('public','drills');
select public._enable_rls_if_exists('public','drill_items');
select public._enable_rls_if_exists('public','drill_sets');
select public._enable_rls_if_exists('public','drill_set_items');

-- Learning artifacts
select public._enable_rls_if_exists('public','assignments');
select public._enable_rls_if_exists('public','attempts');
select public._enable_rls_if_exists('public','transcripts');
select public._enable_rls_if_exists('public','key_expressions');
select public._enable_rls_if_exists('public','vocabulary');
select public._enable_rls_if_exists('public','goals');

-- Tickets and messaging
select public._enable_rls_if_exists('public','support_tickets');
select public._enable_rls_if_exists('public','messages');
select public._enable_rls_if_exists('public','notifications');
select public._enable_rls_if_exists('public','admin_messages');

-- Entitlements and payments
select public._enable_rls_if_exists('public','entitlements');
select public._enable_rls_if_exists('public','limits');
select public._enable_rls_if_exists('public','payments_events');

-- Recommendations and outbound sends
select public._enable_rls_if_exists('public','resource_sends');
select public._enable_rls_if_exists('public','product_recommendations');

-- Affiliates
select public._enable_rls_if_exists('public','affiliate_events');
select public._enable_rls_if_exists('public','affiliate_referrals');
select public._enable_rls_if_exists('public','affiliate_payouts');

-- Later migrations in your tree (guarded)
select public._enable_rls_if_exists('public','embeddings');
select public._enable_rls_if_exists('public','practice_packs');
select public._enable_rls_if_exists('public','practice_pack_items');
select public._enable_rls_if_exists('public','editorial_reviews');
select public._enable_rls_if_exists('public','review_assignments');
select public._enable_rls_if_exists('public','diagnostics');
select public._enable_rls_if_exists('public','adaptive_sessions');
select public._enable_rls_if_exists('public','adaptive_items');
select public._enable_rls_if_exists('public','shopify_cache');
select public._enable_rls_if_exists('public','filters');
select public._enable_rls_if_exists('public','limits_and_tiers'); -- if used as a table
select public._enable_rls_if_exists('public','tiers');
select public._enable_rls_if_exists('public','reconciliation_jobs');
select public._enable_rls_if_exists('public','events');       -- analytics
select public._enable_rls_if_exists('public','daily_usage');  -- analytics aggregates
select public._enable_rls_if_exists('public','realtime_tokens');
select public._enable_rls_if_exists('public','paymongo_events');
select public._enable_rls_if_exists('public','paypal_events');

---------------------------------------------------
-- 2) Admin ALL on every target table listed above
---------------------------------------------------
do $$
declare
  t text;
  tbls text[] := array[
    'profiles','sessions',
    'drills','drill_items','drill_sets','drill_set_items',
    'assignments','attempts','transcripts','key_expressions','vocabulary','goals',
    'support_tickets','messages','notifications','admin_messages',
    'entitlements','limits','payments_events',
    'resource_sends','product_recommendations',
    'affiliate_events','affiliate_referrals','affiliate_payouts',
    'embeddings','practice_packs','practice_pack_items',
    'editorial_reviews','review_assignments',
    'diagnostics','adaptive_sessions','adaptive_items',
    'shopify_cache','filters',
    'limits_and_tiers','tiers',
    'reconciliation_jobs',
    'events','daily_usage',
    'realtime_tokens',
    'paymongo_events','paypal_events'
  ];
begin
  foreach t in array tbls loop
    perform public._ensure_policy('public', t, 'admin all','all','authenticated','public.is_admin()','public.is_admin()');
  end loop;
end $$;

---------------------------------------------------------
-- 3) Owner policies for user scoped tables (guarded)
---------------------------------------------------------
-- Profiles
select public._ensure_policy('public','profiles', 'own profile read',   'select','authenticated','id = auth.uid()', null);
select public._ensure_policy('public','profiles', 'own profile update', 'update','authenticated','id = auth.uid()', null);

-- Sessions
select public._ensure_policy('public','sessions','own sessions read',   'select','authenticated','user_id = auth.uid()', null);
select public._ensure_policy('public','sessions','own sessions write',  'insert','authenticated',null,'user_id = auth.uid()');
select public._ensure_policy('public','sessions','own sessions update', 'update','authenticated','user_id = auth.uid()', null);

-- Simple user_id tables
do $$
begin
  if public._has_column('public','assignments','user_id') then
    perform public._ensure_policy('public','assignments','own assignments read','select','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','transcripts','user_id') then
    perform public._ensure_policy('public','transcripts','own transcripts read','select','authenticated','user_id = auth.uid()', null);
    perform public._ensure_policy('public','transcripts','own transcripts write','insert','authenticated',null,'user_id = auth.uid()');
  end if;

  if public._has_column('public','key_expressions','user_id') then
    perform public._ensure_policy('public','key_expressions','own key_expressions read','select','authenticated','user_id = auth.uid()', null);
    perform public._ensure_policy('public','key_expressions','own key_expressions write','insert','authenticated',null,'user_id = auth.uid()');
    perform public._ensure_policy('public','key_expressions','own key_expressions update','update','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','vocabulary','user_id') then
    perform public._ensure_policy('public','vocabulary','own vocabulary read','select','authenticated','user_id = auth.uid()', null);
    perform public._ensure_policy('public','vocabulary','own vocabulary write','insert','authenticated',null,'user_id = auth.uid()');
    perform public._ensure_policy('public','vocabulary','own vocabulary update','update','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','goals','user_id') then
    perform public._ensure_policy('public','goals','own goals read','select','authenticated','user_id = auth.uid()', null);
    perform public._ensure_policy('public','goals','own goals write','insert','authenticated',null,'user_id = auth.uid()');
    perform public._ensure_policy('public','goals','own goals update','update','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','support_tickets','user_id') then
    perform public._ensure_policy('public','support_tickets','own tickets read','select','authenticated','user_id = auth.uid()', null);
    perform public._ensure_policy('public','support_tickets','own tickets write','insert','authenticated',null,'user_id = auth.uid()');
    perform public._ensure_policy('public','support_tickets','own tickets update','update','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','messages','user_id') then
    perform public._ensure_policy('public','messages','own messages read','select','authenticated','user_id = auth.uid()', null);
    perform public._ensure_policy('public','messages','own messages write','insert','authenticated',null,'user_id = auth.uid()');
  end if;

  if public._has_column('public','notifications','user_id') then
    perform public._ensure_policy('public','notifications','own notifications read','select','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','entitlements','user_id') then
    perform public._ensure_policy('public','entitlements','own entitlements read','select','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','limits','user_id') then
    perform public._ensure_policy('public','limits','own limits read','select','authenticated','user_id = auth.uid()', null);
    perform public._ensure_policy('public','limits','own limits update','update','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','payments_events','user_id') then
    perform public._ensure_policy('public','payments_events','own payments_events read','select','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','resource_sends','user_id') then
    perform public._ensure_policy('public','resource_sends','own resource_sends read','select','authenticated','user_id = auth.uid()', null);
  end if;

  if public._has_column('public','product_recommendations','user_id') then
    perform public._ensure_policy('public','product_recommendations','own product_recs read','select','authenticated','user_id is null or user_id = auth.uid()', null);
  end if;

  if public._has_column('public','affiliate_events','user_id') then
    perform public._ensure_policy('public','affiliate_events','affiliate events read own or public','select','authenticated','user_id = auth.uid() or user_id is null', null);
    perform public._ensure_policy('public','affiliate_events','affiliate events insert self','insert','authenticated',null,'user_id = auth.uid() or user_id is null');
  end if;

  if public._has_column('public','affiliate_referrals','referrer_user_id') or public._has_column('public','affiliate_referrals','referred_user_id') then
    perform public._ensure_policy('public','affiliate_referrals','affiliate referrals read own','select','authenticated','referrer_user_id = auth.uid() or referred_user_id = auth.uid()', null);
  end if;

  if public._has_column('public','affiliate_payouts','user_id') then
    perform public._ensure_policy('public','affiliate_payouts','affiliate payouts read own','select','authenticated','user_id = auth.uid()', null);
  end if;

  -- Extra user owned tables from later migrations, if present
  if public._has_column('public','practice_packs','user_id') then
    perform public._ensure_policy('public','practice_packs','own practice_packs read','select','authenticated','user_id = auth.uid()', null);
  end if;
  if public._has_column('public','practice_pack_items','user_id') then
    perform public._ensure_policy('public','practice_pack_items','own practice_pack_items read','select','authenticated','user_id = auth.uid()', null);
  end if;
  if public._has_column('public','events','user_id') then
    perform public._ensure_policy('public','events','own events read','select','authenticated','user_id = auth.uid()', null);
  end if;
  if public._has_column('public','daily_usage','user_id') then
    perform public._ensure_policy('public','daily_usage','own daily_usage read','select','authenticated','user_id = auth.uid()', null);
  end if;
end $$;

-- attempts often references sessions via session_id
do $$
begin
  if public._has_table('public','attempts')
     and public._has_column('public','attempts','session_id')
     and public._has_table('public','sessions')
     and public._has_column('public','sessions','user_id') then

    -- read own attempts
    perform public._ensure_policy(
      'public','attempts','own attempts read','select','authenticated',
      'exists (select 1 from public.sessions s where s.id = attempts.session_id and s.user_id = auth.uid())',
      null
    );

    -- insert own attempts (server inserts on behalf of user)
    perform public._ensure_policy(
      'public','attempts','own attempts insert','insert','authenticated',
      null,
      'exists (select 1 from public.sessions s where s.id = attempts.session_id and s.user_id = auth.uid())'
    );
  end if;
end $$;

----------------------------------------------------------
-- 4) Public catalog read for published items
----------------------------------------------------------
do $$
begin
  if public._has_column('public','drills','state') then
    perform public._ensure_policy(
      'public','drills',
      'catalog read published drills',
      'select','anon, authenticated',
      'lower(state::text) = ''published''',
      null
    );
  end if;
  if public._has_column('public','drill_sets','state') then
    perform public._ensure_policy(
      'public','drill_sets',
      'catalog read published drill_sets',
      'select','anon, authenticated',
      'lower(state::text) = ''published''',
      null
    );
  end if;
  if public._has_column('public','drill_items','state') then
    perform public._ensure_policy(
      'public','drill_items',
      'catalog read published drill_items',
      'select','anon, authenticated',
      'lower(state::text) = ''published''',
      null
    );
  end if;
  -- You can add drill_set_items later if that table exists and both sides are published
end $$;

----------------------------------------------------
-- 5) Creator edit rights for drafts
----------------------------------------------------
do $$
declare
  cond text := 'created_by = auth.uid() and lower(state::text) in (''draft'',''auto qa'',''auto_qa'',''in review'',''in_review'')';
begin
  if public._has_column('public','drills','created_by') and public._has_column('public','drills','state') then
    perform public._ensure_policy(
      'public','drills',
      'creator manage own drills (draft)',
      'all','authenticated',
      cond,
      'created_by = auth.uid()'
    );
  end if;
  if public._has_column('public','drill_items','created_by') and public._has_column('public','drill_items','state') then
    perform public._ensure_policy(
      'public','drill_items',
      'creator manage own drill_items (draft)',
      'all','authenticated',
      cond,
      'created_by = auth.uid()'
    );
  end if;
  if public._has_column('public','drill_sets','created_by') and public._has_column('public','drill_sets','state') then
    perform public._ensure_policy(
      'public','drill_sets',
      'creator manage own drill_sets (draft)',
      'all','authenticated',
      cond,
      'created_by = auth.uid()'
    );
  end if;
end $$;

----------------------------------------------------------
-- 6) Admin messages public read when state exists
----------------------------------------------------------
do $$
begin
  if public._has_column('public','admin_messages','state') then
    perform public._ensure_policy(
      'public','admin_messages',
      'admin_messages read published',
      'select','anon, authenticated',
      'lower(state::text) = ''published''',
      null
    );
  end if;
end $$;

----------------------------------------------------------
-- 7) Revoke blanket PUBLIC grants on target tables
----------------------------------------------------------
do $$
declare
  r record;
  names text[] := array[
    'profiles','sessions',
    'drills','drill_items','drill_sets','drill_set_items',
    'assignments','attempts','transcripts','key_expressions','vocabulary','goals',
    'support_tickets','messages','notifications','admin_messages',
    'entitlements','limits','payments_events',
    'resource_sends','product_recommendations',
    'affiliate_events','affiliate_referrals','affiliate_payouts',
    'embeddings','practice_packs','practice_pack_items',
    'editorial_reviews','review_assignments',
    'diagnostics','adaptive_sessions','adaptive_items',
    'shopify_cache','filters',
    'limits_and_tiers','tiers',
    'reconciliation_jobs',
    'events','daily_usage',
    'realtime_tokens',
    'paymongo_events','paypal_events'
  ];
begin
  for r in
    select quote_ident('public') as s, quote_ident(n) as t
    from unnest(names) as n
    where public._has_table('public', n)
  loop
    execute format('revoke all on table %s.%s from public', r.s, r.t);
  end loop;
end $$;

---------------------------
-- 8) Cleanup helpers
---------------------------
drop function if exists public._enable_rls_if_exists(text,text);
drop function if exists public._ensure_policy(text,text,text,text,text,text,text);
drop function if exists public._has_table(text,text);
drop function if exists public._has_column(text,text,text);

-- =====================================================================
-- End 0009_rls_policies.sql
-- =====================================================================
