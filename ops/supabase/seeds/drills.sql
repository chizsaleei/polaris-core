-- =====================================================================
-- seeds/drills.sql
-- Purpose: Seed a starter catalog of drill items and drill sets
-- for the 10 Polaris coaches. Safe to run multiple times (idempotent).
--
-- Assumes migration 0003_drill_items_sets.sql has been applied:
--
--   public.drill_items (
--     id            uuid primary key default gen_random_uuid(),
--     drill_id      uuid references public.drills(id) on delete cascade,
--     kind          item_kind not null,            -- 'prompt','roleplay', etc.
--     title         text,
--     content       jsonb not null,
--     answer_key    jsonb,
--     hints         jsonb not null default '[]'::jsonb,
--     difficulty    difficulty_level not null default 'beginner',
--     reading_level text,
--     exam_mapping  jsonb not null default '{}'::jsonb,
--     source_ref    text,
--     qa_flags      jsonb not null default '[]'::jsonb,
--     created_at    timestamptz not null default now(),
--     updated_at    timestamptz not null default now()
--   );
--
--   public.drill_sets (
--     id            uuid primary key default gen_random_uuid(),
--     coach_key     text not null references public.coaches(key) on delete cascade,
--     section       coach_section not null,        -- 'speaking_drills', ...
--     title         text not null,
--     description   text,
--     tags          text[] not null default '{}',
--     state         drill_state not null default 'draft',
--     version       int not null default 1,
--     changelog     text,
--     published_at  timestamptz,
--     deprecated_at timestamptz,
--     created_by    uuid,
--     approved_by   uuid,
--     created_at    timestamptz not null default now(),
--     updated_at    timestamptz not null default now()
--   );
--
--   public.set_members (
--     set_id   uuid references public.drill_sets(id) on delete cascade,
--     item_id  uuid references public.drill_items(id) on delete cascade,
--     position int not null default 1 check (position >= 1),
--     weight   numeric(6,3) not null default 1.0,
--     pinned   boolean not null default false,
--     added_by uuid,
--     added_at timestamptz not null default now(),
--     primary key (set_id, item_id)
--   );
--
-- If your column names differ, adjust the helper functions below.
-- =====================================================================

-- ---------- Helper upsert for drill_items ----------
create or replace function public._upsert_drill_item(
  p_slug            text,
  p_title           text,
  p_type            text,       -- e.g. 'speaking','roleplay'
  p_coach_keys      text[],
  p_difficulty      text,       -- 'beginner' | 'intermediate' | 'advanced' | 'expert'
  p_runtime_seconds int,
  p_tags            text[],
  p_prompt          jsonb,
  p_rubric          jsonb,
  p_state           text,
  p_version         int
) returns uuid
language plpgsql
as $fn$
declare
  v_id      uuid;
  v_kind    item_kind;
  v_diff    difficulty_level;
  v_content jsonb;
begin
  -- Map legacy type into item_kind enum
  v_kind :=
    case lower(coalesce(p_type, ''))
      when 'roleplay' then 'roleplay'::item_kind
      else 'prompt'::item_kind
    end;

  -- Map legacy difficulty text into difficulty_level enum
  v_diff :=
    case lower(coalesce(p_difficulty, ''))
      when 'intermediate' then 'intermediate'::difficulty_level
      when 'advanced'     then 'advanced'::difficulty_level
      when 'expert'       then 'expert'::difficulty_level
      else 'beginner'::difficulty_level
    end;

  -- Pack legacy fields into content JSON for flexible use
  v_content := jsonb_build_object(
    'slug',             p_slug,
    'type',             p_type,
    'coach_keys',       coalesce(to_jsonb(p_coach_keys), '[]'::jsonb),
    'runtime_seconds',  p_runtime_seconds,
    'tags',             coalesce(to_jsonb(p_tags), '[]'::jsonb),
    'prompt',           coalesce(p_prompt, '{}'::jsonb),
    'rubric',           coalesce(p_rubric, '{}'::jsonb),
    'legacy_state',     coalesce(p_state, 'Approved'),
    'legacy_version',   coalesce(p_version, 1)
  );

  -- Idempotent upsert keyed by slug embedded in content
  select id
  into v_id
  from public.drill_items
  where content->>'slug' = p_slug;

  if v_id is null then
    insert into public.drill_items as di
      (drill_id, kind, title, content, answer_key, hints, difficulty,
       reading_level, exam_mapping, source_ref, qa_flags, created_at, updated_at)
    values
      (null, v_kind, p_title, v_content, null, '[]'::jsonb, v_diff,
       null, '{}'::jsonb, null, '[]'::jsonb, now(), now())
    returning id into v_id;
  else
    update public.drill_items di
    set kind       = v_kind,
        title      = p_title,
        content    = v_content,
        difficulty = v_diff,
        updated_at = now()
    where id = v_id;
  end if;

  return v_id;
