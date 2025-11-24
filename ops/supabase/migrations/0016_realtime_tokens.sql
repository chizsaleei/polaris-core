-- =====================================================================
-- 0016_realtime_tokens.sql
-- Ephemeral tokens for realtime features (voice/video/data channels)
-- Works with the app route: /realtime/token
-- =====================================================================

-- Helper: keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $touch$
begin
  new.updated_at := now();
  return new;
end
$touch$;

-- Fallback stub for is_admin if not yet present (safe to re-run)
do $$
begin
  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'is_admin'
      and n.nspname = 'public'
  ) then
    create function public.is_admin()
    returns boolean
    language sql
    stable
    as $fn$
      select false
    $fn$;
  end if;
end $$;

-- Enums
do $$
begin
  if not exists (select 1 from pg_type where typname = 'realtime_scope') then
    create type public.realtime_scope as enum ('chat','voice','video','realtime','screen','data');
  end if;

  if not exists (select 1 from pg_type where typname = 'realtime_provider') then
    create type public.realtime_provider as enum ('openai','vonage','twilio','janus','livekit','self');
  end if;
end $$;

-- =====================================================================
-- Tokens table (opaque server-minted credentials with short TTL)
-- =====================================================================
create table if not exists public.realtime_tokens (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references public.profiles(id) on delete cascade,
  session_id      uuid references public.sessions(id) on delete set null,

  scope           public.realtime_scope not null default 'realtime',
  provider        public.realtime_provider not null default 'self',

  -- Store an opaque token; the app may hand this to a downstream system
  token           text not null,
  -- Optional downstream JWT or credential the client will actually use
  downstream_cred text,

  -- Validity
  issued_at       timestamptz not null default now(),
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  reason          text,

  -- Observability
  ip_address      inet,
  user_agent      text,
  meta            jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

drop trigger if exists trg_touch_realtime_tokens on public.realtime_tokens;
create trigger trg_touch_realtime_tokens
before update on public.realtime_tokens
for each row execute function public.touch_updated_at();

create index if not exists rtt_user_time_idx
  on public.realtime_tokens (user_id, issued_at desc);

create index if not exists rtt_valid_idx
  on public.realtime_tokens (expires_at)
  where revoked_at is null;

create index if not exists rtt_scope_idx
  on public.realtime_tokens (scope);

create index if not exists rtt_provider_idx
  on public.realtime_tokens (provider);

-- =====================================================================
-- Views
-- =====================================================================
create or replace view public.v_realtime_token_valid as
select
  id,
  user_id,
  session_id,
  scope,
  provider,
  issued_at,
  expires_at,
  revoked_at,
  reason,
  meta,
  created_at,
  updated_at
from public.realtime_tokens
where revoked_at is null
  and now() < expires_at;

-- =====================================================================
-- RLS
-- =====================================================================
alter table if exists public.realtime_tokens enable row level security;

-- Policies (no IF NOT EXISTS, use pg_policies checks)
do $$
begin
  -- Admin full access
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'realtime_tokens'
      and policyname = 'realtime_tokens admin all'
  ) then
    create policy "realtime_tokens admin all"
    on public.realtime_tokens
    for all
    to authenticated
    using (public.is_admin())
    with check (public.is_admin());
  end if;

  -- Users can read only their own tokens
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'realtime_tokens'
      and policyname = 'realtime_tokens read own'
  ) then
    create policy "realtime_tokens read own"
    on public.realtime_tokens
    for select
    to authenticated
    using (auth.uid() = user_id);
  end if;

  -- Users can revoke their own tokens (update)
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename  = 'realtime_tokens'
      and policyname = 'realtime_tokens revoke own'
  ) then
    create policy "realtime_tokens revoke own"
    on public.realtime_tokens
    for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;
end $$;

-- Block direct client inserts; use a SECURITY DEFINER function instead
revoke insert on public.realtime_tokens from anon, authenticated;

