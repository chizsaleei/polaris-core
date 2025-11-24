# Polaris Coach API Contracts

Version: 0.1.0
Status: Draft ready for implementation
Scope: Public and internal HTTP contracts for web app routes and the core service

---

## Conventions

* Base URL: `https://app.example.com` for production, staging uses your staging domain.
* Auth: `Authorization: Bearer <supabase_jwt>` on all authenticated routes.
* Content type: JSON for requests and responses unless noted.
* Idempotency: write endpoints accept `Idempotency-Key` header. The server treats the tuple `(user_id, path, idempotency_key)` as unique.
* Correlation: send `X-Request-Id` header. Server returns `x-correlation-id` in all responses.
* Pagination: cursor based. Query params `cursor` and `limit` (default 20, max 100). Response includes `next_cursor` when more results exist.
* Time: all timestamps are ISO 8601 in UTC.
* Errors: consistent envelope shown below.

### Error envelope

```json
{
  "ok": false,
  "error": {
    "code": "string",
    "message": "human friendly message",
    "details": {"field": "reason"}
  },
  "correlation_id": "uuid"
}
```

### Success envelope

```json
{
  "ok": true,
  "data": { /* type specific */ },
  "correlation_id": "uuid"
}
```

---

## Shared types

```ts
// Tiers
export type Tier = "free" | "pro" | "vip";

// Coaches
export type CoachId =
  | "chase-krashen"
  | "claire-swales"
  | "carter-goleman"
  | "chelsea-lightbown"
  | "clark-atul"
  | "crystal-benner"
  | "christopher-buffett"
  | "colton-covey"
  | "cody-turing"
  | "chloe-sinek";

// Capabilities object read by the client
export interface Capabilities {
  tier: Tier;
  session_minutes_daily: number; // remaining minutes for today
  active_coaches: number; // allowed concurrent active coaches
  tools_allowed: string[]; // feature flags by tool
  library_filters: string[];
  coach_switch_cooldown_until: string | null; // ISO timestamp
}

// Cursor response helper
export interface Cursor<T> {
  items: T[];
  next_cursor?: string;
}
```

---

## Auth and user

### GET `/api/user/profile`

Returns the signed in user's profile.

**Response**

```json
{
  "ok": true,
  "data": {
    "user_id": "uuid",
    "email": "user@example.com",
    "name": "Lee",
    "tier": "free",
    "coach_id": "chelsea-lightbown" | null
  },
  "correlation_id": "uuid"
}
```

### PATCH `/api/user/profile`

Updates profile fields. All fields optional.

**Body**

```json
{ "name": "Lee", "coach_id": "carter-goleman", "goal": "IELTS Band 7" }
```

**Response** uses success envelope.

### GET `/api/user/capabilities`

Returns the server owned capabilities object.

**Response**

```json
{ "ok": true, "data": { "tier": "pro", "session_minutes_daily": 18, "active_coaches": 1, "tools_allowed": ["vocab", "paraphrase", "tts", "transcribe"], "library_filters": ["expressions", "practice"], "coach_switch_cooldown_until": null }, "correlation_id": "uuid" }
```

---

## Drills and sessions

### GET `/api/drills/list`

List drills with filters.

**Query**
`?coach_id=chelsea-lightbown&topic=speaking&difficulty=B2&cursor=abc&limit=20`

