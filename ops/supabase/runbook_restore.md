# Supabase Restore Runbook

Version: 0.1.0
Status: Draft ready for incident use
Scope: database and storage restore for Polaris Coach across local, staging, and production

---

## Purpose

Provide a clear, repeatable procedure to restore Supabase Postgres and Storage after data loss, corruption, or a failed migration while meeting RPO and RTO targets defined in `backup.md`.

---

## Incident types

1. Single table row loss or accidental delete.
2. Bad migration or corrupted schema that breaks reads or writes.
3. Storage object loss or corruption.
4. Full environment compromise that requires new projects and secret rotation.

Each path below starts with common triage steps, then branches.

---

## Golden rules

* Freeze writes first. Protect users from further loss while you assess.
* Prefer restoring into a fresh project over in place if integrity is uncertain.
* Keep all work idempotent. You may retry steps without causing duplication.
* Never copy raw PII from production into staging. Mask before use.

---

## Preconditions and inputs

* Latest verified DB dump and checksum from `s3://polaris-backups/db/{env}/YYYY/MM/DD/`.
* Latest storage manifests from `s3://polaris-backups/storage/{env}/{bucket}/YYYY/MM/DD/`.
* Access to CI secrets and cloud IAM role that can read the backup bucket.
* Supabase Admin access for target environment.

---

## Common triage

1. Declare incident: owner, severity, target RPO and RTO.
2. Freeze writes in the web and core services:

   * Set a feature flag to read only mode.
   * Temporarily clear `BILLING_PROVIDER` to stop live payment grants.
   * Disable Vercel cron by removing or commenting crons in `vercel.json` and redeploy staging if needed.
3. Pause external webhooks at providers or point them to a 410 endpoint until restore completes.
4. Capture evidence: current error rates, last good deployment tag, last applied migration number.

---

## Decide the path

* If only a few rows are missing and you know the keys, use Path A.
* If schema or policies broke, use Path B.
* If files are missing, use Path C.
* If credentials are suspected compromised or data is widely corrupted, use Path D.

---

## Path A: restore specific rows from dump

1. Provision a temporary database named `polaris_temp_restore` in the same region.
2. Load the latest dump for the environment into the temp database.

   ```bash
   export DATE=YYYY-MM-DD
   aws s3 cp s3://polaris-backups/db/$ENV/$DATE/dump.sql.gz .
   gunzip -c dump.sql.gz | psql "$PGURL_TEMP"
   ```
3. Compare and extract rows by key into CSV.

   ```bash
   psql "$PGURL_TEMP" -c "copy (select * from entitlements where user_id in ('<uuid1>','<uuid2>')) to stdout csv header" > entitlements_fix.csv
   ```
4. In the live database, upsert the missing rows inside a transaction.

   ```sql
   begin;
   create temp table t_entitlements as select * from entitlements with no data;
   \copy t_entitlements from 'entitlements_fix.csv' csv header;
   insert into entitlements as e select * from t_entitlements
   on conflict (user_id) do update set
     plan = excluded.plan,
     active = excluded.active,
     updated_at = now();
   drop table t_entitlements;
   commit;
   ```
5. Verify with targeted queries and application smoke tests.
6. Unfreeze writes and close Path A, then go to Post restore actions.

---

## Path B: bad migration or schema corruption

1. Create a fresh Supabase project for the environment or a new database instance if available.
2. Restore the latest good dump.

   ```bash
   export DATE=YYYY-MM-DD
   aws s3 cp s3://polaris-backups/db/$ENV/$DATE/dump.sql.gz .
   gunzip -c dump.sql.gz | psql "$PGURL_NEW"
   ```

   If the dump is in custom format:

   ```bash
   gunzip -c dump.sql.gz > dump.custom
   pg_restore -d "$PGURL_NEW" -c -j 4 --no-owner dump.custom
   ```
3. Verify extensions, RLS, and helper functions exist.

   ```sql
   select extname from pg_extension order by 1;
   select count(*) from pg_policies;
   ```
4. Determine last applied migration in the dump.

   ```sql
   select max(version) from supabase_migrations.schema_migrations;
   ```
