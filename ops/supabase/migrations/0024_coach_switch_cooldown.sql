-- ===============================================================
-- 0024_coach_switch_cooldown.sql
-- Enforce cooldowns and limits for switching active coach
-- States and tiers: Free/Pro have cooldowns; VIP has none
-- Safe-by-default RLS. Server (service role) bypasses as needed.
-- Date: 2025-11-14
-- ===============================================================

-- ---------- Helpers: tier enum and admin guard (idempotent) ----------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'tier_level') then
    create type public.tier_level as enum ('free','pro','vip');
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin'
      and n.nspname = 'public'
  ) then
    create or replace function public.is_admin() returns boolean
    language sql stable
    as $fn$
      select false
    $fn$;
  end if;
end $$;

-- touch_updated_at utility (idempotent)
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'touch_updated_at'
      and n.nspname = 'public'
  ) then
    create or replace function public.touch_updated_at()
    returns trigger
    language plpgsql
    as $fn$
    begin
      new.updated_at := now();
      return new;
    end;
    $fn$;
  end if;
end $$;

-- ---------- Profiles: ensure active_coach column exists ----------
alter table if exists public.profiles
  add column if not exists active_coach text;  -- stores coach key or slug

-- ---------- Rules table: per tier cooldown and rate limits ----------
create table if not exists public.coach_switch_rules (
  tier                public.tier_level primary key,
  cooldown_days       int not null check (cooldown_days >= 0),
  max_switches_30d    int not null check (max_switches_30d >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

insert into public.coach_switch_rules (tier, cooldown_days, max_switches_30d)
values
  ('free', 14, 2),
  ('pro',   7, 4),
  ('vip',   0, 99)
on conflict (tier) do update
set cooldown_days    = excluded.cooldown_days,
    max_switches_30d = excluded.max_switches_30d,
    updated_at       = now();

drop trigger if exists trg_touch_coach_switch_rules on public.coach_switch_rules;
create trigger trg_touch_coach_switch_rules
before update on public.coach_switch_rules
for each row execute function public.touch_updated_at();

alter table public.coach_switch_rules enable row level security;
revoke all on public.coach_switch_rules from anon, authenticated;

drop policy if exists "coach_switch_rules admin read" on public.coach_switch_rules;
create policy "coach_switch_rules admin read"
on public.coach_switch_rules
for select to authenticated
using (public.is_admin());

drop policy if exists "coach_switch_rules admin write" on public.coach_switch_rules;
create policy "coach_switch_rules admin write"
on public.coach_switch_rules
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ---------- Log table: every switch attempt that succeeds ----------
create table if not exists public.coach_switches (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  from_coach     text,
  to_coach       text not null,
  reason         text,
  switched_at    timestamptz not null default now()
);

create index if not exists idx_coach_switches_user_time
  on public.coach_switches(user_id, switched_at desc);

alter table public.coach_switches enable row level security;
revoke all on public.coach_switches from anon, authenticated;

drop policy if exists "coach_switches read own" on public.coach_switches;
create policy "coach_switches read own"
on public.coach_switches
for select to authenticated
using (auth.uid() = user_id);

drop policy if exists "coach_switches admin write" on public.coach_switches;
create policy "coach_switches admin write"
on public.coach_switches
for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ---------- Effective tier resolver (idempotent, best effort) ----------
-- Tries to determine the user's current tier from entitlements or profiles.
-- Falls back to 'free' if nothing active is found.
create or replace function public.get_effective_tier(p_user uuid)
returns public.tier_level
language plpgsql stable
as $fn$
declare
  v_tier text;
begin
  -- Prefer explicit entitlements if present
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name   = 'entitlements'
  ) then
    begin
      select e.tier::text
      into v_tier
      from public.entitlements e
      where e.user_id = p_user
        and (e.active is true
             or e.expires_at is null
             or e.expires_at > now())
      order by case e.tier::text
                 when 'vip' then 3
                 when 'pro' then 2
                 else 1
               end desc
      limit 1;
    exception
      when undefined_column then
        v_tier := null;
    end;
  end if;

  -- Optional: infer from profiles.tier if your schema has it
  if v_tier is null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name   = 'profiles'
         and column_name  = 'tier'
     ) then
    select tier::text into v_tier
    from public.profiles
    where id = p_user;
  end if;

  if v_tier is null then
    return 'free';
  end if;

  return v_tier::public.tier_level;
end;
$fn$;

