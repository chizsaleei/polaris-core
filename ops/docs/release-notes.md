# Polaris Coach Release Notes

Version: 0.1.x series
Status: Living document
Scope: product, web, core service, schema, payments, and ops

---

## Policy

* Versioning uses Semantic Versioning: MAJOR.MINOR.PATCH
* `staging` branch maps to the staging environment. `main` maps to production
* Every release has a migration plan, rollback plan, smoke tests, and an upgrade guide
* Breaking changes require a MAJOR bump and a deprecation period with feature flags where possible

---

## Cadence

* Weekly minor releases while in 0.x
* Patch releases anytime for fixes and security
* Cut from `staging` after green CI, then tag and promote to `main`

---

## Artifacts per release

* Git tag: `vX.Y.Z`
* GitHub Release with notes and changelog sections
* Supabase migration numbers applied to staging then production
* Vercel deployment links for web and any core workers
* Checksums of built artifacts if applicable

---

## Changelog categories

Use these standard sections in every entry.

* Added
* Changed
* Fixed
* Removed
* Security
* Migrations
* Env vars
* API contracts
* UI and tokens
* Payments and entitlements
* Safety and compliance
* Observability and analytics
* Docs
* Known issues
* Upgrade guide
* Rollback plan
* Post release checks

---

## Release entry template

Copy and adapt.

```md
### vX.Y.Z  YYYY-MM-DD

**Added**
-

**Changed**
-

**Fixed**
-

**Removed**
-

**Security**
-

**Migrations**
- 00NN_description.sql

**Env vars**
- NEW_VAR: reason and scope
- CHANGED_VAR: migration note

**API contracts**
- endpoints and schema changes with links to ops/docs/api-contracts.md

**UI and tokens**
- token deltas and contrast verification result

**Payments and entitlements**
- provider changes, webhook shapes, ledger notes

**Safety and compliance**
- disclaimers, QA gates, policy updates

**Observability and analytics**
- new metrics, traces, events added to contract

**Docs**
- list of new or updated ops docs

**Known issues**
- workarounds and owners

**Upgrade guide**
1. Apply migrations to staging
2. Rotate keys if needed
3. Deploy web to staging and run smoke tests
4. Promote to production after sign off

**Rollback plan**
- `git revert` or redeploy previous tag `vX.Y.(Z-1)`
- database down migrations or compensating patches
- disable features via flags

**Post release checks**
- SLO burn rate, webhook success, recap job success, ledger diffs
```

---

## Current releases

### v0.1.0  2025-11-05

**Added**

* Product core spec and initial docs: product-core, api-contracts, prompts-guide, accessibility-tokens, observability, rls-tests
* Coaches catalog scaffolds for 10 coaches
* Practice engine loop with capabilities object design and server owned minute accounting
* Expressions Pack builder spec with spaced review ladder 1d, 3d, 7d, 14d
* Payments design for PayPal and PayMongo with unified entitlement flow and nightly reconciliation

**Changed**

* Standardized analytics event contract and envelopes

**Fixed**

* N A for first cut

**Removed**

* Adyen references removed from docs and migration plan

**Security**

* RLS golden rules defined and test plan authored
* Redaction rules for logs and webhooks

**Migrations**

* 0001 to 0026 baseline from existing schema
* 0027_paymongo_core.sql placeholder
* 0028_paypal_core.sql placeholder
* 0029_remove_adyen.sql to be applied only if 0022_adyen_core.sql was used earlier

**Env vars**

* PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID, PAYPAL_MODE
* PAYMONGO_PUBLIC_KEY, PAYMONGO_SECRET_KEY, PAYMONGO_WEBHOOK_SECRET
* BILLING_PROVIDER=paymongo,paypal
* OPENAI_API_KEY, RESEND_API_KEY or POSTMARK_API_TOKEN

**API contracts**

* `/api/pay/checkout`, `/api/pay/portal`, `/api/pay/webhooks/{paypal|paymongo}`
* `/api/drills/*`, `/api/chat`, `/api/practice-pack/weekly`, `/api/realtime/token`, `/api/upload`
* Error and success envelopes with `correlation_id`

**UI and tokens**

* Brand primitives and semantic tokens defined with WCAG AA rules and Tailwind mapping

**Payments and entitlements**

