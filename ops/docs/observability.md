# Observability

Version: 0.1.0
Status: Draft ready for implementation
Scope: logs, metrics, traces, dashboards, alerts, and runbooks for Polaris Coach

---

## Objectives

* See the health of web and core at a glance.
* Trace a single learner journey across UI, API, jobs, and webhooks with one correlation id.
* Detect regressions within minutes and page the right owner.
* Keep PII safe by design. Redact or hash before export.

---

## Architecture

* Instrument everything with OpenTelemetry SDKs. Export over OTLP to your collector.
* Collector routes traces and metrics to your backend of choice. Examples: Grafana Cloud (Tempo, Loki, Mimir), Better Stack, Axiom, Elastic, Datadog, Honeycomb. Pick one per environment.
* Structured application logs are the source of truth for debugging and audits. Analytics events live in Supabase and are not a substitute for logs.

```
Browser -> Next.js routes -> Core service -> Supabase
         ^         |              |           |
         |         v              v           v
      RUM events  Traces      Traces      DB metrics
                     |           |             |
                   Collector ------------- Exporters
```

---

## Naming and tagging

* Service name: `polaris-web` for Next.js, `polaris-core` for the worker or API service.
* Environment tag: `local`, `staging`, `production`.
* Version tag: semver string from `NEXT_PUBLIC_APP_VERSION`.
* Every log, span, and metric includes `correlation_id` and `user_id_hash` when available.

---

## Correlation id

* Header in: `X-Request-Id`. If missing, generate a UUID v4 at the edge.
* Return `x-correlation-id` on every response.
* Pass the id to downstream calls, jobs, and webhooks.
* Include the id in emails and admin messages as a short footer token for support.

---

## Structured logging

Use a small JSON schema everywhere. Never log raw provider errors without redaction.

**Log envelope**

```json
{
  "ts": "2025-01-01T12:00:00.000Z",
  "level": "info",
  "service": "polaris-core",
  "env": "staging",
  "version": "0.1.0",
  "correlation_id": "2c3c...",
  "user_id_hash": "u_ab12",
  "event": "payment_granted",
  "msg": "Entitlement updated",
  "kv": { "plan": "pro", "provider": "paypal", "minutes_delta": 30 }
}
```

**Levels**

* `debug` for noisy internals, off in production.
* `info` for normal lifecycle events.
* `warn` for retries, slow paths, degraded dependencies.
* `error` for failed operations that the system recovered from.
* `fatal` for process terminating failures.

**Do not log**

* Access tokens, webhook secrets, provider credentials, raw PII. Hash `user_id` into `user_id_hash`.

---

## Redaction rules

* Emails to `email_hash` using SHA256 with a static pepper per environment.
* Strip payment PANs and CVVs. Keep only last 4 and brand if provided by the provider.
* Audio transcripts are never logged. Summaries can be logged at info with 0 to 1 sentence if needed.

---

## Tracing

* Create a root span per incoming request. Name format: `HTTP GET /api/drills/list`.
* Child spans for DB, cache, storage, provider calls, and model calls.
* Always attach `correlation_id`, `user_id_hash`, `coach_id`, and `rubric_id` as span attributes when available.
* Record key events as span logs: `attempt_started`, `attempt_submitted`, `pack_saved`.

**Node SDK init**

```ts
// web/src/lib/otel.ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { Resource } from "@opentelemetry/resources";
import { SemanticResourceAttributes as SRA } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export function initOtel(serviceName: string) {
  const sdk = new NodeSDK({
    resource: new Resource({ [SRA.SERVICE_NAME]: serviceName }),
    traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT })
  });
  sdk.start();
  return sdk;
}
```

---

## Collector pipeline example

```yaml
receivers:
  otlp:
    protocols:
      http:
exporters:
  otlphttp:
    endpoint: ${OTLP_BACKEND}
  loki:
    endpoint: ${LOKI_ENDPOINT}
    labels:
      service: attributes[service.name]
      env: resource[deployment.environment]
  prometheusremotewrite:
    endpoint: ${PROM_ENDPOINT}
processors:
  batch: {}
  transform/logs:
    log_statements:
      - context: log
        statements:
          - set(attributes.msg, body)
          - delete_key(body)
service:
  pipelines:
    traces: { receivers: [otlp], processors: [batch], exporters: [otlphttp] }
    logs:   { receivers: [otlp], processors: [transform/logs, batch], exporters: [loki] }
    metrics:{ receivers: [otlp], processors: [batch], exporters: [prometheusremotewrite] }
```

---

## Key metrics

Prefix all names with `polaris`.

**API**

* `polaris_http_requests_total{route,method,status}`
* `polaris_http_duration_ms_bucket{route,method}` histogram, track p50, p95, p99
* `polaris_http_errors_total{route}`

**Jobs**

