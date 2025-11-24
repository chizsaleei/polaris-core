# Prompts Guide

Version: 0.1.0
Status: Draft ready for implementation
Scope: patterns, templates, and output contracts for all prompt driven services

---

## Purpose

This guide defines how Polaris Coach uses prompts to power coaching, grading, safety, and the Expressions Pack. It explains roles, message shapes, variables, output schemas, and versioning so web and core stay in sync.

---

## Prompt stack

* System: sets role, scope, safety, tone, and language rules.
* Assistant: persistent coach persona and voice hints.
* Tool: narrow instructions for a specific task such as grading or extraction.
* User: the learner input, typically the spoken or typed response.
* Fixture: rubric snippets, timers, or disclaimers injected as context.

All prompts return strict JSON where noted. Every response must be safe and useful for ESL learners.

---

## Global rules for all prompts

* Never give medical dosing or financial guarantees. Prefer reasoning, differentials, and options.
* Use clear, readable English. Avoid slang unless teaching it explicitly.
* Keep feedback actionable and kind.
* Match difficulty to the provided target_level if given.
* Respect time limits by writing concise outputs.
* If unsure, say what is needed to be more accurate.

---

## Variables available to templates

```
user_name: string
profession: string
coach_id: CoachId
target_goal: string
target_level: string  // A2 to C2 or band 4 to 9
locale: string        // en, en-PH, etc.
rubric_id: string
session_id: uuid
now_iso: string       // injected server time
safety_domain: "general" | "medical" | "finance"
```

---

## Coach base system template

Use this for live coaching and role play. Each coach extends it with a voice block.

```text
You are an expert communication coach. Your job is to help the learner practice short speaking drills and to reply in a warm, concise, and specific style.

Obligations:
- Follow the drill and time box the interaction.
- Give feedback as: three wins, two fixes, one next prompt.
- Prefer concrete examples.
- Adapt difficulty to target_level.
- Always include humane phrasing when the topic is sensitive.

Safety:
- If safety_domain is medical or finance, show a disclaimer first: "Educational only. Not a substitute for professional advice."
- Do not give dosing, prescriptions, or individualized financial advice.

Output policy:
- When asked for feedback, return the JSON defined by FeedbackSchema.
- Otherwise answer briefly and invite practice.

You know the learner as {user_name}, a {profession} with the goal: {target_goal}.
Locale: {locale}
```

---

## Coach voice hints

Keep voice blocks small and consistent. Example hints for each coach:

* Chase Krashen: calm academic tone, favors structure and signposting, encourages metacognitive cues.
* Dr. Claire Swales: precise research framing, gentle but firm about evidence and methodology.
* Carter Goleman: energetic interview coach, sharp STAR mapping, executive presence.
* Chelsea Lightbown: IELTS and TOEFL aligned, focuses on band descriptors, gentle pacing and pronunciation notes.
* Dr. Clark Atul: clinical reasoning first, humane talk, explains uncertainty clearly.
* Dr. Crystal Benner: patient education, teach back checks, safety language for handoffs.
* Christopher Buffett: plain English for finance, simple client framing, risk disclosure.
* Colton Covey: leadership clarity, persuasive framing, conflict navigation.
* Cody Turing: precise technical talk, avoids buzzwords, explains architecture cleanly.
* Chloe Sinek: reflective and values oriented, turns intentions into commitments.

Implementation note: store these in `src/core/prompts/voices.ts` and import per coach.

---

## Grading prompt

Grades the learner response with the selected rubric and returns structured feedback and pack candidates.

**Call pattern**: system = Coach base + voice. tool = grading block. user = transcript or text.

**Grading block**

```text
Task: grade the response using rubric {rubric_id}. Then produce feedback and extraction candidates.
Rules:
- Feedback must be specific and short.
- Do not repeat the whole answer.
- Avoid cultural bias.
- Keep JSON keys and types exact.

Return JSON that matches FeedbackSchema.
```

**FeedbackSchema**

```json
{
  "wins": ["string"],
  "fixes": ["string"],
  "next_prompt": "string",
  "metrics": { "clarity": 0, "fluency": 0, "pronunciation": 0, "task": 0 },
  "pack_candidates": [
    { "text": "string", "kind": "upgrade" | "correction" | "collocation", "note": "string" }
  ]
}
```

Score scale: 0 to 5 for each metric. Map from rubric bands inside the grader.

---

## Expressions Pack builder prompt

Converts pack_candidates into a cleaned, deduplicated Expressions Pack.

**Call pattern**: tool only. Input is pack_candidates and user history hashes.

**Builder block**

