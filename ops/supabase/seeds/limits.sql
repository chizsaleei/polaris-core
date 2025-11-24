-- =====================================================================
-- seeds/limits.sql
-- Purpose: Seed default tier pricing and per-plan limits
-- Notes:
-- - Idempotent: uses ON CONFLICT to update existing rows.
-- - Aligned with 0017_limits_and_tiers.sql:
--     • public.tier_plans(code tier_code, price_month_cents, price_year_cents, ...)
--     • public.tier_limits(plan_id uuid, key public.limit_key, value_num, value_bool, note)
-- =====================================================================

-- ----------------------------
-- Tier plans (pricing metadata)
-- ----------------------------
insert into public.tier_plans as p
  (code, name, price_month_cents, price_year_cents, currency, is_active, created_at, updated_at)
values
  ('free','Free', 0,    0,    'USD', true, now(), now()),
  ('pro', 'Pro',  1299, 9900, 'USD', true, now(), now()),
  ('vip', 'VIP',  2900, 19900,'USD', true, now(), now())
on conflict (code) do update
set name              = excluded.name,
    price_month_cents = excluded.price_month_cents,
    price_year_cents  = excluded.price_year_cents,
    currency          = excluded.currency,
    is_active         = excluded.is_active,
    updated_at        = now();

-- =====================================================================
-- Per-plan limits
-- Keys are enums from public.limit_key:
--   'realtime_minutes_daily', 'active_coaches', 'tools_unlocked',
--   'cooldown_days', 'tts_chars_daily', 'uploads_mb_daily',
--   'vocab_full_access', 'share_tryouts_daily'
-- We override the defaults seeded in 0017 where needed.
-- =====================================================================

-- FREE plan limits
insert into public.tier_limits as tl
  (plan_id, key, value_num, value_bool, note, created_at, updated_at)
values
  (
    (select id from public.tier_plans where code = 'free'),
    'realtime_minutes_daily'::public.limit_key,
    10, null,
    'Daily realtime practice minutes (Free).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'free'),
    'active_coaches'::public.limit_key,
    1, null,
    'Max active coaches (Free).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'free'),
    'tools_unlocked'::public.limit_key,
    1, null,
    'Max tools/features unlocked (Free).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'free'),
    'cooldown_days'::public.limit_key,
    7, null,
    'Coach switch cooldown in days (Free/Pro baseline).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'free'),
    'tts_chars_daily'::public.limit_key,
    2000, null,
    'TTS characters per day (Free).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'free'),
    'uploads_mb_daily'::public.limit_key,
    25, null,
    'Upload MB per day (Free).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'free'),
    'share_tryouts_daily'::public.limit_key,
    1, null,
    'Shareable tryouts per day (Free).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'free'),
    'vocab_full_access'::public.limit_key,
    null, false,
    'Full vocab filters & meanings enabled (Free = false).',
    now(), now()
  )
on conflict (plan_id, key) do update
set value_num = excluded.value_num,
    value_bool = excluded.value_bool,
    note       = excluded.note,
    updated_at = now();

-- PRO plan limits
insert into public.tier_limits as tl
  (plan_id, key, value_num, value_bool, note, created_at, updated_at)
values
  (
    (select id from public.tier_plans where code = 'pro'),
    'realtime_minutes_daily'::public.limit_key,
    30, null,
    'Daily realtime practice minutes (Pro).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'pro'),
    'active_coaches'::public.limit_key,
    1, null,
    'Max active coaches (Pro).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'pro'),
    'tools_unlocked'::public.limit_key,
    3, null,
    'Max tools/features unlocked (Pro).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'pro'),
    'cooldown_days'::public.limit_key,
    7, null,
    'Coach switch cooldown in days (Pro).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'pro'),
    'tts_chars_daily'::public.limit_key,
    20000, null,
    'TTS characters per day (Pro).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'pro'),
    'uploads_mb_daily'::public.limit_key,
    250, null,
    'Upload MB per day (Pro).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'pro'),
    'share_tryouts_daily'::public.limit_key,
    3, null,
    'Shareable tryouts per day (Pro).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'pro'),
    'vocab_full_access'::public.limit_key,
    null, true,
    'Full vocab filters & meanings enabled (Pro).',
    now(), now()
  )
on conflict (plan_id, key) do update
set value_num = excluded.value_num,
    value_bool = excluded.value_bool,
    note       = excluded.note,
    updated_at = now();

-- VIP plan limits
insert into public.tier_limits as tl
  (plan_id, key, value_num, value_bool, note, created_at, updated_at)
values
  (
    (select id from public.tier_plans where code = 'vip'),
    'realtime_minutes_daily'::public.limit_key,
    1440, null,
    'Daily realtime practice minutes (VIP, effectively unbounded).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'vip'),
    'active_coaches'::public.limit_key,
    99, null,
    'Max active coaches (VIP).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'vip'),
    'tools_unlocked'::public.limit_key,
    99, null,
    'Max tools/features unlocked (VIP).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'vip'),
    'cooldown_days'::public.limit_key,
    0, null,
    'Coach switch cooldown in days (VIP; no cooldown).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'vip'),
    'tts_chars_daily'::public.limit_key,
    100000, null,
    'TTS characters per day (VIP).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'vip'),
    'uploads_mb_daily'::public.limit_key,
    1024, null,
    'Upload MB per day (VIP).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'vip'),
    'share_tryouts_daily'::public.limit_key,
    10, null,
    'Shareable tryouts per day (VIP).',
    now(), now()
  ),
  (
    (select id from public.tier_plans where code = 'vip'),
    'vocab_full_access'::public.limit_key,
    null, true,
    'Full vocab filters & meanings enabled (VIP).',
    now(), now()
  )
on conflict (plan_id, key) do update
set value_num = excluded.value_num,
    value_bool = excluded.value_bool,
    note       = excluded.note,
    updated_at = now();

-- Done.