* Normalized provider event shape
* Idempotent grant path writes `payment_events`, `entitlements`, and `ledger`
* Reconciliation job design captured

**Safety and compliance**

* Non dismissible disclaimers for medical and finance
* Auto QA gates for public exemplars

**Observability and analytics**

* OTel SDK plan, collector pipeline example, metrics and SLOs
* Analytics events list for product loop

**Docs**

* New: `ops/docs/*.md` as listed above

**Known issues**

* Provider SDK stubs not yet implemented in code
* Migrations 0027 to 0029 are placeholders until code lands

**Upgrade guide**

1. Create or update `.env.local` with PayPal and PayMongo test keys in staging
2. Apply migrations up to 0029 in staging
3. Deploy web to staging and verify `/api/pay/webhooks` receives test events via tunnel
4. Run RLS tests script and ensure all pass
5. Promote to production only after payment test grants an entitlement and writes a ledger row

**Rollback plan**

* If payments fail, disable provider in `BILLING_PROVIDER` and revert to previous tag
* If migrations 0027 to 0029 cause issues and are empty placeholders, revert tags only
* Use feature flags to disable Payments UI

**Post release checks**

* `polaris_webhook_verify_failures_total` stays near zero in staging
* First paid test produces `payment_events` and `entitlements` rows and a `recon_diff_applied` log is zero
* Weekly recap job runs at least once in staging

---

## Database migration map

| Number | File                           | Purpose                               | Reversible  |
| ------ | ------------------------------ | ------------------------------------- | ----------- |
| 0001   | 0001_init.sql                  | base schema                           | yes         |
| 0018   | 0018_entitlements.sql          | entitlements                          | yes         |
| 0020   | 0020_payments_events.sql       | payments events                       | yes         |
| 0024   | 0024_coach_switch_cooldown.sql | cooldown timestamp                    | yes         |
| 0025   | 0025_expressions_pack.sql      | expressions tables                    | yes         |
| 0026   | 0026_weekly_recap_views.sql    | recap views                           | yes         |
| 0027   | 0027_paymongo_core.sql         | provider enums and tables placeholder | yes         |
| 0028   | 0028_paypal_core.sql           | provider enums and tables placeholder | yes         |
| 0029   | 0029_remove_adyen.sql          | remove adyen artifacts if present     | conditional |

Keep this table in sync with `ops/supabase/migrations`.

---

## Smoke tests

Run on staging after deploy.

* Auth login and profile fetch
* Start and submit a drill, receive feedback and a pack
* View weekly practice pack
* Start checkout with provider sandbox and follow redirect
* Send a fake webhook with valid signature and observe entitlement grant
* Upload a small audio file to Storage using signed URL

---

## Rollback procedure

* Revert web to previous stable tag in Vercel
* If a migration broke reads, apply down migration only if safe, otherwise deploy a hotfix migration that restores views
* Disable features with flags and set `BILLING_PROVIDER` to a safe subset
* Announce rollback in internal channel and create a postmortem ticket

---

## Communication templates

**Internal release note**

```
Release vX.Y.Z is live on staging.
- Key change: ...
- Migrations: ...
- Flags: ...
- Smoke tests: all green
- Next step: promote to production at HH:MM PHT
```

**User facing snippet**

```
What is new in Polaris Coach vX.Y.Z
- New drills and better feedback cards
- Improved payments reliability for PayPal and PayMongo
- Accessibility and performance improvements
```

---

## Tooling

* Use GitHub Release Notes generator with the template above
* Use `supabase migration list` to verify applied versions
* Tag command: `git tag vX.Y.Z && git push origin vX.Y.Z`
* Capture deployment notes in the GitHub Release and link Vercel preview and production URLs

---

## Appendices

### Track schema version in DB

```sql
create table if not exists app_version(
  id boolean primary key default true,
  version text not null,
  released_at timestamptz not null default now()
);
insert into app_version(id, version) values(true, '0.1.0')
on conflict (id) do update set version = excluded.version, released_at = now();
```

### Verify migrations applied

```sql
select version, name, inserted_at from supabase_migrations.schema_migrations order by inserted_at desc limit 20;
```

### Production sign off checklist

* [ ] Migrations applied on production
* [ ] Web deployed and healthy
* [ ] Payments webhook verified on production keys
* [ ] SLO dashboards green
* [ ] Runbooks linked from alerts
