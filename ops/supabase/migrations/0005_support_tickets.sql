-- =====================================================================
-- 0005_support_tickets.sql
-- Polaris Core – Support tickets, threaded messages, audit events, SLAs
-- Aligns with Admin responsibilities: SLAs, ticket queues, moderation
-- =====================================================================

-- ----------------------------
-- Enums (create if missing)
-- ----------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'ticket_state') then
    create type ticket_state as enum (
      'open',            -- newly created, needs admin attention
      'pending_admin',   -- user replied, waiting on admin
      'pending_user',    -- admin replied, waiting on user
      'resolved',        -- solved but not yet closed
      'closed',          -- closed (can be reopened)
      'archived'         -- long-term storage
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'ticket_priority') then
    create type ticket_priority as enum ('low','normal','high','urgent');
  end if;

  if not exists (select 1 from pg_type where typname = 'ticket_channel') then
    create type ticket_channel as enum ('web','in_app','email');
  end if;

  if not exists (select 1 from pg_type where typname = 'ticket_category') then
    create type ticket_category as enum (
      'account','billing','payment','content','safety','technical','feature','other'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'message_author') then
    create type message_author as enum ('user','admin','ai_system');
  end if;

  if not exists (select 1 from pg_type where typname = 'message_visibility') then
    create type message_visibility as enum ('public','internal'); -- internal = admin-only note
  end if;
end
$$;

-- ----------------------------
-- TICKETS
-- ----------------------------
create table if not exists public.tickets (
  id                uuid primary key default gen_random_uuid(),
  -- who opened it (end user)
  user_id           uuid not null references public.profiles(id) on delete cascade,

  -- optional coach context (e.g., issue tied to a coach catalog)
  coach_id          text references public.coaches(key) on delete set null,

  -- assignment to an admin (optional)
  assigned_to       uuid references public.profiles(id) on delete set null,

  -- basics
  subject           text not null,
  category          ticket_category not null default 'other',
  priority          ticket_priority not null default 'normal',
  channel           ticket_channel not null default 'in_app',
  tags              text[] not null default '{}',

  -- lifecycle
  state             ticket_state not null default 'open',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  resolved_at       timestamptz,
  closed_at         timestamptz,

  -- SLA management
  sla_due_at        timestamptz,           -- computed from priority on insert
  last_message_at   timestamptz,           -- for inbox sorting
  last_author       message_author,        -- last message author (user/admin/ai)

  -- reporter convenience (may mirror profile at time of creation)
  reporter_email    text,
  reporter_name     text,

  -- free-form extra context
  meta              jsonb not null default '{}'::jsonb
);

-- Legacy compatibility: ensure columns exist when table predates this migration
alter table public.tickets
  add column if not exists user_id         uuid references public.profiles(id) on delete cascade,
  add column if not exists coach_id        text references public.coaches(key) on delete set null,
  add column if not exists assigned_to     uuid references public.profiles(id) on delete set null,
  add column if not exists subject         text,
  add column if not exists category        ticket_category not null default 'other',
  add column if not exists priority        ticket_priority not null default 'normal',
  add column if not exists channel         ticket_channel not null default 'in_app',
  add column if not exists tags            text[] not null default '{}'::text[],
  add column if not exists state           ticket_state not null default 'open',
  add column if not exists created_at      timestamptz not null default now(),
  add column if not exists updated_at      timestamptz not null default now(),
  add column if not exists resolved_at     timestamptz,
  add column if not exists closed_at       timestamptz,
  add column if not exists sla_due_at      timestamptz,
  add column if not exists last_message_at timestamptz,
  add column if not exists last_author     message_author,
  add column if not exists reporter_email  text,
  add column if not exists reporter_name   text,
  add column if not exists meta            jsonb not null default '{}'::jsonb;

