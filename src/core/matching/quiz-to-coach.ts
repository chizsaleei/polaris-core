/**
 * Polaris Coach — quiz-to-coach.ts
 * Maps onboarding quiz answers to coach recommendations and starter drills.
 * Keeps tier limits, cooldowns, and a deterministic 7 day starter plan.
 */

// ---------- Types

export enum Tier {
  FREE = 'free',
  PRO = 'pro',
  VIP = 'vip',
}

export type CoachKey =
  | 'chase_krashen'
  | 'dr_claire_swales'
  | 'carter_goleman'
  | 'chelsea_lightbown'
  | 'dr_clark_atul'
  | 'dr_crystal_benner'
  | 'christopher_buffett'
  | 'colton_covey'
  | 'cody_turing'
  | 'chloe_sinek'

export interface QuizAnswers {
  firstName: string
  profession: string
  goal: string
  domains: string[] // e.g., ['IELTS', 'ICU', 'Finance', 'Leadership']
  priorities: Array<'fluency' | 'interview' | 'exam' | 'leadership' | 'technical' | 'medical' | 'nursing' | 'finance' | 'admissions' | 'personal'>
  difficulty: 1 | 2 | 3 | 4 | 5
}

export interface CoachRec {
  coach: CoachKey
  score: number
  reason: string[]
}

export interface StarterDrill {
  title: string
  prompt: string
  estMinutes: number
}

export interface SevenDayPlan {
  coach: CoachKey
  dayPlan: Array<{
    day: number // 1..7
    type: 'drill' | 'vocab' | 'reflection'
    title: string
    prompt?: string
  }>
}

// ---------- Coach audience map used for scoring

const COACH_AUDIENCE: Record<CoachKey, { tags: string[]; display: string }> = {
  chase_krashen: {
    display: 'Chase Krashen',
    tags: ['pre-college', 'academic', 'scholarship', 'charts', 'debate', 'exam'],
  },
  dr_claire_swales: {
    display: 'Dr. Claire Swales',
    tags: ['graduate', 'admissions', 'research', 'methods', 'SOP', 'interview'],
  },
  carter_goleman: {
    display: 'Carter Goleman',
    tags: ['interview', 'behavioral', 'STAR', 'career-switch', 'negotiation'],
  },
  chelsea_lightbown: {
    display: 'Chelsea Lightbown',
    tags: ['IELTS', 'TOEFL', 'ESL', 'fluency', 'paraphrase', 'pronunciation', 'exam'],
  },
  dr_clark_atul: {
    display: 'Dr. Clark Atul',
    tags: ['physician', 'ICU', 'OSCE', 'viva', 'SBAR', 'SOAP', 'diagnostic'],
  },
  dr_crystal_benner: {
    display: 'Dr. Crystal Benner',
    tags: ['nursing', 'ISBAR', 'education', 'escalation', 'OSCE'],
  },
  christopher_buffett: {
    display: 'Christopher Buffett',
    tags: ['finance', 'client', 'markets', 'ratios', 'certification'],
  },
  colton_covey: {
    display: 'Colton Covey',
    tags: ['leadership', 'sales', 'meetings', 'feedback', 'objections'],
  },
  cody_turing: {
    display: 'Cody Turing',
    tags: ['technical', 'IT', 'cyber', 'incident', 'architecture', 'certification'],
  },
  chloe_sinek: {
    display: 'Chloe Sinek',
    tags: ['personal', 'vision', 'values', 'habit', 'gratitude'],
  },
}

// ---------- Starter drills per coach aligned with coach prompt .md files

