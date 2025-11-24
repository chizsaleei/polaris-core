-- =====================================================================
-- 0003_drill_items_sets.sql
-- Polaris Core – Drill Items, Drill Sets, and Set Membership
-- Compatible with 0001_init.sql where:
--   - public.coaches(key text primary key)
--   - public.drills(id uuid, coach_key text, tags jsonb, etc.)
--   - public.tg_set_updated_at() exists
-- This migration DOES NOT recreate public.drills.
-- =====================================================================

set check_function_bodies = off;

-- ----------------------------
-- Enums (create if missing)
-- ----------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'drill_state') then
    create type drill_state as enum (
      'draft','auto_qa','in_review','approved','published','deprecated'
    );
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'difficulty_level') then
    create type difficulty_level as enum ('beginner','intermediate','advanced','expert');
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'coach_section') then
    create type coach_section as enum (
      'speaking_drills','scenarios','q_bank','feedback_studio','rubrics'
    );
  end if;
end$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'item_kind') then
    create type item_kind as enum (
      'prompt','multiple_choice','short_answer','roleplay','case_stem','rubric_row','flashcard'
    );
  end if;
end$$;

-- ---------------------------------------------------------------------
-- NOTE: We DO NOT create public.drills here to avoid clobbering 0001.
-- If you want extra metadata on drills later, add columns via ALTER TABLE.
-- ---------------------------------------------------------------------

-- ----------------------------
-- DRILL ITEMS (reusable atoms)
-- ----------------------------
create table if not exists public.drill_items (
  id               uuid primary key default gen_random_uuid(),
  drill_id         uuid references public.drills(id) on delete cascade, -- optional for reusable items
  kind             item_kind not null,
  title            text,
  content          jsonb not null,                       -- schema depends on 'kind'
  answer_key       jsonb,
  hints            jsonb not null default '[]'::jsonb,
  difficulty       difficulty_level not null default 'beginner',
  reading_level    text,
  exam_mapping     jsonb not null default '{}'::jsonb,   -- {"IELTS":["Part2"],"MRCP":["DataInterpretation"]}
  source_ref       text,
  qa_flags         jsonb not null default '[]'::jsonb,   -- [{"type":"duplication","note":"..."}]
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_drill_items_drill on public.drill_items(drill_id);
create index if not exists idx_drill_items_kind  on public.drill_items(kind);
create index if not exists idx_drill_items_diff  on public.drill_items(difficulty);

drop trigger if exists trg_drill_items_touch on public.drill_items;
create trigger trg_drill_items_touch
before update on public.drill_items
for each row execute function public.tg_set_updated_at();

comment on table public.drill_items is
  'Reusable atomic content units (questions, prompts, rubric rows) usable in drills and sets.';

-- ----------------------------
-- DRILL SETS (curated catalogs per coach and section)
-- ----------------------------
create table if not exists public.drill_sets (
  id               uuid primary key default gen_random_uuid(),
  coach_key        text not null references public.coaches(key) on delete cascade,
  section          coach_section not null,  -- speaking_drills, scenarios, q_bank, feedback_studio, rubrics
  title            text not null,
  description      text,
  tags             text[] not null default '{}',
  state            drill_state not null default 'draft',
  version          int not null default 1,
  changelog        text,
  published_at     timestamptz,
  deprecated_at    timestamptz,
  created_by       uuid,  -- profiles.id (admin)
  approved_by      uuid,  -- profiles.id
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (coach_key, section, title)
);

create index if not exists idx_drill_sets_coach_section on public.drill_sets(coach_key, section);
create index if not exists idx_drill_sets_state on public.drill_sets(state);
create index if not exists idx_drill_sets_tags on public.drill_sets using gin(tags);

drop trigger if exists trg_drill_sets_touch on public.drill_sets;
create trigger trg_drill_sets_touch
before update on public.drill_sets
for each row execute function public.tg_set_updated_at();

comment on table public.drill_sets is
  'Curated, versioned collections per coach and section for user-facing catalogs and tools.';

-- ----------------------------
-- SET MEMBERSHIP (ordered many-to-many: set ↔ item)
-- ----------------------------
create table if not exists public.set_members (
  set_id        uuid not null references public.drill_sets(id) on delete cascade,
  item_id       uuid not null references public.drill_items(id) on delete cascade,
  position      int not null default 1 check (position >= 1),
  weight        numeric(6,3) not null default 1.0,
  pinned        boolean not null default false,
  added_by      uuid, -- profiles.id
  added_at      timestamptz not null default now(),
  primary key (set_id, item_id)
);

create index if not exists idx_set_members_position on public.set_members(set_id, position);
create index if not exists idx_set_members_item on public.set_members(item_id);

comment on table public.set_members is
  'Ordered membership linking items into sets with positions and weights.';

-- ----------------------------
-- Helper view for fast catalog queries
-- ----------------------------
create or replace view public.v_catalog_flat as
select
  ds.id                    as set_id,
  ds.coach_key,
  ds.section,
  ds.title                 as set_title,
  ds.state                 as set_state,
  ds.tags                  as set_tags,
  sm.position,
  di.id                    as item_id,
  di.kind,
  di.difficulty            as item_difficulty,
  (di.content->>'prompt')::text as item_prompt_text,
  (di.content->>'text')::text   as item_text,
  di.exam_mapping,
  di.qa_flags
from public.drill_sets ds
join public.set_members sm on sm.set_id = ds.id
join public.drill_items di on di.id = sm.item_id;

comment on view public.v_catalog_flat is
  'Flat join for catalogs and admin review lists across sets and items.';

-- ----------------------------
-- RLS (enable now; policies can be added in a later migration)
-- ----------------------------
alter table public.drill_items  enable row level security;
alter table public.drill_sets   enable row level security;
alter table public.set_members  enable row level security;

-- Suggested partial indexes for published content browse
create index if not exists idx_sets_published_coach
  on public.drill_sets(coach_key, section) where state = 'published';

-- =====================================================================
-- End 0003
-- =====================================================================