**Response**

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "drill_id": "uuid",
        "title": "IELTS Part 2: Describe a time you solved a problem",
        "coach_id": "chelsea-lightbown",
        "skill": "speaking",
        "difficulty": "B2",
        "runtime_sec": 600,
        "rubric_id": "ielts-speaking-b2"
      }
    ],
    "next_cursor": "def"
  },
  "correlation_id": "uuid"
}
```

### POST `/api/drills/start`

Start a session and reserve minute budget.

**Body**

```json
{ "drill_id": "uuid" }
```

**Response**

```json
{
  "ok": true,
  "data": {
    "session_id": "uuid",
    "started_at": "2025-01-01T00:00:00Z",
    "remaining_minutes_today": 9
  },
  "correlation_id": "uuid"
}
```

### POST `/api/drills/submit`

Submit a response and receive feedback and Expressions Pack.

**Body**

```json
{
  "session_id": "uuid",
  "answer": "<plain text or transcript>",
  "metadata": { "wpm": 110, "words": 180 }
}
```

**Response**

```json
{
  "ok": true,
  "data": {
    "wins": ["Clear structure" , "Good paraphrasing", "Natural linking"],
    "fixes": ["Pronunciation of th", "More precise hedging"],
    "next_prompt": "Try a 90 second summary about a recent news event",
    "pack": {
      "expressions": [
        { "text": "To put it another way", "notes": "paraphrase" },
        { "text": "One practical step is...", "notes": "signpost" }
      ],
      "pronunciation": [
        { "text": "through", "hint": "/θruː/" }
      ]
    }
  },
  "correlation_id": "uuid"
}
```

---

## Practice Pack

### GET `/api/practice-pack/weekly`

Fetch the current weekly pack for the user.

**Response**

```json
{
  "ok": true,
  "data": {
    "week_of": "2025-01-01",
    "drills": [ { "drill_id": "uuid", "title": "Two minute STAR sprint" } ],
    "vocab_review_count": 15,
    "reflection_prompt": "What worked and what will you change next week"
  },
  "correlation_id": "uuid"
}
```

---

## Search

### GET `/api/search/cards`

Card search for catalog discovery.

**Query**
`?q=IELTS%20Part%202&coach_id=chelsea-lightbown&cursor=abc`

**Response** uses cursor envelope with drill card items.

### GET `/api/search/sessions`

Search past sessions by date range or topic. Returns cursor envelope of session summaries.

---

## Chat

### POST `/api/chat`

Chat with a coach or helper model.

**Body**

```json
{
  "coach_id": "chelsea-lightbown",
  "messages": [
    { "role": "system", "content": "You are a kind IELTS coach" },
    { "role": "user", "content": "Give me a Part 2 card about teamwork" }
  ],
  "context": { "target_band": 7 }
}
```

**Response**

```json
{ "ok": true, "data": { "message": { "role": "assistant", "content": "Here is a Part 2 card..." } }, "correlation_id": "uuid" }
```

---

## Speech I O

### POST `/api/transcribe`

Accepts `multipart/form-data` with field `audio` (webm or wav). Returns a transcript.

**Response**

```json
{ "ok": true, "data": { "text": "transcribed text", "lang": "en" }, "correlation_id": "uuid" }
```

### POST `/api/tts`

Generate speech audio for given text.

**Body**

```json
{ "voice": "coach_default", "text": "Welcome back, Lee" }
```

**Response**

```json
{ "ok": true, "data": { "audio_url": "https://.../file.mp3", "duration_sec": 5.2 }, "correlation_id": "uuid" }
```

### POST `/api/realtime/token`

Mint a short lived token for Realtime.

**Response**

```json
{ "ok": true, "data": { "token": "string", "expires_at": "2025-01-01T00:10:00Z" }, "correlation_id": "uuid" }
```

---

## Uploads

### POST `/api/upload`

Returns a signed URL for direct upload to Supabase Storage.

**Body**

```json
{ "bucket": "user-media", "path": "sessions/uuid/audio.webm", "content_type": "audio/webm" }
```

**Response**

```json
{ "ok": true, "data": { "url": "https://...", "headers": { "Content-Type": "audio/webm" } }, "correlation_id": "uuid" }
```

---

## Payments and entitlements

Payment rails are provider agnostic. Supported providers are PayPal for global payments and PayMongo for the Philippines.

### POST `/api/pay/checkout`

Create a checkout session.

**Body**

```json
{ "plan_id": "pro", "provider": "paypal" | "paymongo", "return_url": "https://app.example.com/account" }
```

**Response**

```json
{ "ok": true, "data": { "session_id": "string", "redirect_url": "https://provider.example/checkout" }, "correlation_id": "uuid" }
```

### POST `/api/pay/portal`

Return a customer billing portal URL.

**Body**

```json
{ "provider": "paypal" | "paymongo" }
```

**Response**

```json
{ "ok": true, "data": { "portal_url": "https://provider.example/portal" }, "correlation_id": "uuid" }
```

### POST `/api/pay/webhooks/paypal`

Receives PayPal webhook events. Signature is verified before processing. Uses idempotency on provider `event_id`.

**Body**

```json
{ "id": "WH-123", "event_type": "PAYMENT.SALE.COMPLETED", "resource": { "custom_id": "user_uuid", "amount": { "total": "12.99", "currency": "USD" } } }
```

**Response**

```json
{ "ok": true, "data": { "handled": true }, "correlation_id": "uuid" }
```

### POST `/api/pay/webhooks/paymongo`

Receives PayMongo webhook events. Signature is verified before processing. Uses idempotency on provider `event_id`.

**Body**

```json
{ "id": "evt_123", "type": "payment.paid", "data": { "attributes": { "amount": 29900, "currency": "PHP", "metadata": { "user_id": "uuid" } } } }
```

**Response** uses success envelope.

### Unified internal event shape

The server normalizes provider payloads into one event type.

```ts
export interface NormalizedPaymentEvent {
  provider: "paypal" | "paymongo";
  event_id: string;
  type: "payment.succeeded" | "payment.failed" | "subscription.updated" | "subscription.canceled";
  occurred_at: string; // ISO timestamp
  customer_id: string; // internal user id
  plan_id: Tier;
  amount: number; // minor units
  currency: string; // ISO 4217
  raw: unknown; // original provider payload
}
```

### Entitlement write contract

On `payment.succeeded` the server performs a single transaction:

1. Upsert `payment_events` with idempotency on `provider,event_id`.
2. Upsert `entitlements` for the user and plan.
3. Append to `ledger` with before and after snapshots.

---

## Analytics contract

A small, typed set of product events. Emit only those defined here.

### Event envelope

```ts
export interface AnalyticsEvent<TName extends string, TProps extends object> {
  name: TName;            // example: "practice_submitted"
  user_id: string;        // uuid
  occurred_at: string;    // ISO timestamp
  props: TProps;          // typed per event
}
```

### Allowed events

```ts
export type AppEvents =
  | { name: "onboarding_completed"; props: { profession?: string; goal?: string } }
  | { name: "coach_selected"; props: { coach_id: CoachId } }
  | { name: "practice_started"; props: { drill_id: string; coach_id: CoachId } }
  | { name: "practice_submitted"; props: { session_id: string; words: number; wpm?: number; rubric_id: string } }
  | { name: "feedback_viewed"; props: { session_id: string } }
  | { name: "vocab_saved"; props: { pack_id: string; items: number } }
  | { name: "day_completed"; props: { drills_done: number; minutes_spoken: number } }
  | { name: "plan_upgraded"; props: { from: Tier; to: Tier; provider: "paypal" | "paymongo" } }
  | { name: "payment_status"; props: { status: "succeeded" | "failed"; provider: "paypal" | "paymongo" } }
  | { name: "coach_switched"; props: { from?: CoachId; to: CoachId } }
  | { name: "drill_opened"; props: { drill_id: string; coach_id: CoachId } };