export function getStarterDrills(
  coach: CoachKey,
  tier: Tier,
  minutes = 12,
): StarterDrill[] {
  const m = minutes
  const byTier = (items: StarterDrill[]) => {
    // Gating: Free gets first 2, Pro first 3, VIP all
    if (tier === Tier.FREE) return items.slice(0, 2)
    if (tier === Tier.PRO) return items.slice(0, 3)
    return items
  }

  switch (coach) {
    case 'carter_goleman':
      return byTier([
        {
          title: 'Two minute STAR sprint',
          prompt:
            'Tell a two minute STAR story about a tough problem. Situation and Task in one line, two Actions, one Result with a number.',
          estMinutes: m,
        },
        {
          title: 'Tell me about yourself refinement',
          prompt:
            'Give a 60 second past present future answer. Then produce a 30 second variant.',
          estMinutes: m,
        },
        {
          title: 'Weakness to growth reframe',
          prompt:
            'Share a real weakness, how you addressed it, and one safeguard that keeps you improving.',
          estMinutes: m,
        },
        {
          title: 'Panel interview simulation',
          prompt:
            'Answer three short rotating questions under 45 seconds each and link back to the role.',
          estMinutes: m,
        },
      ])

    case 'chase_krashen':
      return byTier([
        {
          title: '60 second mini lecture',
          prompt:
            'Give a 60 second mini lecture using PEEL: Point, Evidence, Explain, Link. End with one question.',
          estMinutes: m,
        },
        {
          title: 'Charts comparison out loud',
          prompt:
            'Compare two charts. Name the topic, two biggest differences with numbers, and a one line summary.',
          estMinutes: m,
        },
        {
          title: 'Debate starter with counterargument',
          prompt:
            'Take a position, give one reason, present a timed counterargument, and a short reply.',
          estMinutes: m,
        },
        {
          title: 'Scholarship interview mock',
          prompt:
            'Answer two scholarship questions and respond to one follow up probe with a concrete example.',
          estMinutes: m,
        },
      ])

    case 'chelsea_lightbown':
      return byTier([
        {
          title: 'IELTS Part 2 long turn',
          prompt:
            'Speak up to two minutes on the card. Use linking words and one mini example. Expect two follow up questions.',
          estMinutes: m,
        },
        {
          title: 'Paraphrase three ways',
          prompt:
            'Take one sentence and say it three different ways with synonyms, structure changes, and linking.',
          estMinutes: m,
        },
        {
          title: 'TOEFL integrated summary',
          prompt:
            'Give a 45 second summary that connects one reading idea and one listening point. Show the relationship.',
          estMinutes: m,
        },
        {
          title: 'Phrase upgrade swap',
          prompt:
            'Replace simple phrases with higher band alternatives using accurate collocations.',
          estMinutes: m,
        },
      ])

    case 'dr_clark_atul':
      return byTier([
        {
          title: 'ICU case presentation',
          prompt:
            'Present a new ICU admission using SBAR. End with two differentials, a working diagnosis, and three immediate steps with safety checks.',
          estMinutes: m,
        },
        {
          title: 'Diagnostic reasoning think aloud',
          prompt:
            'From symptoms to differentials to tests. Name one rule in and one rule out and the key test.',
          estMinutes: m,
        },
        {
          title: 'Informed consent role play',
          prompt:
            'Explain a procedure in plain language. Cover benefits, risks, alternatives, and check understanding with teach back.',
          estMinutes: m,
        },
        {
          title: 'M and M defense',
          prompt:
            'Summarize an adverse event. State the error chain, the change made, and the safeguard to prevent repeat.',
          estMinutes: m,
        },
      ])

    case 'dr_crystal_benner':
      return byTier([
        {
          title: 'ISBAR shift handoff',
          prompt:
            'Give a 90 second ISBAR handoff. Include name, age, diagnosis, key background, current assessment, and recommendation.',
          estMinutes: m,
        },
        {
          title: 'Medication teaching with teach back',
          prompt:
            'Teach purpose, timing, one warning, and ask the patient to repeat key steps to confirm understanding.',
          estMinutes: m,
        },
        {
          title: 'Rapid deterioration escalation',
          prompt:
            'Call the rapid response team using ISBAR in under 60 seconds. State the vital that triggered the call.',
          estMinutes: m,
        },
        {
          title: 'Therapeutic communication',
          prompt:
            'Respond to a distressed patient. Acknowledge feeling, give one simple explanation, and state what you will do next.',
          estMinutes: m,
        },
      ])

    case 'christopher_buffett':
      return byTier([
        {
          title: 'Two minute market wrap',
          prompt:
            'State one theme, two drivers with numbers, one risk to watch, and a neutral outlook line.',
          estMinutes: m,
        },
        {
          title: 'Rebalancing pitch for a cautious client',
          prompt:
            'Goal, shift in allocation with percentages, downside risk and safeguard, and ask for alignment.',
          estMinutes: m,
        },
        {
          title: 'Explain a complex instrument simply',
          prompt:
            'Define it for a smart non expert with one analogy and one number. Name one risk.',
          estMinutes: m,
        },
        {
          title: 'Case defense under time pressure',
          prompt:
            'Thesis, two drivers with numbers, a bear case with trigger, and your monitoring plan in 90 seconds.',
          estMinutes: m,
        },
      ])

    case 'colton_covey':
      return byTier([
        {
          title: 'Five slide strategy pitch',
          prompt:
            'Problem, Goal, Options, Proposal, Next steps. End with a clear ask and a timeline.',
          estMinutes: m,
        },
        {
          title: 'Objection handling role play',
          prompt:
            'Handle two objections using intent, validate, reframe, and a next step. Keep each under 45 seconds.',
          estMinutes: m,
        },
        {
          title: 'Difficult feedback rehearsal',
          prompt:
            'Use intent, observation, impact, and request. Keep tone kind and firm.',
          estMinutes: m,
        },
        {
          title: 'Quarterly update in 90 seconds',
          prompt:
            'Three wins, two risks, and one ask linked to goals.',
          estMinutes: m,
        },
      ])

    case 'cody_turing':
      return byTier([
        {
          title: 'Architecture walkthrough',
          prompt:
            'Explain purpose, key components, data flow, and one tradeoff. End with a risk and mitigation.',
          estMinutes: m,
        },
        {
          title: 'Executive incident briefing',
          prompt:
            'Cause, blast radius, customer impact, time to recovery, and one next step in 60 to 90 seconds.',
          estMinutes: m,
        },
        {
          title: 'Threat model elevator pitch',
          prompt:
            'One asset, one threat, two controls, and one open risk in 60 seconds.',
          estMinutes: m,
        },
        {
          title: 'Troubleshooting tree narration',
          prompt:
            'State hypothesis, test, result, and next branch. Name the signal that guided you.',
          estMinutes: m,
        },
      ])

    case 'dr_claire_swales':
      return byTier([
        {
          title: 'Three minute research pitch',
          prompt:
            'Motivation, Question, Method, Expected impact, and Fit to the target lab or program.',
          estMinutes: m,
        },
        {
          title: 'Method explain it like I am a first year',
          prompt:
            'Define the core method in plain English, give one analogy, one number, and a limitation.',
          estMinutes: m,
        },
        {
          title: 'Ethics and limitation hot seat',
          prompt:
            'Answer two short questions under 45 seconds each. Name one safeguard and how you will monitor.',
          estMinutes: m,
        },
        {
          title: 'Lightning literature gap summary',
          prompt:
            'Field, knowns, the gap, and your small contribution in 60 seconds.',
          estMinutes: m,
        },
      ])

    case 'chloe_sinek':
      return byTier([
        {
          title: 'Life vision speech',
          prompt:
            'State purpose, two values with a short example, and commit to one action this week.',
          estMinutes: m,
        },
        {
          title: 'Boundary setting role play',
          prompt:
            'Kind opener, boundary line, reason, and an alternative or time box.',
          estMinutes: m,
        },
        {
          title: 'Weekly commitment stand up',
          prompt:
            'One focus, two tasks, one risk, and a check in day and time.',
          estMinutes: m,
        },
        {
          title: 'Gratitude and learning share out',
          prompt:
            'One gratitude, one lesson, and one change you will try this week. Close with a thank you.',
          estMinutes: m,
        },
      ])
  }
}

