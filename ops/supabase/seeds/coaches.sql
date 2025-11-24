-- =====================================================================
-- seeds/coaches.sql
-- Seed the 10 Polaris AI coaches with concise metadata.
-- Idempotent: safe to run multiple times.
--
-- Schema (from 0001_init.sql):
--   public.coaches (
--     key         text primary key,
--     display_name text not null,
--     tagline     text,
--     audience    text,
--     benefits    text,
--     tools       text[],
--     is_active   boolean not null default true,
--     created_at  timestamptz not null default now(),
--     updated_at  timestamptz not null default now()
--   )
-- =====================================================================

create or replace function public._upsert_coach(
  p_key text,
  p_display_name text,
  p_audience text,
  p_tagline text,
  p_benefits text,
  p_tools text[],
  p_is_active boolean
) returns void
language sql
as $fn$
  insert into public.coaches as c
    (key, display_name, audience, tagline, benefits, tools, is_active, created_at, updated_at)
  values
    (p_key, p_display_name, p_audience, p_tagline, p_benefits, p_tools, p_is_active, now(), now())
  on conflict (key) do update
    set display_name = excluded.display_name,
        audience     = excluded.audience,
        tagline      = excluded.tagline,
        benefits     = excluded.benefits,
        tools        = excluded.tools,
        is_active    = excluded.is_active,
        updated_at   = now();
$fn$;

with base as (
  select
    'carter-goleman'  as k,
    'Carter Goleman - Professional Interview Communicator' as dn,
    'Job seekers, career switchers, interns, returnees'    as aud,
    'Crisp STAR stories and confident interviewing'        as tag,
    'Crisp STAR answers; Executive presence; Persuasive closing' as bens,
    array[
      'Competency map',
      'Story bank (STAR)',
      'Behavioral and case Q generator',
      'Offer negotiation rehearsal'
    ]::text[] as tls
  union all select
    'chase-krashen',
    'Chase Krashen - Academic English and Exam Strategist (Pre-College)',
    'Senior high school, gap year, early freshmen',
    'Academic tone and speed under time limits',
    'Organized answers; Fluency under time; Scholarship interview readiness',
    array[
      'Goal mapper',
      'Vocabulary ladder',
      'PEEL point builder',
      'Rubric tracker'
    ]::text[]
  union all select
    'chelsea-lightbown',
    'Chelsea Lightbown - English Proficiency (IELTS or TOEFL or ESL)',
    'IELTS or TOEFL takers, general ESL learners',
    'Band aligned practice with pronunciation clarity',
    'Fluency under time; Lexical range; Pronunciation clarity',
    array[
      'Band targeted prompts',
      'Pronunciation mirror',
      'Paraphrase generator',
      'Timing coach WPM'
    ]::text[]
  union all select
    'chloe-sinek',
    'Chloe Sinek - Personal Development and Vision Communicator',
    'Purpose builders, creators, early leaders',
    'Turn values into clear, spoken commitments',
    'Compelling narrative; Calm delivery; Actionable language',
    array[
      'Vision to vow builder',
      'Values to boundary phrases',
      'Accountability recorder',
      'Habit reflection prompts'
    ]::text[]
  union all select
    'christopher-buffett',
    'Christopher Buffett - Financial English and Certifications',
    'Finance students and pros CFP or CFA or FRM',
    'Plain English finance with client clarity',
    'Jargon to plain English; Persuasive framing; Exam clarity',
    array[
      'KPI and ratio explainer',
      'Risk profile role play',
      'Mock viva prompts',
      'Jargon converter'
    ]::text[]
  union all select
    'claire-swales',
    'Dr. Claire Swales - Graduate Admissions Communicator',
    'Grad applicants and research assistants',
    'Sharp research pitch and academic story',
    'Clear framing; Concise storytelling; Confident Q and A',
    array[
      'Research pitch canvas',
      'SOP to Speech converter',
      'Methodology clarifier',
      'Committee Q bank'
    ]::text[]
  union all select
    'clark-atul',
    'Dr. Clark Atul - Medical Communication and Exams (Physicians)',
    'Physicians for viva, OSCE, MMI, MOC',
    'Precise, humane clinical talk under pressure',
    'Structured cases; Diagnostic justification; Safe recommendations',
    array[
      'SBAR and SOAP templates',
      'Differential prompts',
      'Bad news rehearsal',
      'Guideline citation tips'
    ]::text[]
  union all select
    'crystal-benner',
    'Dr. Crystal Benner - Nursing Communication and Exams',
    'Nursing students, RNs, NPs',
    'Clear teaching, accurate handoffs, safe escalation',
    'Layperson teaching; Accurate ISBAR; Confident escalation',
    array[
      'ISBAR builder',
      'Patient teaching scripts at three levels',
      'Safety escalation phrases',
      'Care plan to Report converter'
    ]::text[]
  union all select
    'colton-covey',
    'Colton Covey - Business English and Leadership',
    'Managers, founders, sales and ops leaders',
    'Executive clarity and persuasive change talk',
    'Executive clarity; Persuasive framing; Conflict navigation',
    array[
      'Meeting opener or closer',
      'Change storytelling canvas',
      'Sales objections',
      'Feedback script studio'
    ]::text[]
  union all select
    'cody-turing',
    'Cody Turing - Technical English and Certifications (IT or Cyber)',
    'Devs, sysadmins, SOC, cloud, cert candidates',
    'Concise, correct incident and architecture talk',
    'Precision under stress; Clear architectures; Cert readiness',
    array[
      'Incident report template',
      'Architecture walkthrough',
      'Acronym to simple language',
      'Cert objective quiz to verbal'
    ]::text[]
)
select public._upsert_coach(
  k,
  dn,
  aud,
  tag,
  bens,
  tls,
  true
) from base;

drop function if exists public._upsert_coach(
  text, text, text, text, text, text[], boolean
);