5. Apply any outstanding migrations up to the desired version.

   ```bash
   psql "$PGURL_NEW" -f ops/supabase/migrations/00NN_some_change.sql
   ```
6. Point the web and core services to `$PGURL_NEW` by updating `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the environment. Rotate `SUPABASE_JWT_SECRET`.
7. Run RLS tests from `ops/docs/rls-tests.md` against the new database.
8. Run application smoke tests. If green, proceed to Post restore actions.

---

## Path C: storage object restore

1. Identify bucket and date range from the incident report.
2. Fetch the manifest for that day from the backup bucket.
3. For each missing object, copy from S3 back to Supabase Storage using the service role client.

   ```ts
   // pseudo code
   for (const obj of manifest.objects) {
     const body = await s3.getObject({Bucket, Key: obj.key}).createReadStream()
     await supabase.storage.from(obj.bucket).upload(obj.key, body, { upsert: true, contentType: obj.contentType })
   }
   ```
4. Rebuild any signed URLs or cache entries if needed.
5. Verify playback or download from the app.

---

## Path D: full rebuild with secret rotation

1. Create brand new Supabase projects: `polaris-staging` or `polaris-prod` replacement.
2. Restore DB from latest dump as in Path B.
3. Sync Storage from latest snapshot for all buckets.
4. Rotate all secrets:

   * `SUPABASE_JWT_SECRET`
   * `SUPABASE_SERVICE_ROLE_KEY`
   * Email provider keys
   * Payment webhook secrets and webhook endpoints
   * CRON_SECRET
5. Update provider webhook URLs to the new domain or project endpoints. Send test events from PayPal and PayMongo sandboxes.
6. Deploy web and any workers with new environment variables to Vercel staging. After sign off, promote to production.

---

## Post restore actions

1. Re-enable Vercel cron and background jobs.
2. Re-enable payments by restoring `BILLING_PROVIDER` and verifying webhook signatures.
3. Run the nightly reconciliation job manually once to heal any gaps.
4. Run the weekly recap job once in staging to confirm success path.
5. Monitor SLO dashboards for at least 2 hours.
6. Write a short post incident summary and open follow up tasks.

---

## Validation checklist

* [ ] Auth login works and profiles load.
* [ ] Start and submit a drill, receive feedback and a pack.
* [ ] View weekly practice pack without errors.
* [ ] Upload and fetch a small audio file via signed URL.
* [ ] Payment sandbox webhook grants an entitlement and writes a ledger row.
* [ ] RLS tests pass on staging.

---

## Data masking for staging refresh

If you must restore production dump into staging:

```sql
update profiles
set email = concat('user+', substr(md5(id::text), 1, 8), '@example.com'),
    full_name = 'Demo ' || substr(md5(id::text), 1, 4),
    phone = null;
update messages set content = '[redacted for staging]' where true;
```

Also scrub transcripts and private uploads according to privacy policy.

---

## Rollback from a bad restore

1. If the new environment fails validation, switch DNS or Vercel project back to previous tag.
2. Keep the restored database online for forensics.
3. File a postmortem ticket with timeline, decisions, and metrics.

---

## Commands reference

* List latest backups:

  ```bash
  aws s3 ls s3://polaris-backups/db/$ENV/ --recursive | tail -n 20
  ```
* Fast schema only restore for inspection:

  ```bash
  gunzip -c dump.sql.gz | pg_restore -s -d "$PGURL_NEW"
  ```
* Verify dump integrity:

  ```bash
  sha256sum -c dump.sha256
  ```

---

## Communication templates

**Internal update**

```
Incident: DB restore for $ENV
Window: 14:00 to 16:00 PHT
Action: Freeze writes, restore from $DATE dump, validate, reenable jobs
Risks: temporary read only mode, delayed recaps
Owner: <name>, Backup: <name>
```

**User facing snippet**

```
We performed a maintenance restore to improve reliability. Your data and access remain safe. If you notice anything unusual, please contact support with the time and your email.
```

---

## Links

* `ops/supabase/backup.md` for schedules and verification
* `ops/docs/rls-tests.md` for policy verification
* `ops/docs/vercel-cron.md` for jobs and locking