// ---------- Recommendation scoring

export function recommendCoaches(
  answers: QuizAnswers,
  tier: Tier,
  limit = 5,
): CoachRec[] {
  const terms = [
    answers.profession,
    answers.goal,
    ...answers.domains,
    ...answers.priorities,
  ]
    .filter(Boolean)
    .map((s) => s.toString().toLowerCase())

  const scores: CoachRec[] = (Object.keys(COACH_AUDIENCE) as CoachKey[]).map(
    (key) => {
      const meta = COACH_AUDIENCE[key]
      let score = 0
      const reason: string[] = []

      meta.tags.forEach((tag) => {
        const hit = terms.some((t) => t.includes(tag.toLowerCase()))
        if (hit) {
          score += 10
          reason.push(tag)
        }
      })

      // Profession nudges
      if (/student|senior high|freshman/.test(answers.profession.toLowerCase())) {
        if (key === 'chase_krashen') score += 8
      }
      if (/physician|doctor|resident/.test(answers.profession.toLowerCase())) {
        if (key === 'dr_clark_atul') score += 12
      }
      if (/nurse|rn|np/.test(answers.profession.toLowerCase())) {
        if (key === 'dr_crystal_benner') score += 12
      }
      if (/finance|analyst|accountant|cfa|frm|cfp/.test(
        answers.profession.toLowerCase(),
      )) {
        if (key === 'christopher_buffett') score += 12
      }
      if (/manager|founder|sales|operations|leader/.test(
        answers.profession.toLowerCase(),
      )) {
        if (key === 'colton_covey') score += 10
      }
      if (/developer|engineer|sysadmin|security|it|cloud/.test(
        answers.profession.toLowerCase(),
      )) {
        if (key === 'cody_turing') score += 10
      }
      if (/ielts|toefl|esl|band/.test(
        [answers.goal, ...answers.domains].join(' ').toLowerCase(),
      )) {
        if (key === 'chelsea_lightbown') score += 10
      }
      if (/grad|graduate|admission|sop|research|phd/.test(
        [answers.goal, ...answers.domains].join(' ').toLowerCase(),
      )) {
        if (key === 'dr_claire_swales') score += 10
      }
      if (/interview|resume|behavioral|star|offer/.test(
        [answers.goal, ...answers.domains, ...answers.priorities]
          .join(' ')
          .toLowerCase(),
      )) {
        if (key === 'carter_goleman') score += 10
      }
      if (/vision|values|habit|personal growth|purpose/.test(
        [answers.goal, ...answers.domains].join(' ').toLowerCase(),
      )) {
        if (key === 'chloe_sinek') score += 8
      }

      // Difficulty bias: higher difficulty gives a small nudge to pro style coaches
      score += (answers.difficulty - 3) * 1.5

      return { coach: key, score, reason }
    },
  )

  // Sort by score desc and break ties by stable order of keys
  scores.sort((a, b) => (b.score - a.score) || a.coach.localeCompare(b.coach))

  // Enforce tier coach limit during onboarding: Free and Pro can hold one active coach, VIP can hold many
  const top = scores.slice(0, limit)
  return top
}