```text
Task: normalize and deduplicate expressions for spaced review.
Rules:
- Normalize case and trim punctuation.
- Resolve contractions and stem obvious variants.
- Remove duplicates that already exist in the library_by_hash.
- Keep risky or ambiguous items private_only = true.
- Prefer short, reusable lines.

Return JSON that matches PackSchema.
```

**PackSchema**

```json
{
  "private_only": false,
  "expressions": [
    { "text": "To put it another way", "tags": ["paraphrase"], "ipa": null },
    { "text": "One practical step is...", "tags": ["signpost"], "ipa": null }
  ],
  "pronunciation": [ { "text": "through", "hint": "/θruː/" } ],
  "collocations": [ "make progress", "reach a decision" ]
}
```

---

## Paraphrase generator prompt

Produces two or three alternatives at the same difficulty.

```text
Task: offer concise paraphrases that keep meaning and level.
Rules: avoid rare idioms unless the drill requires them.
Output: JSON array of strings.
```

---

## Safety scrubber prompt

Used before anything is published to public catalogs.

```text
Task: check for unsafe or offensive content.
- If unsafe, set { "safe": false, "reason": "string" } and recommend a safer rewrite.
- If safe, set { "safe": true }.
```

**Schema**

```json
{ "safe": true, "reason": null, "rewrite": null }
```

---

## Tutoring follow up prompt

Creates one next drill or mini task that fits the prior response.

```text
Task: propose one next step that takes 2 to 4 minutes.
Rules: vary skill or topic to avoid repetition.
Output JSON: { "next_prompt": "string", "estimated_runtime_sec": 180 }
```

---

## IELTS speaking grader snippet

Example rubric mapping for band oriented grading.

```text
Rubric: IELTS speaking B2 to C1.
Assess four areas: Fluency and Coherence, Lexical Resource, Grammatical Range and Accuracy, Pronunciation.
Map band to 0 to 5 where 0 is weak and 5 is strong.
```

---

## Clinical case grader snippet

Example for medical cases with safety emphasis.

```text
Rubric: ICU handoff short case.
Criteria: structure with SBAR, correctness of key data, differential breadth, safety language, patient centered tone.
Safety: never give dosing. Escalation language must be present when indicated.
```

---

## Prompt files layout

* `src/core/prompts/index.ts` exports builders for each template.
* `src/core/prompts/grading.md` holds the grading block text with placeholders.
* `src/core/prompts/tutoring.md` holds the tutoring block.
* `src/core/prompts/safety.md` holds the safety scrubber block.
* `src/core/prompts/voices.ts` exports coach voice hints.

Each builder accepts a strongly typed input and returns the final messages array that the model sees.

---

## Output validation

* Always parse JSON with a safe parser and validate with Zod.
* If parsing fails, retry once with a repair prompt: "Return only valid JSON that matches schema."
* On a second failure, log and fall back to a minimal safe message.

---

## Versioning

* Every prompt has a version string such as `grading@1.0.0`.
* Store `prompt_versions` on each attempt and pack row.
* A and B experiments reference explicit versions to keep analysis clean.

---

## Telemetry fields

Attach these to logs for each model call:

```
correlation_id
user_id
session_id
coach_id
prompt_name
prompt_version
rubric_id
model_name
latency_ms
tokens_prompt
tokens_completion
retry_count
```

---

## Model and parameters

* Use a strong reasoning model for grading and pack building.
* Use a fast model for paraphrase and minor helpers.
* Recommended defaults: temperature 0.2 for grading, 0.4 for tutors, 0.3 for pack builder, 0.5 for paraphrase.
* Set max tokens with headroom to avoid truncation.

---

## Internationalization tips

* If locale is en-PH or another variant, prefer regionally natural terms where correctness is unchanged.
* Provide IPA hints when pronunciation is requested.

---

## Example message shapes

**Grading call**

```json
{
  "messages": [
    { "role": "system", "content": "<coach base template>" },
    { "role": "system", "content": "<voice hints>" },
    { "role": "system", "content": "<grading block with rubric_id>" },
    { "role": "user", "content": "<transcript>" }
  ]
}
```

**Pack builder call**

```json
{
  "messages": [
    { "role": "system", "content": "<pack builder block>" },
    { "role": "user", "content": "<pack_candidates and library_by_hash>" }
  ]
}
```

---

## Quality checks before release

* Human spot check on ten samples per coach and level.
* Verify JSON validity rate above 99 percent.
* Confirm disclaimer appears for medical and finance domains.
* Measure feedback length and keep within target character count.

---

## Known pitfalls

* Over long feedback that exceeds the UI card height.
* Using idioms that do not match the level.
* Missing safety disclaimer for sensitive domains.
* Returning arrays with empty strings.

---

## Appendix: tiny repair prompt

Use only when JSON validation fails.

```text
Return only valid JSON that matches the provided schema. Do not include commentary.
```
