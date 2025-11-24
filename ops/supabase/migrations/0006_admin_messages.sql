-- =====================================================================
-- 0006_admin_messages.sql
-- Polaris Core – Admin announcements, scheduling, deliveries, lifecycle
-- Prereqs: public.profiles, public.tg_set_updated_at()
-- RLS policies are defined separately (policies/admin_messages.sql)
-- =====================================================================

set check_function_bodies = off;

-- ----------------------------
-- Enums (idempotent)
-- ----------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'admin_msg_state') then
    create type admin_msg_state as enum (
      'draft','approved','scheduled','sending','sent','canceled','archived'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'admin_msg_channel') then
    create type admin_msg_channel as enum ('in_app','email','push');
  end if;

  if not exists (select 1 from pg_type where typname = 'admin_msg_importance') then
    create type admin_msg_importance as enum ('low','normal','high','urgent');
  end if;
end
$$;

-- ----------------------------
-- Admin Messages (master)
-- ----------------------------
create table if not exists public.admin_messages (
  id               uuid primary key default gen_random_uuid(),
  -- allow null here because ON DELETE SET NULL would conflict with NOT NULL
  author_id        uuid references public.profiles(id) on delete set null,
  title            text not null,
  body_text        text,
  body_html        text,
  importance       admin_msg_importance not null default 'normal',
  tags             text[] not null default '{}'::text[],
  -- optional visual + CTA
  hero_image_url   text,
  cta_label        text,
  cta_url          text,

  -- audience targeting
  audience_filter  jsonb not null default '{}'::jsonb,

  -- lifecycle
  state            admin_msg_state not null default 'draft',
  send_at          timestamptz,
  sent_at          timestamptz,
  canceled_at      timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  meta             jsonb not null default '{}'::jsonb
);

create index if not exists idx_admin_messages_state
  on public.admin_messages(state);
create index if not exists idx_admin_messages_send_at
  on public.admin_messages(send_at);
create index if not exists idx_admin_messages_tags
  on public.admin_messages using gin(tags);
create index if not exists idx_admin_messages_audience
  on public.admin_messages using gin(audience_filter);

drop trigger if exists trg_admin_messages_touch on public.admin_messages;
create trigger trg_admin_messages_touch
before update on public.admin_messages
for each row execute function public.tg_set_updated_at();

-- ----------------------------
-- Deliveries (per-user receipts)
-- ----------------------------
create table if not exists public.admin_message_deliveries (
  id               uuid primary key default gen_random_uuid(),
  message_id       uuid not null references public.admin_messages(id) on delete cascade,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  channel          admin_msg_channel not null default 'in_app',
  created_at       timestamptz not null default now(),   -- enqueued
  sent_at          timestamptz,                          -- pushed/surfaced
  read_at          timestamptz,                          -- user viewed
  clicked_at       timestamptz,                          -- CTA clicked
  meta             jsonb not null default '{}'::jsonb
);

create index if not exists idx_admin_deliveries_msg
  on public.admin_message_deliveries(message_id);
create index if not exists idx_admin_deliveries_user
  on public.admin_message_deliveries(user_id);
create index if not exists idx_admin_deliveries_channel
  on public.admin_message_deliveries(channel);
create index if not exists idx_admin_deliveries_read
  on public.admin_message_deliveries(read_at);

-- ----------------------------
-- Scheduling helpers
-- ----------------------------
create or replace function public.admin_message_set_state(p_id uuid, p_state admin_msg_state)
returns void
language plpgsql
as $$
begin
  update public.admin_messages
     set state      = p_state,
         sent_at    = case when p_state = 'sent'     then now() else sent_at    end,
         canceled_at= case when p_state = 'canceled' then now() else canceled_at end,
         updated_at = now()
   where id = p_id;
end;
$$;

create or replace function public.admin_messages_due(now_ts timestamptz default now())
returns setof public.admin_messages
language sql
stable
as $$
  select *
  from public.admin_messages
  where state = 'scheduled'
    and send_at is not null
    and send_at <= now_ts
$$;

-- ----------------------------
-- Convenience views
-- ----------------------------
create or replace view public.v_admin_messages_outbox as
select
  id, title, state, importance, tags, send_at, sent_at, created_at, updated_at
from public.admin_messages
where state in ('approved','scheduled','sending')
order by coalesce(send_at, created_at) asc;

create or replace view public.v_admin_messages_stats as
select
  m.id,
  m.title,
  m.state,
  count(d.*) filter (where d.created_at is not null) as queued,
  count(d.*) filter (where d.sent_at    is not null) as delivered,
  count(d.*) filter (where d.read_at    is not null) as read,
  count(d.*) filter (where d.clicked_at is not null) as clicked
from public.admin_messages m
left join public.admin_message_deliveries d on d.message_id = m.id
group by m.id, m.title, m.state;

comment on table public.admin_messages is
  'System-wide admin announcements with audience filters and scheduling.';
comment on table public.admin_message_deliveries is
  'Per-user delivery receipts for admin messages (in-app, email, push).';
comment on view public.v_admin_messages_outbox is
  'Admin outbox for approved/scheduled messages.';
comment on view public.v_admin_messages_stats is
  'Rollup stats of queued, delivered, read, and clicked per message.';

-- ----------------------------
-- RLS
-- ----------------------------
alter table public.admin_messages enable row level security;
alter table public.admin_message_deliveries enable row level security;

-- Policy rules are defined in a separate migration, e.g.:
-- ops/supabase/policies/admin_messages.sql
