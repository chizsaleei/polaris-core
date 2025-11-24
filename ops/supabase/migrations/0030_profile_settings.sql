-- =====================================================================
-- Polaris Core - 0030_profile_settings.sql
-- Purpose:
--   * Extend public.profiles with new preference columns gathered during checkout/onboarding
--   * Provide indexes/comments matching the backend/frontend profile types
-- =====================================================================

set check_function_bodies = off;

alter table public.profiles
  add column if not exists timezone             text,
  add column if not exists country_code         text,
  add column if not exists currency_code        text,
  add column if not exists goal                 text,
  add column if not exists daily_target_minutes integer,
  add column if not exists reminder_time_local  time,
  add column if not exists practice_focus       text,
  add column if not exists marketing_opt_in     boolean not null default false;

comment on column public.profiles.timezone is 'Preferred timezone for reminders.';
comment on column public.profiles.country_code is 'ISO country of the user.';
comment on column public.profiles.currency_code is 'Preferred currency code for pricing.';
comment on column public.profiles.goal is 'Primary coaching goal set by the user.';
comment on column public.profiles.daily_target_minutes is 'Desired daily practice minutes.';
comment on column public.profiles.reminder_time_local is 'Preferred reminder time in user timezone.';
comment on column public.profiles.practice_focus is 'Optional practice focus string.';
comment on column public.profiles.marketing_opt_in is 'Whether the user opted into marketing communications.';

create index if not exists idx_profiles_country_code on public.profiles (country_code);
create index if not exists idx_profiles_currency_code on public.profiles (currency_code);