end
$fn$;

-- ---------- Helper upsert for drill_sets ----------
create or replace function public._upsert_drill_set(
  p_slug        text,
  p_title       text,
  p_description text,
  p_coach_keys  text[],
  p_tags        text[],
  p_state       text,   -- 'draft','approved','published', etc.
  p_version     int
) returns uuid
language plpgsql
as $fn$
declare
  v_id        uuid;
  v_coach_key text;
  v_state     drill_state;
  v_tags      text[];
begin
  -- Use the first coach key as the owning coach
  v_coach_key := coalesce(p_coach_keys[1], 'carter-goleman');
  v_tags      := coalesce(p_tags, '{}'::text[]);

  v_state :=
    case lower(coalesce(p_state, 'draft'))
      when 'approved'   then 'approved'::drill_state
      when 'published'  then 'published'::drill_state
      when 'deprecated' then 'deprecated'::drill_state
      when 'auto_qa'    then 'auto_qa'::drill_state
      when 'in_review'  then 'in_review'::drill_state
      else 'draft'::drill_state
    end;

  -- Idempotent key: (coach_key, section, title)
  select id
  into v_id
  from public.drill_sets
  where coach_key = v_coach_key
    and section   = 'speaking_drills'::coach_section
    and title     = p_title;

  if v_id is null then
    insert into public.drill_sets as ds
      (coach_key, section, title, description, tags, state, version,
       changelog, created_by, created_at, updated_at)
    values
      (v_coach_key, 'speaking_drills'::coach_section, p_title, p_description,
       v_tags, v_state, coalesce(p_version, 1),
       p_slug, null, now(), now())
    returning id into v_id;
  else
    update public.drill_sets ds
    set description = p_description,
        tags        = v_tags,
        state       = v_state,
        version     = greatest(ds.version, coalesce(p_version, 1)),
        changelog   = p_slug,
        updated_at  = now()
    where id = v_id;
  end if;

  return v_id;
end
$fn$;

-- ---------- Helper to link items to sets with stable positions ----------
create or replace function public._ensure_set_item(
  p_set_id    uuid,
  p_item_id   uuid,
  p_position  int
) returns void
language sql
as $fn$
  insert into public.set_members (set_id, item_id, position)
  values (p_set_id, p_item_id, p_position)
  on conflict (set_id, item_id) do update
    set position = excluded.position;
$fn$;

-- =====================================================================
-- SEED DRILL ITEMS & SETS (idempotent)
-- =====================================================================

do $$
declare
  -- Item ids
  carter_star_item_id    uuid;
  carter_tmay_item_id    uuid;
  chelsea_p2_item_id     uuid;
  claire_pitch_item_id   uuid;
  clark_icu_item_id      uuid;
  crystal_isbar_item_id  uuid;
  buffett_wrap_item_id   uuid;
  colton_obj_item_id     uuid;
  cody_incident_item_id  uuid;
  chloe_vision_item_id   uuid;
  chase_mini_item_id     uuid;

  -- Set ids
  set_carter_id   uuid;
  set_chelsea_id  uuid;
  set_claire_id   uuid;
  set_clark_id    uuid;
  set_crystal_id  uuid;
  set_buffett_id  uuid;
  set_colton_id   uuid;
  set_cody_id     uuid;
  set_chloe_id    uuid;
  set_chase_id    uuid;