create index if not exists idx_tickets_user on public.tickets(user_id);
create index if not exists idx_tickets_state on public.tickets(state);
create index if not exists idx_tickets_priority on public.tickets(priority);
create index if not exists idx_tickets_assigned on public.tickets(assigned_to);
create index if not exists idx_tickets_coach on public.tickets(coach_id);
create index if not exists idx_tickets_tags on public.tickets using gin(tags);
create index if not exists idx_tickets_sla on public.tickets(sla_due_at);
create index if not exists idx_tickets_lastmsg on public.tickets(last_message_at desc);

drop trigger if exists trg_tickets_touch on public.tickets;
create trigger trg_tickets_touch
before update on public.tickets
for each row execute function public.tg_set_updated_at();

-- ----------------------------
-- SLA helper: compute initial SLA due timestamp
-- ----------------------------
create or replace function public.compute_sla_due(pr ticket_priority, created timestamptz)
returns timestamptz
language sql
immutable
as $$
  select case
    when pr = 'urgent' then created + interval '2 hours'
    when pr = 'high'   then created + interval '8 hours'
    when pr = 'normal' then created + interval '24 hours'
    else created + interval '72 hours' -- low
  end
$$;

-- set SLA due at insert time (if not provided)
create or replace function public.tickets_before_insert()
returns trigger
language plpgsql
as $$
begin
  if new.sla_due_at is null then
    new.sla_due_at := public.compute_sla_due(new.priority, coalesce(new.created_at, now()));
  end if;
  return new;
end
$$;

drop trigger if exists trg_tickets_bi on public.tickets;
create trigger trg_tickets_bi
before insert on public.tickets
for each row execute function public.tickets_before_insert();