```

Server writes every event with a correlation id and validates properties with Zod before insertion.

---

## Admin API (secured by admin guard)

### POST `/api/admin/drills/item-create`

Create a draft drill.

**Body**

```json
{ "title": "Bad news protocol role play", "coach_id": "clark-atul", "skill": "speaking", "difficulty": "C1", "rubric_id": "osce-speaking-c1", "content": { "prompt": "..." } }
```

### POST `/api/admin/drills/item-approve`

Approve a drill and publish to catalogs.

**Body**

```json
{ "drill_id": "uuid", "version_notes": "QA checks passed" }
```

### POST `/api/admin/messages`

Send an admin message to a user.

**Body**

```json
{ "to_user_id": "uuid", "subject": "Welcome", "text": "Glad you are here" }
```

### GET `/api/admin/metrics`

Returns high level metrics for dashboards.

**Response**

```json
{ "ok": true, "data": { "dau": 123, "new_paid": 7, "arpu": 4.12 }, "correlation_id": "uuid" }
```

---

## Rate limits

* Default: 60 requests per minute per user.
* Burst critical routes: `/api/transcribe` and `/api/tts` limited to 20 requests per minute.
* Headers returned: `x-rate-limit-limit`, `x-rate-limit-remaining`, `x-rate-limit-reset`.

---

## Validation with Zod

Every route validates input with Zod. Example schemas:

```ts
import { z } from "zod";

export const StartSessionSchema = z.object({
  drill_id: z.string().uuid()
});

export const SubmitSchema = z.object({
  session_id: z.string().uuid(),
  answer: z.string().min(1),
  metadata: z.object({ wpm: z.number().int().optional(), words: z.number().int().min(1) })
});

export const CheckoutSchema = z.object({
  plan_id: z.enum(["free", "pro", "vip"]),
  provider: z.enum(["paypal", "paymongo"]),
  return_url: z.string().url()
});
```

---

## Security notes

* All data access is enforced by Supabase RLS. Route handlers call Postgres through service RPCs that check row ownership.
* Medical and finance routes include a non dismissible disclaimer flag on the response. The client records a `disclaimer_viewed` event.
* File uploads are signed per request and validated for content type and max size.

---

## Changelog

* 0.1.0: Initial draft with drills, sessions, chat, speech I O, payments, analytics, admin, and shared envelopes.
