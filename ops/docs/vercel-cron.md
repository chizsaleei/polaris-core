# Vercel Cron

Version: 0.1.0
Status: Draft ready for implementation
Scope: how Polaris schedules and runs time based jobs on Vercel

---

## Objectives

* Run time based jobs on a reliable schedule using Vercel Cron
* Keep runs idempotent, observable, and safe to retry
* Prevent overlap across environments and deploys

---

## Jobs in scope

* Weekly recap builder
* Reconciliation of payments and ledger
* Materialized views refresh
* Drip and transactional mail dispatch

You can add more jobs, but all must follow the same handler and locking rules.

---

## Timezone policy

* Schedules are defined in UTC because Vercel Cron evaluates in UTC
* Product times are communicated in Asia Manila (UTC+8) for Lee and users
* Use the table below to convert

| Purpose                  | Desired time PHT | UTC schedule   |
| ------------------------ | ---------------- | -------------- |
| Weekly recap build (Sun) | 07:00 Sunday PHT | `0 23 * * 6`   |
| Reconcile ledger daily   | 06:15 PHT        | `15 22 * * *`  |
| Refresh views            | every 30 minutes | `*/30 * * * *` |
| Drip dispatch            | every 5 minutes  | `*/5 * * * *`  |

Note: 07:00 PHT Sunday equals 23:00 UTC Saturday.

---

## vercel.json example

Place this at the project root that serves the HTTP cron endpoints. For Next.js App Router this can be the web project. If you host cron handlers in the core worker, put the file in that repo.

```json
{
  "crons": [
    { "path": "/api/cron/weekly-summary",   "schedule": "0 23 * * 6" },
    { "path": "/api/cron/reconcile-ledger", "schedule": "15 22 * * *" },
    { "path": "/api/cron/refresh-views",    "schedule": "*/30 * * * *" },
    { "path": "/api/cron/drip-dispatch",    "schedule": "*/5 * * * *" }
  ]
}
```

Guidelines

* Keep each job under the Serverless time limit. For long jobs, chunk the work and reschedule the remainder
* Use a dedicated API route per job

---

## Authentication and safety

Protect cron endpoints so they cannot be invoked by the public.

### Shared secret header

* Create `CRON_SECRET` in the environment
* Handlers require header `x-cron-secret: $CRON_SECRET`

```ts
// app/api/cron/_lib/auth.ts
export function assertCronAuth(req: Request) {
  const secret = process.env.CRON_SECRET;
  const got = req.headers.get("x-cron-secret");
  if (!secret || got !== secret) {
    return new Response("unauthorized", { status: 401 });
  }
  return null;
}
```

### Advisory lock to prevent overlap

Use a Postgres advisory lock to avoid concurrent execution within the same environment.

```sql
-- obtain lock for a job key
select pg_try_advisory_lock( hashtext('cron:weekly-summary') );
-- release after work completes
select pg_advisory_unlock( hashtext('cron:weekly-summary') );
```

In code, take the lock at the start and exit with 409 if already running.

---

## Handler shape

Example for Next.js App Router route handlers.

```ts
// app/api/cron/weekly-summary/route.ts
import { assertCronAuth } from "../_lib/auth";
import { db } from "@/lib/supabase/server";
import { withCorrelation } from "@/lib/logger";

export async function POST(req: Request) {
  if (process.env.VERCEL_ENV === "preview") {
    return new Response("disabled on preview", { status: 204 });
  }
  const unauthorized = assertCronAuth(req);
  if (unauthorized) return unauthorized;

  return withCorrelation("cron.weekly_summary", async (log, cid) => {
    const lock = await db.rpc("try_lock", { key: "cron:weekly-summary" });
    if (!lock?.data) return new Response("already running", { status: 409 });

    const started = Date.now();
    try {
      // 1. fetch due users
      // 2. build recap slices in chunks
      // 3. enqueue emails
      const count = await runWeeklyRecap();
      log.info({ event: "cron_success", kv: { count } });
      return Response.json({ ok: true, count });
    } catch (e) {
      log.error({ event: "cron_failed", kv: { error: String(e) } });
      return new Response("error", { status: 500 });
    } finally {
      await db.rpc("unlock", { key: "cron:weekly-summary" });
      log.info({ event: "cron_duration_ms", kv: { ms: Date.now() - started } });
    }
  });
}
```

RPC helpers for locking

```sql
create or replace function try_lock(key text) returns boolean language sql as $$
  select pg_try_advisory_lock( hashtext(key) );
$$;
create or replace function unlock(key text) returns boolean language sql as $$
  select pg_advisory_unlock( hashtext(key) );
$$;
```

---

## Retry and idempotency

* Always make work units idempotent. Use natural keys like `user_id + week_of` for weekly recap
* On partial failure, the next run should pick up remaining units
* If an external provider returns 5xx, back off and retry inside the run up to a short limit

---

## Observability

* Log `cron_started`, `cron_success`, `cron_failed`, and duration in ms
* Emit metrics like `polaris_job_duration_ms{job}` and `polaris_job_failures_total{job}`
* Attach `correlation_id` and `job` in every span

---

## Local testing

Use curl with the secret header.

```bash
curl -X POST \
  -H "x-cron-secret: $CRON_SECRET" \
  https://your-staging-domain.vercel.app/api/cron/weekly-summary
```

Use a tunnel in local development and point Vercel Cron to the tunnel URL for quick iteration if needed.

---

## Staging and production

* Cron entries exist in both staging and production projects, but the job code should no op in preview deployments
* Use different `CRON_SECRET` values per environment
* For migration rollouts, disable the cron in staging via `vercel.json` change until the schema is ready

---

## Failure modes and runbook

* 401 unauthorized: secret mismatch. Rotate the secret and redeploy
* 409 already running: lock held. Inspect previous logs. If a crash left the lock open, use a time based escape in the RPC
* 5xx errors: check downstream dependencies and retry policy

---

## Appendix: schedules you might want

* Every 15 minutes: `*/15 * * * *`
* Midnight PHT daily: `0 16 * * *` (16:00 UTC previous day)
* First day of month 08:00 PHT: `0 0 1 * *`

Keep a short comment near each entry that shows the equivalent PHT time to avoid confusion.
