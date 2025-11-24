# Grading and Feedback Contract

**Scope:** Applies to all coaches and drills in Polaris Coach
**Purpose:** Standardize scoring, feedback, and extraction of Expressions Packs across the app
**Last updated:** 2025-10-31

---

## 1. Rubric scale and bands

All coaches use a 0 to 5 scale for each rubric dimension with descriptive anchors. Compute `overall` as the average of dimensions times 20 to map to 0 to 100.

Score bands

* 0 to 1: unclear or off topic
* 2 to 3: understandable with gaps
* 4: strong and task ready
* 5: excellent and concise

Notes

* Keep scoring conservative. A 4 means job or exam ready.
* Round each dimension to the nearest integer unless a coach file specifies decimals.

---

## 2. Core feedback pattern

Each drill must return concise, actionable feedback in the following shape:

* Three wins
* Two fixes
* One next prompt

Wins praise what to keep. Fixes give one line edits. The next prompt points to the immediate next practice step.

---

## 3. JSON response contract

Every coach returns a single fenced JSON block that the Practice Engine can parse. The contract mirrors the coach specific rubric keys but follows the same pattern.

```json
{
  "modelAnswer": "string",
  "wins": ["string", "string", "string"],
  "fixes": ["string", "string"],
  "nextPrompt": "string",
  "rubric": {
    "<dimension_1>": 0,
    "<dimension_2>": 0,
    "<dimension_3>": 0,
    "<dimension_4>": 0,
    "<dimension_5>": 0,
    "overall": 0
  },
  "expressions": [
    {
      "text_original": "string",
      "text_upgraded": "string",
      "collocations": ["string", "string"],
      "pronunciation": {"word": "string", "hint": "string"},
      "examples": ["string"]
    }
  ]
}
```

Rules

* Keep strings short and plain.
* `overall` is computed, not free form.
* `expressions` length is 3 to 6 unless the drill specifies otherwise.

---

## 4. Expressions Pack rules

At session end, extract upgraded phrasing for the learner library.

* Pair a corrected line with an upgraded version
* Add 2 to 3 collocations that fit the topic
* Add an optional pronunciation hint in simple form, for example negotiate: nuh GOH shee ate
* Add a single re say or re try prompt to practice aloud again

Do not introduce new content that the learner did not say unless it clarifies safety or phrasing. Background quality checks hide risky items from public catalogs while keeping them private for the user.

States when promoting to catalogs

* Private User
* Candidate Exemplar
* Published Exemplar
* Deprecated

---

## 5. Timing, pacing, and caps

Respect the time box for each drill as defined in the coach file. If the learner runs long, suggest a 3 sentence compression. The engine records `time_on_task_seconds`, `words_per_minute`, and whether the learner used the timer.

---

## 6. Rubric keys by coach

Each coach maps to five dimensions plus `overall`. Use these exact keys in the JSON `rubric` object.

* **Chase Krashen**
  structure, evidence, reasoning, clarity, delivery
* **Dr. Claire Swales**
  structure, fit_alignment, evidence_methods, clarity_style, presence_confidence
* **Carter Goleman**
  structure, relevance, impact, clarity, presence
* **Chelsea Lightbown**
  fluency_coherence, lexical_resource, grammar_accuracy, pronunciation, topic_development
* **Dr. Clark Atul**
  structure, clinical_reasoning, safety_recommendations, clarity_tone, evidence_guidelines
* **Dr. Crystal Benner**
  structure, accuracy, clarity, empathy_tone, safety
* **Christopher Buffett**
  clarity, accuracy, structure, client_framing, numeracy
* **Colton Covey**
  clarity, relevance, structure, persuasion, presence
* **Cody Turing**
  clarity, technical_accuracy, structure, audience_targeting, brevity_under_stress
* **Chloe Sinek**
  clarity, specificity_action, presence_tone, structure, follow_through

---

## 7. Scoring weights and normalization

Default weight per dimension is 1.0. To adjust emphasis within a coach, add weights at the coach level in code, then compute a weighted average before multiplying by 20.

Normalization rules

* Clamp each dimension to 0 to 5.
* Compute `overall_raw` as the weighted mean
* `overall` equals `Math.round(overall_raw * 20)`

Optional penalties

* Overtime penalty: minus 0.2 from `overall_raw` if answer exceeds time by more than 30 percent
* Safety penalty: set `overall` to 0 and mark `flag_safety=true` if the output violates a safety rule

---

## 8. Safety and policy

* No dosing or prescriptive medical advice without full context
* No investment advice or guarantees
* No personal data or identifiers in examples
* Keep examples school safe and culturally respectful
* If risky content is detected, return feedback and learning guidance but hide Expressions from public catalogs and set `flag_safety=true`

---

## 9. Analytics mapping

The API persists the following fields to the database for each attempt.

* `attempt_id`, `session_id`, `user_id`, `drill_id`, `coach_key`
* `rubric_json`, `overall_score`, `wins`, `fixes`, `next_prompt`
* `expressions_json`, `expressions_count`
* `time_on_task_seconds`, `words_per_minute`
* `report_rate`, `helpfulness_rating`
* `flag_safety`, `flag_risky_language`

Derived metrics for dashboards

* Starts, completes, average score, WPM, time on task
* Helpfulness distribution and report rate
* Expressions saved per session and favorite rate
* Coach and topic breakdowns by tier

---

## 10. Calibration and QA

Weekly calibration keeps scoring consistent.

* Sample five attempts per coach across tiers
* Two admins score independently then compare
* Discuss gaps and update examples or anchors
* Refresh the phrase bank with two new examples per coach

Auto QA checks

* Safety terms and dosing in medical content
* Financial advice terms and guarantees
* PII patterns and identifiers
* Toxic, biased, or disrespectful phrasing

---

## 11. Weekly recap thresholds

The recap engine selects items based on:

* `overall_score` under 60 with high helpfulness
* `expressions_count` under 3 for a drill
* Time on task under 40 percent of target
* High report rate for a drill or coach

Recap card includes

* Three suggested drills, one vocab review, one reflection
* One chart for time on task and WPM trend
* A short note from the chosen coach persona

---

## 12. Integration with tiers and entitlements

Tier rules affect drill access and time caps only. Scoring is identical across tiers. Entitlements determine whether the app shows gated drills or tool features, but all attempts use the same grading contract.

---

## 13. Error handling

If the model cannot produce a valid JSON block, the API will:

1. Return a friendly message to retry
2. Log the raw text for QA
3. Save a system error event for analytics

---

## 14. Example minimal JSON

```json
{
  "modelAnswer": "One sentence answer sketch that fits the drill.",
  "wins": ["Clear structure", "Specific example", "Calm tone"],
  "fixes": ["Add one number", "Compress the opening"],
  "nextPrompt": "Give a 45 second variant.",
  "rubric": {"clarity": 4, "structure": 4, "relevance": 4, "presence": 4, "persuasion": 3, "overall": 78},
  "expressions": [
    {"text_original": "It was good", "text_upgraded": "It was highly effective for this goal", "collocations": ["highly effective", "for this goal"], "pronunciation": {"word": "effective", "hint": "ih FEK tiv"}, "examples": ["It was highly effective for this goal"]}
  ]
}
```

---

## 15. Admin checklist for releases

* Confirm rubric keys match coach files
* Confirm `overall` computation in API
* Smoke test two drills per coach in staging
* Enable feature flag for a small cohort in production
* Add a rollback flag and last known good build reference