// ---------- 7 day plan

export function buildSevenDayPlan(
  coach: CoachKey,
  tier: Tier,
  minutes = 12,
): SevenDayPlan {
  const drills = getStarterDrills(coach, tier, minutes)
  const plan: SevenDayPlan = { coach, dayPlan: [] }

  // Deterministic layout: 3 drills, 1 vocab, 1 reflection, then repeat pattern
  const items: Array<{ type: SevenDayPlan['dayPlan'][number]['type']; title: string; prompt?: string }> = []
  for (let i = 0; i < Math.min(3, drills.length); i++) {
    items.push({ type: 'drill', title: drills[i].title, prompt: drills[i].prompt })
  }
  items.push({ type: 'vocab', title: 'Vocabulary review', prompt: 'Review your Expressions Pack. Favorite two items and retry aloud.' })
  items.push({ type: 'reflection', title: 'Weekly reflection', prompt: 'Two wins, one fix, one next action with a time cue.' })

  // Fill to 7 days by cycling drills or adding practice now
  while (items.length < 7) {
    const idx = (items.length - 0) % drills.length
    items.push({ type: 'drill', title: drills[idx].title, prompt: drills[idx].prompt })
  }

  plan.dayPlan = items.map((it, i) => ({ day: i + 1, ...it }))
  return plan
}

// ---------- Cooldown and entitlement helpers

export function canHoldMultipleCoaches(tier: Tier): boolean {
  return tier === Tier.VIP
}

export function coachSwitchCooldownDays(tier: Tier): number {
  // Free and Pro have a cooldown to limit churn. VIP has none.
  if (tier === Tier.VIP) return 0
  return 7
}

// ---------- Convenience wrapper used by onboarding API

export function recommendWithPlan(
  answers: QuizAnswers,
  tier: Tier,
): { recommendations: CoachRec[]; starterPlan: SevenDayPlan } {
  const recommendations = recommendCoaches(answers, tier, 5)
  const firstCoach = recommendations[0]?.coach ?? 'carter_goleman'
  const starterPlan = buildSevenDayPlan(firstCoach, tier)
  return { recommendations, starterPlan }
}