-- ----------------------------
-- MESSAGES (threaded)
-- ----------------------------
create table if not exists public.ticket_messages (
  id                uuid primary key default gen_random_uuid(),
  ticket_id         uuid not null references public.tickets(id) on delete cascade,
  author_type       message_author not null,
  author_id         uuid references public.profiles(id) on delete set null, -- admin or user
  visibility        message_visibility not null default 'public',
  body_text         text,                 -- plaintext or markdown
  body_html         text,                 -- optional rendered html (stored if you prefer)
  attachments       jsonb not null default '[]'::jsonb, -- [{url, name, type, size}]
  meta              jsonb not null default '{}'::jsonb,  -- ASR refs, audio, etc.
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.ticket_messages
  add column if not exists ticket_id   uuid references public.tickets(id) on delete cascade,
  add column if not exists author_type message_author,
  add column if not exists author_id   uuid references public.profiles(id) on delete set null,
  add column if not exists visibility  message_visibility not null default 'public',
  add column if not exists body_text   text,
  add column if not exists body_html   text,
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists meta        jsonb not null default '{}'::jsonb,
  add column if not exists created_at  timestamptz not null default now(),
  add column if not exists updated_at  timestamptz not null default now();

create index if not exists idx_ticket_messages_ticket on public.ticket_messages(ticket_id);
create index if not exists idx_ticket_messages_created on public.ticket_messages(created_at);
create index if not exists idx_ticket_messages_visibility on public.ticket_messages(visibility);

drop trigger if exists trg_ticket_messages_touch on public.ticket_messages;
create trigger trg_ticket_messages_touch
before update on public.ticket_messages
for each row execute function public.tg_set_updated_at();

-- auto-bubble message metadata to tickets and drive state transitions
create or replace function public.ticket_after_message()
returns trigger
language plpgsql
as $$
begin
  update public.tickets t
     set last_message_at = new.created_at,
         last_author     = new.author_type,
         -- state transitions:
         state           = case
                             when new.visibility = 'internal' then t.state  -- internal note does not change state
                             when new.author_type = 'user'    then 'pending_admin'
                             when new.author_type in ('admin','ai_system') then 'pending_user'
                             else t.state
                           end,
         updated_at      = now()
   where t.id = new.ticket_id;
  return new;
end
$$;

drop trigger if exists trg_ticket_messages_ai on public.ticket_messages;
create trigger trg_ticket_messages_ai
after insert on public.ticket_messages
for each row execute function public.ticket_after_message();

-- ----------------------------
-- EVENTS (lightweight audit / actions on tickets)
-- ----------------------------
create table if not exists public.ticket_events (
  id                uuid primary key default gen_random_uuid(),
  ticket_id         uuid not null references public.tickets(id) on delete cascade,
  actor_id          uuid references public.profiles(id) on delete set null,
  event_type        text not null,   -- e.g. assigned, priority_changed, reopened, tag_added, sla_breached
  data              jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

alter table public.ticket_events
  add column if not exists ticket_id  uuid references public.tickets(id) on delete cascade,
  add column if not exists actor_id   uuid references public.profiles(id) on delete set null,
  add column if not exists event_type text,
  add column if not exists data       jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now();

create index if not exists idx_ticket_events_ticket on public.ticket_events(ticket_id);
create index if not exists idx_ticket_events_type on public.ticket_events(event_type);

-- helper: mark resolved/closed and log events
create or replace function public.ticket_set_state(p_ticket_id uuid, p_state ticket_state, p_actor uuid)
returns void
language plpgsql
as $$
begin
  update public.tickets
     set state = p_state,
         resolved_at = case when p_state = 'resolved' then now() else resolved_at end,
         closed_at   = case when p_state = 'closed'   then now() else closed_at end,
         updated_at  = now()
   where id = p_ticket_id;

  insert into public.ticket_events(ticket_id, actor_id, event_type, data)
  values (p_ticket_id, p_actor, 'state_changed', jsonb_build_object('state', p_state));
end
$$;

-- SLA breach detector (optional cron can call this)
create or replace function public.ticket_mark_sla_breaches()
returns integer
language plpgsql
as $$
declare
  v_count int;
begin
  update public.tickets t
     set tags = array(
           select distinct unnest(t.tags || array['sla_breached'])
         ),
         updated_at = now()
   where t.state in ('open','pending_admin','pending_user')
     and t.sla_due_at is not null
     and now() > t.sla_due_at
     and not ('sla_breached' = any(t.tags));
  get diagnostics v_count = row_count;

  insert into public.ticket_events(ticket_id, actor_id, event_type, data)
  select t.id, null, 'sla_breached', jsonb_build_object('at', now())
  from public.tickets t
  where 'sla_breached' = any(t.tags)
    and t.last_message_at is not null
    and t.last_message_at > now() - interval '7 days'; -- throttle noise

  return v_count;
end
$$;

-- ----------------------------
-- Admin Inbox / Views
-- ----------------------------
create or replace view public.v_tickets_inbox as
select
  t.id,
  t.user_id,
  t.coach_id,
  t.assigned_to,
  t.subject,
  t.category,
  t.priority,
  t.state,
  t.tags,
  t.sla_due_at,
  t.last_message_at,
  t.last_author,
  t.created_at,
  t.updated_at
from public.tickets t
where t.state in ('open','pending_admin','pending_user')
order by coalesce(t.sla_due_at, t.created_at) asc, t.last_message_at desc;

comment on table public.tickets is 'Support tickets with SLA and lifecycle state.';
comment on table public.ticket_messages is 'Threaded messages for a ticket. Internal notes supported.';
comment on table public.ticket_events is 'Lightweight audit events for ticket changes and SLA marks.';
comment on view public.v_tickets_inbox is 'Admin inbox: active tickets sorted by SLA then recency.';

-- ----------------------------
-- RLS (enabled; detailed policies are in policies/tickets_policies.sql)
-- ----------------------------
alter table public.tickets        enable row level security;
alter table public.ticket_messages enable row level security;
alter table public.ticket_events   enable row level security;

-- Suggested hot-path indexes
create index if not exists idx_ticket_messages_ticket_created
  on public.ticket_messages(ticket_id, created_at);
