# Supabase Backups and Restore Strategy

Version: 0.1.0
Status: Draft ready for implementation
Scope: database, storage, auth, schedules, RPO/RTO targets, verification, and restore procedures for Polaris Coach

---

## Objectives

* Protect user data against loss, corruption, and accidental deletion.
* Meet business continuity targets with clear RPO and RTO.
* Keep backups encrypted, access controlled, and regularly verified.

---

## Targets

* **RPO**: 24 hours for database and storage objects. Tighter windows can be achieved with point in time options where available.
* **RTO**: 2 hours for partial restores, 6 hours for full environment rebuilds.

---

## Scope of backup

* **Postgres database**: all schemas, tables, views, functions, policies, and data.
* **Auth**: users, identities, policies, JWT settings. Included in database backup.
* **Storage**: Supabase Storage buckets `user-media` and `public-assets`.
* **Ops metadata**: `supabase_migrations.schema_migrations` and `app_version`.

---

## Schedules

Times shown in PHT and their UTC cron equivalents.

| Asset                        | Frequency         | Time PHT  | UTC cron      | Retention                    |
| ---------------------------- | ----------------- | --------- | ------------- | ---------------------------- |
| Database logical dump        | Daily             | 03:30     | `30 19 * * *` | 7 daily, 4 weekly, 3 monthly |
| Storage sync `user-media`    | Daily             | 04:00     | `0 20 * * *`  | 7 daily, 4 weekly, 3 monthly |
| Storage sync `public-assets` | Weekly            | Sun 04:30 | `30 20 * * 6` | 8 weekly                     |
| Schema snapshot              | On each migration | N A       | CI step       | 12 months                    |

Notes

* For Supabase managed backups, keep provider defaults enabled. This plan adds an extra logical dump and object sync for belt and suspenders.

---

## Storage locations

* Primary:

  * Database dumps: `s3://polaris-backups/db/{env}/{yyyy}/{mm}/{dd}/dump.sql.gz`
  * Checksums: `s3://polaris-backups/db/{env}/{yyyy}/{mm}/{dd}/dump.sha256`
  * Storage objects: `s3://polaris-backups/storage/{env}/{bucket}/YYYY/MM/DD/*`
* Access via an IAM role scoped to write only into the correct path. Reads are limited to restore operators.
* Server side encryption at rest. Keys managed by the cloud provider.

---

## Encryption and access control

* TLS in transit for all backup uploads and downloads.
* Server side encryption on buckets. Optional KMS keys if policy requires.
* Principle of least privilege: backup writer cannot delete historical snapshots.
* Credentials are injected via CI secrets and rotated quarterly.

---

## Automated database dump

Use pg_dump from a runner in the same region as Supabase to reduce latency.

```bash
# env: PGURL, S3_BUCKET, DATE
export DATE=$(date -u +%Y-%m-%d)
pg_dump --no-owner --format=custom "$PGURL" \
  | gzip -9 \
  | tee \
    >(sha256sum | awk '{print $1}' > dump.sha256) \
    > dump.sql.gz
aws s3 cp dump.sql.gz "$S3_BUCKET/db/$ENV/$DATE/dump.sql.gz"
aws s3 cp dump.sha256 "$S3_BUCKET/db/$ENV/$DATE/dump.sha256"
```

Schema snapshot for quick diffs

```bash
pg_dump -s "$PGURL" > schema_$DATE.sql
aws s3 cp schema_$DATE.sql "$S3_BUCKET/db/$ENV/$DATE/schema.sql"
```

---

## Automated storage sync

Mirror objects using list and range GET. For large buckets, sync in batches by prefix and date.

```bash
# Pseudo steps
# 1) List objects from Supabase Storage via signed URLs or service role API
# 2) Stream download and write to S3 with same path keys
# 3) Record manifest json with object count, total bytes, and run id
```

Tips

* Prefer incremental sync by using the `since` timestamp and only copying new or changed objects.
* Keep a `manifest.json` per run for verification.

---

## Verification

* After each backup, verify checksum and upload a `verification.json` that records sizes and row counts.
* Nightly canary restore into a temporary database to validate dumps.

Health checks on canary

```sql
select count(*) from profiles;
select count(*) from sessions;
select count(*) from entitlements;
select max(inserted_at) from supabase_migrations.schema_migrations;
```

Automated query to verify app_version

```sql
select version from app_version limit 1;
```

---

## Restore procedures

Link to the detailed steps in `runbook_restore.md`. This section summarizes common scenarios.

### 1) Accidental row deletion in a single table

* Create a temp database from the latest dump.
* Copy back the specific rows with `insert into ... select ... from dblink` or export to CSV and reimport.

### 2) Corruption or bad migration

* Stop writers by switching app into read only mode with a feature flag.
* Create a fresh database instance and restore from the most recent good dump.
* Reapply migrations up to the desired point.
* Validate, then flip the app to the restored database.

### 3) Storage object restore

* Read the manifest for the day in question.
* Copy required objects from `s3://polaris-backups/storage/...` back into Supabase Storage using service API.

### 4) Full environment rebuild

* Provision a new Supabase project.
* Restore database from the dump and run any environment specific patches.
* Sync storage from the latest snapshot.
* Update `.env` and rotate secrets.

---

## Data masking for staging refresh

Never copy raw PII into staging. Use a masking script after restore.

```sql
update profiles
set email = concat('user+', substr(md5(id::text), 1, 8), '@example.com'),
    full_name = 'Demo ' || substr(md5(id::text), 1, 4),
    phone = null;

update messages set content = '[redacted for staging]' where true;
```

Run app level scrubs for transcripts and uploads if any exist.

---

## Monitoring and alerts

* Emit `polaris_backup_success_total` and `polaris_backup_failure_total` with labels `{env, kind}`.
* Page if a scheduled backup fails twice in a row or if verification fails.
* Track backup sizes and duration to anticipate cost and performance issues.

---

## Testing the plan

* Quarterly: perform a full restore to a throwaway project and run smoke tests.
* Monthly: restore a single table from backup into a temp schema and validate row counts.
* Weekly: verify checksums and manifests.

---

## Cost controls

* Lifecycle rules on S3 to move monthly snapshots to infrequent access after 30 days and to cold after 90 days.
* Delete daily objects older than 30 days, keep weeklies for 6 months, monthlies for 12 months.

---

## Ownership and permissions

* Backup operator: creates and verifies backups.
* Restore operator: performs restores with change ticket.
* Security owner: reviews access and rotation quarterly.

---

## Open items

* Decide on point in time options and retention per plan with Supabase support if needed.
* Automate storage sync using a dedicated worker for performance.
* Add a redaction job for old transcripts in backups if future policy requires it.