* `polaris_job_duration_ms{job}`
* `polaris_job_failures_total{job}`

**Payments**

* `polaris_payments_events_total{provider,type}`
* `polaris_entitlements_grants_total{plan}`
* `polaris_webhook_verify_failures_total{provider}`

**Practice engine**

* `polaris_attempts_started_total{coach,skill}`
* `polaris_attempts_submitted_total{coach,skill}`
* `polaris_pack_items_created_total{kind}`
* `polaris_minutes_consumed_total{tier}`

**Errors**

* `polaris_model_call_failures_total{task}`
* `polaris_storage_upload_failures_total{bucket}`

---

## Service level objectives

* Availability: 99.9 percent for authenticated API in production.
* Latency: p95 below 400 ms for `GET /api/drills/list` and below 800 ms for `POST /api/drills/submit` excluding model time.
* Error rate: below 0.5 percent 5 min rolling average per route.

**Error budget policy**

* If any SLO burns more than 30 percent of the monthly budget, freeze feature releases and focus on reliability until back under budget.

---

## Alerting

* Use multi window, multi burn rate for SLOs. Page when 2 percent of budget will be exhausted within 1 hour. Ticket when 2 percent within 6 hours.
* Page on the following single signals:

  * Webhook verification failures above 1 per minute for 5 minutes.
  * Queue depth for reconciliation jobs above 100 for 10 minutes.
  * Model call failure rate above 5 percent for 5 minutes.

**Sample Prometheus rule**

```yaml
- alert: HighErrorRate
  expr: sum(rate(polaris_http_errors_total[5m]))
        /
        sum(rate(polaris_http_requests_total[5m])) > 0.02
  for: 5m
  labels:
    severity: page
  annotations:
    summary: High API error rate
    runbook_url: https://internal/runbooks/api-errors
```

---

## Dashboards

Create a standard set per environment.

* API overview: traffic, latency heatmap, error rates by route, top slow routes, top error messages.
* Payments: events by type, success vs failure, webhook verify failures, grants over time, ledger diffs.
* Practice engine: attempts started and submitted, pack items created, minutes consumed, success rate of recap job.
* Jobs and cron: durations, failures, queue depth.
* Traces: top spans by latency, provider call breakdown.

---

## Payment and webhook observability

* Log `webhook_received`, `webhook_verified`, `webhook_duplicate_ignored`, `webhook_failed`.
* Store provider `event_id`, normalized `type`, and `occurred_at` in the log kv.
* Add a reconciliation log `recon_diff_applied` with a diff summary.

---

## Speech I O observability

* Count uploads and transcribe calls. Sample latency and size.
* Redact filenames and any transcript text.
* Expose an internal metric `polaris_transcribe_duration_ms` and `polaris_tts_duration_ms`.

---

## Supabase and SQL visibility

* Log RPC names and durations with row counts. Example event: `rpc.finish_session duration_ms=42 rows=1`.
* Enable Postgres statement logging at a safe level in staging only.

---

## Client side signals

* Real user monitoring: basic route change timings, soft nav errors, Web Vitals (LCP, FID/INP, CLS, TTFB).
* Send a minimal beacon with `correlation_id` and `route` to the collector.

---

## Privacy and compliance

* Data classes: Public, Internal, Confidential, Restricted. Logs are Internal by default.
* PII minimization: log ids and hashes, not raw values.
* Retention: production logs 30 days hot, 365 days cold. Staging 14 days. Local 7 days.
* Access control: read access granted by role. Payment logs limited to a smaller group.

---

## Runbooks

Create short runbooks in `ops/docs/runbooks/*` and link them from alerts.

* API error spikes
* Webhook verify failures
* Reconciliation backlog
* Model provider outage
* Storage outage

Each runbook includes: triage checklist, owner, escalation ladder, rollback or kill switch, and verification steps.

---

## Local and staging

* Enable debug logs and full traces in local.
* In staging, enable sampling at 20 percent for traces and 100 percent for errors.
* Use fake providers and test keys. Never export real PII from staging.

---

## Sampling and cost

* Sample traces at 10 percent in production. Always sample when status is error or latency above route p95.
* Keep logs at info for normal paths. Switch to debug by feature flag for short windows.

---

## Health endpoints

* `/api/health` returns 200 with build info and dependency checks for Supabase, storage, and provider reachability.
* Expose `/metrics` on the core service for Prometheus scraping in staging and production.

---

## Checks before merge

* Correlation id is set and returned on all routes.
* No PII is logged in any new code path.
* New spans include attributes for coach, rubric, and plan where relevant.
* New jobs emit start, success, and failure logs with durations.
* Alert rules updated if new SLO sensitive routes are added.

---

## References

* OpenTelemetry Specification
* Prometheus Instrumentation Guidelines
* WCAG for error messaging and color contrast in charts