begin
  -- Guard: ensure required tables exist
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'drill_items'
  ) then
    raise notice 'public.drill_items not found. Skipping drill seeds.';
    return;
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'drill_sets'
  ) then
    raise notice 'public.drill_sets not found. Skipping drill seeds.';
    return;
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'set_members'
  ) then
    raise notice 'public.set_members not found. Skipping drill seeds.';
    return;
  end if;

  -- ===================================================================
  -- SEED DRILL ITEMS
  -- Minimal but representative items per coach to get catalogs started.
  -- ===================================================================

  -- Carter Goleman (Professional Interview)
  carter_star_item_id := public._upsert_drill_item(
    'carter-star-sprint-120',
    'Two Minute STAR Sprint',
    'speaking',
    array['carter-goleman'],
    'intermediate',
    120,
    array['interview','behavioral','STAR','timed'],
    jsonb_build_object(
      'instruction', 'Answer a behavioral question using STAR in about 2 minutes. Focus on clarity and measurable results.',
      'question_pool', array[
        'Tell me about a time you handled a difficult stakeholder.',
        'Describe a situation where you led without authority.',
        'Give an example of a time you missed a deadline. What happened?'
      ],
      'hints', array['State the result with metrics','Keep Situation and Task short','Use action verbs']
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','structure','max',5,'desc','Clear STAR flow'),
        jsonb_build_object('key','impact','max',5,'desc','Outcome with metrics'),
        jsonb_build_object('key','clarity','max',5,'desc','Concise, confident delivery')
      ],
      'pass', jsonb_build_object('min_total',11)
    ),
    'Approved',
    1
  );

  carter_tmay_item_id := public._upsert_drill_item(
    'carter-tmay-refine',
    'Tell Me About Yourself — Refine Loop',
    'speaking',
    array['carter-goleman'],
    'beginner',
    90,
    array['interview','introductions','loop'],
    jsonb_build_object(
      'instruction','Deliver a 60 to 90 second TMAY answer. You will get two quick refinement passes.',
      'outline', array['Present','Past','Future','Why this role'],
      'tips', array['Lead with role title','Match keywords','End with an ask']
    ),
    null,
    'Approved',
    1
  );

  -- Chelsea Lightbown (IELTS or TOEFL)
  chelsea_p2_item_id := public._upsert_drill_item(
    'chelsea-ielts-part2',
    'IELTS Part 2 Long Turn with Follow Ups',
    'speaking',
    array['chelsea-lightbown'],
    'intermediate',
    180,
    array['IELTS','band','timed','follow-ups'],
    jsonb_build_object(
      'instruction','Speak for 1 to 2 minutes on the prompt, then answer two follow-ups.',
      'prompt_template','Describe a time when you learned something useful outside school.',
      'follow_ups', array['Why was it useful?','Should schools teach this?'],
      'band_target','6.5-7.0'
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','fluency','max',9),
        jsonb_build_object('key','lexical_resource','max',9),
        jsonb_build_object('key','grammar_range','max',9),
        jsonb_build_object('key','pronunciation','max',9)
      ],
      'band_map','IELTS'
    ),
    'Approved',
    1
  );

  -- Claire Swales (Graduate Admissions)
  claire_pitch_item_id := public._upsert_drill_item(
    'claire-3min-research-pitch',
    '3 Minute Research Pitch',
    'speaking',
    array['claire-swales'],
    'advanced',
    180,
    array['research','pitch','graduate','SOP'],
    jsonb_build_object(
      'instruction','Pitch your proposed research in 3 minutes to a mixed committee.',
      'scaffold', array['Problem','Gap','Approach','Impact','Fit'],
      'tip','Avoid jargon. Anchor with one compelling example.'
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','problem_clarity','max',5),
        jsonb_build_object('key','method_fit','max',5),
        jsonb_build_object('key','impact','max',5)
      ]
    ),
    'Approved',
    1
  );

  -- Clark Atul (Medical — Physicians)
  clark_icu_item_id := public._upsert_drill_item(
    'clark-icu-case-4min',
    '4 Minute ICU Case Presentation',
    'speaking',
    array['clark-atul'],
    'advanced',
    240,
    array['OSCE','ICU','SBAR','SOAP'],
    jsonb_build_object(
      'instruction','Present an ICU case using SBAR. Include vitals, key labs, differentials, and immediate plan.',
      'framework','SBAR',
      'disclaimer','Education only. Not medical advice.'
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','structure','max',5),
        jsonb_build_object('key','safety','max',5),
        jsonb_build_object('key','reasoning','max',5)
      ],
      'must_have', array['Vitals trend','ABCs','Clear next step']
    ),
    'Approved',
    1
  );

  -- Crystal Benner (Nursing)
  crystal_isbar_item_id := public._upsert_drill_item(
    'crystal-isbar-90s',
    '90 Second Shift Handoff (ISBAR)',
    'speaking',
    array['crystal-benner'],
    'intermediate',
    90,
    array['ISBAR','handoff','safety'],
    jsonb_build_object(
      'instruction','Deliver a concise ISBAR handoff for a typical med-surg patient.',
      'framework','ISBAR',
      'literacy_levels', array['Lay','Nursing']
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','completeness','max',5),
        jsonb_build_object('key','clarity','max',5),
        jsonb_build_object('key','safety_flags','max',5)
      ]
    ),
    'Approved',
    1
  );

  -- Christopher Buffett (Finance)
  buffett_wrap_item_id := public._upsert_drill_item(
    'buffett-market-wrap-120',
    '2 Minute Market Wrap',
    'speaking',
    array['christopher-buffett'],
    'intermediate',
    120,
    array['finance','client','plain-english'],
    jsonb_build_object(
      'instruction','Summarize today’s market moves for a cautious client using plain English.',
      'structure', array['Headline move','Drivers','So what','Next watch']
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','plain_english','max',5),
        jsonb_build_object('key','structure','max',5),
        jsonb_build_object('key','client_relevance','max',5)
      ]
    ),
    'Approved',
    1
  );

  -- Colton Covey (Business Leadership)
  colton_obj_item_id := public._upsert_drill_item(
    'colton-objection-roleplay',
    'Objection Handling Role Play',
    'roleplay',
    array['colton-covey'],
    'intermediate',
    180,
    array['sales','leadership','roleplay'],
    jsonb_build_object(
      'instruction','Handle a tough pricing objection and secure a next step.',
      'objections', array['Too expensive','Not a priority','We use a competitor'],
      'goal','Book a follow-up or pilot.'
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','empathy','max',5),
        jsonb_build_object('key','framing','max',5),
        jsonb_build_object('key','close','max',5)
      ]
    ),
    'Approved',
    1
  );

  -- Cody Turing (Technical)
  cody_incident_item_id := public._upsert_drill_item(
    'cody-incident-brief-180',
    'Incident Briefing to Executives',
    'speaking',
    array['cody-turing'],
    'advanced',
    180,
    array['incident','cybersecurity','architecture'],
    jsonb_build_object(
      'instruction','Brief executives on an ongoing incident: scope, impact, actions, ETA.',
      'nogo','Avoid jargon. No speculative details.'
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','clarity_non_tech','max',5),
        jsonb_build_object('key','risk_communication','max',5),
        jsonb_build_object('key','next_actions','max',5)
      ]
    ),
    'Approved',
    1
  );

  -- Chloe Sinek (Personal Development)
  chloe_vision_item_id := public._upsert_drill_item(
    'chloe-vision-90s',
    '90 Second Life Vision',
    'speaking',
    array['chloe-sinek'],
    'beginner',
    90,
    array['vision','purpose','values'],
    jsonb_build_object(
      'instruction','Speak your 90 second life vision with one specific next step.',
      'scaffold', array['Values','Vivid picture','One commitment']
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','authenticity','max',5),
        jsonb_build_object('key','specificity','max',5),
        jsonb_build_object('key','commitment','max',5)
      ]
    ),
    'Approved',
    1
  );

  -- Chase Krashen (Pre-College Academic)
  chase_mini_item_id := public._upsert_drill_item(
    'chase-mini-lecture-60',
    '60 Second Mini Lecture',
    'speaking',
    array['chase-krashen'],
    'beginner',
    60,
    array['academic','PEEL','timed'],
    jsonb_build_object(
      'instruction','Deliver a 60 second mini lecture using PEEL on a simple topic.',
      'examples', array['Photosynthesis','Supply and Demand','Climate vs Weather'],
      'framework','PEEL'
    ),
    jsonb_build_object(
      'dimensions', array[
        jsonb_build_object('key','structure_peel','max',5),
        jsonb_build_object('key','clarity','max',5),
        jsonb_build_object('key','timing','max',5)
      ]
    ),
    'Approved',
    1
  );

  -- ===================================================================
  -- SEED DRILL SETS and LINK ITEMS
  -- ===================================================================

  -- Interview Essentials (Carter)
  set_carter_id := public._upsert_drill_set(
    'set-carter-interview-essentials',
    'Interview Essentials — Carter',
    'Core drills to stabilize your interview narrative and STAR delivery.',
    array['carter-goleman'],
    array['interview','STAR','introductions'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_carter_id, carter_tmay_item_id, 1);
  perform public._ensure_set_item(set_carter_id, carter_star_item_id, 2);

  -- IELTS Speaking Core (Chelsea)
  set_chelsea_id := public._upsert_drill_set(
    'set-chelsea-ielts-core',
    'IELTS Speaking Core — Chelsea',
    'Timed prompts, follow-ups, and band aligned feedback.',
    array['chelsea-lightbown'],
    array['IELTS','timed','band'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_chelsea_id, chelsea_p2_item_id, 1);

  -- Research Pitch Starter (Claire)
  set_claire_id := public._upsert_drill_set(
    'set-claire-research-starter',
    'Research Pitch Starter — Claire',
    'Concise research narrative for committees and POIs.',
    array['claire-swales'],
    array['research','pitch','graduate'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_claire_id, claire_pitch_item_id, 1);

  -- ICU Communication (Clark)
  set_clark_id := public._upsert_drill_set(
    'set-clark-icu-comm',
    'ICU Communication — Clark',
    'Safety first case briefs and next steps under pressure.',
    array['clark-atul'],
    array['ICU','SBAR','safety'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_clark_id, clark_icu_item_id, 1);

  -- Nursing Handoffs (Crystal)
  set_crystal_id := public._upsert_drill_set(
    'set-crystal-handoffs',
    'Nursing Handoffs — Crystal',
    'Concise ISBAR, literacy matched teaching, safe escalation.',
    array['crystal-benner'],
    array['ISBAR','handoff','safety'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_crystal_id, crystal_isbar_item_id, 1);

  -- Finance Clarity (Buffett)
  set_buffett_id := public._upsert_drill_set(
    'set-buffett-clarity',
    'Finance Clarity — Buffett',
    'Plain-English market and client framing.',
    array['christopher-buffett'],
    array['finance','client','plain-english'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_buffett_id, buffett_wrap_item_id, 1);

  -- Leadership Objections (Colton)
  set_colton_id := public._upsert_drill_set(
    'set-colton-objections',
    'Leadership Objections — Colton',
    'Handle pushback with empathy, framing, and a clear close.',
    array['colton-covey'],
    array['sales','leadership','roleplay'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_colton_id, colton_obj_item_id, 1);

  -- Incident Comms (Cody)
  set_cody_id := public._upsert_drill_set(
    'set-cody-incident',
    'Incident Communications — Cody',
    'Executive-ready briefings for outages and security events.',
    array['cody-turing'],
    array['incident','communications','architecture'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_cody_id, cody_incident_item_id, 1);

  -- Vision Starter (Chloe)
  set_chloe_id := public._upsert_drill_set(
    'set-chloe-vision',
    'Vision Starter — Chloe',
    'From values to a spoken commitment you can keep.',
    array['chloe-sinek'],
    array['vision','habits','values'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_chloe_id, chloe_vision_item_id, 1);

  -- Academic Mini Lectures (Chase)
  set_chase_id := public._upsert_drill_set(
    'set-chase-mini-lectures',
    'Academic Mini Lectures — Chase',
    'PEEL-structured short talks to build academic tone.',
    array['chase-krashen'],
    array['academic','PEEL','timed'],
    'Approved',
    1
  );
  perform public._ensure_set_item(set_chase_id, chase_mini_item_id, 1);
end$$;

-- Optional cleanup (uncomment if you prefer not to keep helpers)
-- drop function if exists public._ensure_set_item(uuid, uuid, int);
-- drop function if exists public._upsert_drill_set(
--   text, text, text, text[], text[], text, int
-- );
-- drop function if exists public._upsert_drill_item(
--   text, text, text, text[], text, int, text[], jsonb, jsonb, text, int
-- );