-- Defensive revoke (RLS and functions govern access)
do $$
declare
  r record;
begin
  for r in
    select quote_ident(schemaname) as s, quote_ident(tablename) as t
    from pg_tables
    where schemaname = 'public'
      and tablename in ('realtime_tokens')
  loop
    execute format('revoke all on table %s.%s from public;', r.s, r.t);
  end loop;
end $$;

-- =====================================================================
-- Functions to mint and revoke tokens
-- =====================================================================

-- Generate a cryptographically random opaque token
create or replace function public.generate_opaque_token(bytes int default 32)
returns text
language sql
as $gen$
  select encode(gen_random_bytes(bytes), 'base64');
$gen$;

-- Mint token for the current user; returns id, token, and expiry
create or replace function public.mint_realtime_token(
  p_scope        public.realtime_scope default 'realtime',
  p_provider     public.realtime_provider default 'self',
  p_ttl_seconds  int default 900,                 -- 15 minutes
  p_session_id   uuid default null,
  p_meta         jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  token text,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $mint$
declare
  v_user  uuid := auth.uid();
  v_token text := public.generate_opaque_token(32);
  v_exp   timestamptz := now() + make_interval(secs => p_ttl_seconds);
begin
  if v_user is null then
    raise exception 'Must be authenticated to mint realtime token';
  end if;

  insert into public.realtime_tokens (
    user_id,
    session_id,
    scope,
    provider,
    token,
    expires_at,
    meta
  )
  values (
    v_user,
    p_session_id,
    p_scope,
    p_provider,
    v_token,
    v_exp,
    coalesce(p_meta, '{}'::jsonb)
  )
  returning realtime_tokens.id,
            realtime_tokens.token,
            realtime_tokens.expires_at
  into id, token, expires_at;

  return next;
end
$mint$;

-- Revoke a token by id (owner or admin)
create or replace function public.revoke_realtime_token(
  p_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $revoke$
declare
  v_user  uuid := auth.uid();
  v_owner uuid;
begin
  select user_id
  into v_owner
  from public.realtime_tokens
  where id = p_id;

  if not found then
    raise exception 'Token not found';
  end if;

  if v_user is distinct from v_owner and not public.is_admin() then
    raise exception 'Not allowed to revoke this token';
  end if;

  update public.realtime_tokens
  set revoked_at = now(),
      reason     = coalesce(p_reason, reason)
  where id = p_id;
end
$revoke$;

-- Admin: purge expired tokens
create or replace function public.purge_expired_realtime_tokens()
returns int
language plpgsql
security definer
set search_path = public
as $purge$
declare
  v_count int;
begin
  if not public.is_admin() then
    raise exception 'Admin only';
  end if;

  delete from public.realtime_tokens
  where expires_at < now()
     or (revoked_at is not null and revoked_at < now() - interval '7 days');

  get diagnostics v_count = row_count;
  return v_count;
end
$purge$;

-- Lock down helper functions from PUBLIC
revoke all on function public.generate_opaque_token(int) from public;
revoke all on function public.mint_realtime_token(public.realtime_scope, public.realtime_provider, int, uuid, jsonb) from public;
revoke all on function public.revoke_realtime_token(uuid, text) from public;
revoke all on function public.purge_expired_realtime_tokens() from public;

-- Grants for app roles
grant execute on function public.mint_realtime_token(public.realtime_scope, public.realtime_provider, int, uuid, jsonb) to authenticated;
grant execute on function public.revoke_realtime_token(uuid, text) to authenticated;
grant execute on function public.purge_expired_realtime_tokens() to authenticated; -- guarded by is_admin() inside

-- =====================================================================
-- Notes
-- - App server should call mint_realtime_token in the /realtime/token route.
-- - For external providers (OpenAI/Vonage/etc.), set provider accordingly
--   and stash any downstream credential in downstream_cred if needed.
-- - TTL kept short; renew by calling mint again.
-- - Use v_realtime_token_valid for quick checks.
-- =====================================================================
