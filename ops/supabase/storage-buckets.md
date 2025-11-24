# Supabase Storage Buckets

Version: 0.1.0
Status: Draft ready for implementation
Scope: bucket layout, paths, CORS, policies, signed URLs, retention, and ops for Polaris Coach

---

## Buckets

Create these buckets in Supabase Storage.

| Bucket id       | Visibility  | Purpose                                                                    |
| --------------- | ----------- | -------------------------------------------------------------------------- |
| `public-assets` | public read | Coach images, OG images, static SVGs, public downloads                     |
| `user-media`    | private     | User audio uploads, generated audio, session artifacts                     |
| `exports`       | private     | On demand user exports (ZIP, CSV, JSON) served via short lived signed URLs |
| `temp-uploads`  | private     | One time uploads that will be moved or deleted by a worker within 24 hours |

Notes

* Keep the set small and stable. New features should try to reuse `user-media` or `exports` before adding more buckets.

---

## Path design

Use predictable keys for efficient listing and RLS.

```
public-assets/
  coach-assets/{coach-key}/avatar-256.webp
  coach-assets/{coach-key}/avatar-512.webp
  coach-assets/{coach-key}/hero-1600x900.webp
  coach-assets/{coach-key}/card-960x1200.webp
  coach-assets/{coach-key}/master-1600.png
  coach-assets/{coach-key}/og-1200x630.jpg
  og/*

user-media/
  users/{user_id}/sessions/{session_id}/audio/{ts}.webm
  users/{user_id}/sessions/{session_id}/tts/{clip_id}.mp3
  users/{user_id}/packs/{pack_id}/pronunciation/{item_id}.mp3
  users/{user_id}/uploads/{yyyy}/{mm}/{dd}/{uuid}.bin

exports/
  users/{user_id}/{yyyy}-{mm}-{dd}/export-{timestamp}.zip

temp-uploads/
  users/{user_id}/{uuid}.tmp
```

Naming rules

* `{user_id}` is the UUID from Supabase Auth. Never accept a user supplied id in the path.
* Use lowercase a to z, 0 to 9, dash, underscore, and dot.
* Keep extensions correct for proper `Content-Type`.

---

## CORS

Allow the web app origins to upload and fetch.

Example policy

```
Allowed origins: https://staging.your-domain.com, https://your-domain.com, http://localhost:3000
Allowed methods: GET, HEAD, PUT, POST, DELETE, OPTIONS
Allowed headers: authorization, apikey, content-type, x-upsert, range
Expose headers: content-length, content-range, content-type, etag
Max age: 86400
```

Keep a separate CORS list per environment.

---

## Cache and CDN

* `public-assets`: enable CDN. Set `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`. Bust via file name hashes when updating images.
* `user-media`: default `Cache-Control: private, max-age=0, no-store` unless a file is safe to cache for a short time (for example generated TTS). If cached, prefer `max-age=300` and require signed URLs.
* `exports` and `temp-uploads`: do not cache. Always private.

---

## Security and policies

Supabase enforces policies on `storage.objects`. Add policies per bucket.

### Helpers

```sql
create or replace function storage.folder(key text)
returns text language sql immutable as $$
  select split_part(key, '/', 1);
$$;
```

### Public assets

```sql
-- Read: allow everyone to read objects in public-assets
create policy "public read"
  on storage.objects for select
  to public
  using ( bucket_id = 'public-assets' );

-- Write: only service role or admins may write
create policy "public-assets write by admin"
  on storage.objects for insert to authenticated
  using ( is_admin(auth.uid()) and bucket_id = 'public-assets' )
  with check ( is_admin(auth.uid()) and bucket_id = 'public-assets' );

create policy "public-assets update by admin"
  on storage.objects for update to authenticated
  using ( is_admin(auth.uid()) and bucket_id = 'public-assets' )
  with check ( is_admin(auth.uid()) and bucket_id = 'public-assets' );
```

### User media

```sql
-- Read own via auth or signed URL
create policy "user-media read own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'user-media' and
    ( storage.folder(name) = 'users' and name like 'users/'||auth.uid()||'/%' )
  );

-- Insert under own prefix only
create policy "user-media insert own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'user-media' and
    ( storage.folder(name) = 'users' and name like 'users/'||auth.uid()||'/%' )
  );

-- Update or delete own only
create policy "user-media modify own"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'user-media' and
    name like 'users/'||auth.uid()||'/%'
  )
  with check (
    bucket_id = 'user-media' and
    name like 'users/'||auth.uid()||'/%'
  );

create policy "user-media delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'user-media' and
    name like 'users/'||auth.uid()||'/%'
  );
```

### Exports

```sql
-- Users may read their own export objects
create policy "exports read own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'exports' and
    name like 'users/'||auth.uid()||'/%'
  );

-- Only server code inserts exports using service role
-- No direct insert for regular users
```

### Temp uploads

```sql
-- Users can insert and read their own temp files
create policy "temp insert own"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'temp-uploads' and
    name like 'users/'||auth.uid()||'/%'
  );

create policy "temp read own"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'temp-uploads' and
    name like 'users/'||auth.uid()||'/%'
  );

create policy "temp delete own"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'temp-uploads' and
    name like 'users/'||auth.uid()||'/%'
  );
```

---

## Signed URLs

Use short expiries.

* Downloads: 10 minutes typical. Increase to 30 minutes for large exports.
* Uploads: 5 minutes. Use one time keys.

Example client code

```ts
// server: create a signed URL for a user export
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const path = `users/${userId}/${date}/export-${timestamp}.zip`;
const { data, error } = await supabase
  .storage.from('exports')
  .createSignedUrl(path, 60 * 30); // 30 minutes
```

---

## Validation and limits

* Allowed types for uploads: `audio/webm`, `audio/mpeg`, `audio/wav`, `image/webp`, `image/png`, `image/jpeg`, `application/zip`, `application/json`.
* Max size per file: 25 MB default. VIP may allow 50 MB for TTS downloads. Enforce in route handlers.
* Virus scanning: optional. If enabled via a worker, quarantine suspicious files under `temp-uploads/quarantine/*` and block access.

---

## Retention and lifecycle

* `temp-uploads`: delete after 24 hours via daily job.
* `exports`: delete after 14 days to control cost.
* `user-media`: follow privacy policy. Purge stale raw audio and temporary transcripts based on retention windows from product-core.
* `public-assets`: keep indefinitely. Replace in place with new file names to leverage CDN caching.

---

## Observability

* Emit analytics events on upload success and failure: `upload_started`, `upload_succeeded`, `upload_failed` with `{bucket, bytes, mime}`.
* Log storage errors with `correlation_id` and `bucket_id`.
* Track metrics: `polaris_storage_upload_failures_total{bucket}`, total bytes uploaded per day.

---

## Backups

* Database metadata and object references are in the DB dump.
* Object data is synced to S3 as described in `ops/supabase/backup.md`.
* Keep an index of the latest manifests for each bucket and day.

---

## Common errors and fixes

* 403 on upload: missing `apikey` header or CORS mismatch. Check Allowed origins and headers.
* 401 on signed URL: expired or wrong path. Regenerate with correct `users/{user_id}` prefix.
* Policy denied: ensure `name like 'users/'||auth.uid()||'/%'` is satisfied. Do not allow clients to set arbitrary prefixes.
* Wrong `Content-Type`: set correct type when uploading so browsers can play audio inline.

---

## PR checklist

* [ ] New bucket has policies for select, insert, update, delete
* [ ] CORS updated in all environments
* [ ] Cache headers set for new public files
* [ ] Backup sync updated if a new bucket was added
* [ ] Release notes updated