-- ---------- Next allowed time based on cooldown ----------
create or replace function public.coach_next_allowed_at(p_user uuid)
returns timestamptz
language plpgsql stable
as $fn$
declare
  v_tier      public.tier_level := public.get_effective_tier(p_user);
  v_cooldown  int;
  v_last      timestamptz;
begin
  select r.cooldown_days
  into v_cooldown
  from public.coach_switch_rules r
  where r.tier = v_tier;

  select cs.switched_at
  into v_last
  from public.coach_switches cs
  where cs.user_id = p_user
  order by cs.switched_at desc
  limit 1;

  if v_last is null or v_cooldown = 0 then
    return now(); -- can switch immediately
  end if;

  return v_last + (v_cooldown || ' days')::interval;
end;
$fn$;

-- ---------- Count switches in rolling 30 day window ----------
create or replace function public.coach_switches_30d(p_user uuid)
returns integer
language sql stable
as $fn$
  select count(*)::int
  from public.coach_switches cs
  where cs.user_id = p_user
    and cs.switched_at >= now() - interval '30 days'
$fn$;

-- ---------- Eligibility check ----------
create or replace function public.can_switch_coach(
  p_user     uuid,
  p_to_coach text
) returns table(
  ok              boolean,
  reason          text,
  next_allowed_at timestamptz
)
language plpgsql stable
as $fn$
declare
  v_tier   public.tier_level := public.get_effective_tier(p_user);
  v_rules  record;
  v_next   timestamptz := public.coach_next_allowed_at(p_user);
  v_used   int         := public.coach_switches_30d(p_user);
  v_current text;
begin
  select *
  into v_rules
  from public.coach_switch_rules
  where tier = v_tier;

  -- fetch current coach
  select active_coach
  into v_current
  from public.profiles
  where id = p_user;

  if p_to_coach is null or length(p_to_coach) = 0 then
    return query select false, 'Target coach is required', v_next;
    return;
  end if;

  if v_current is not null and v_current = p_to_coach then
    return query select false, 'Already on this coach', v_next;
    return;
  end if;

  if now() < v_next then
    return query select
      false,
      format(
        'Cooldown active. You can switch after %s',
        to_char(v_next, 'YYYY-MM-DD HH24:MI:SS TZ')
      ),
      v_next;
    return;
  end if;

  if v_rules.max_switches_30d is not null
     and v_used >= v_rules.max_switches_30d then
    return query select
      false,
      format(
        'Reached %s switches in 30 days for %s tier',
        v_rules.max_switches_30d,
        v_tier::text
      ),
      v_next;
    return;
  end if;

  return query select true, null::text, now();
end;
$fn$;

grant execute on function public.coach_next_allowed_at(uuid) to authenticated;
grant execute on function public.coach_switches_30d(uuid) to authenticated;
grant execute on function public.can_switch_coach(uuid, text) to authenticated;

-- ---------- RPC: perform a guarded coach switch and update profile ----------
create or replace function public.perform_coach_switch(
  p_to_coach text,
  p_reason   text default null
) returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_user    uuid := auth.uid();
  v_ok      boolean;
  v_reason  text;
  v_next    timestamptz;
  v_from    text;
begin
  if v_user is null then
    raise exception 'Not authenticated';
  end if;

  select active_coach
  into v_from
  from public.profiles
  where id = v_user;

  select ok, reason, next_allowed_at
  into v_ok, v_reason, v_next
  from public.can_switch_coach(v_user, p_to_coach);

  if not v_ok then
    raise exception 'Coach switch blocked: %', coalesce(v_reason, 'Unknown reason');
  end if;

  -- Update profile
  update public.profiles
     set active_coach = p_to_coach
   where id = v_user;

  -- Log switch
  insert into public.coach_switches (user_id, from_coach, to_coach, reason)
  values (v_user, v_from, p_to_coach, p_reason);
end;
$fn$;

revoke all on function public.perform_coach_switch(text, text) from public;
grant execute on function public.perform_coach_switch(text, text) to authenticated;

-- ---------- Convenience view for UI: current status ----------
create or replace view public.v_coach_switch_status as
select
  p.id                              as user_id,
  p.active_coach,
  public.get_effective_tier(p.id)   as tier,
  public.coach_next_allowed_at(p.id) as next_allowed_at,
  public.coach_switches_30d(p.id)   as switches_last_30d
from public.profiles p;

-- RLS for the view follows underlying tables. Expose via RPC if needed.

-- ---------- Optional seed sanity check (comment out if undesired) ----------
-- select ok, reason, next_allowed_at
-- from public.can_switch_coach(auth.uid(), 'chelsea-lightbown');
