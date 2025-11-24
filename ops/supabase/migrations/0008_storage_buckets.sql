-- =====================================================================
-- 0008_storage_buckets.sql
-- Polaris Core: Supabase Storage buckets + helper + conditional policies
-- =====================================================================
-- This migration is idempotent and safe to re-run.
-- It will only touch RLS policies if the current role owns storage.objects.
-- =====================================================================

-- Ensure buckets exist --------------------------------------------------
insert into storage.buckets (id, name, public)
values
  ('public-assets', 'public-assets', true),
  ('user-media',    'user-media',    false),
  ('exports',       'exports',       false),
  ('temp-uploads',  'temp-uploads',  false)
on conflict (id) do update
  set name   = excluded.name,
      public = excluded.public;

-- Optional tuning if columns exist on your Storage version -------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage'
      and table_name   = 'buckets'
      and column_name  = 'file_size_limit'
  ) then
    update storage.buckets
       set file_size_limit = 26214400  -- 25 MB
     where id in ('public-assets','user-media','exports','temp-uploads')
       and (file_size_limit is distinct from 26214400 or file_size_limit is null);
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'storage'
      and table_name   = 'buckets'
      and column_name  = 'allowed_mime_types'
  ) then
    update storage.buckets
       set allowed_mime_types = array[
         'image/png','image/jpeg','image/webp','image/gif','image/svg+xml',
         'text/css','text/javascript','application/javascript','font/woff','font/woff2'
       ]
     where id = 'public-assets';

    update storage.buckets
       set allowed_mime_types = array[
         'image/png','image/jpeg','image/webp','image/gif','image/svg+xml',
         'application/pdf',
         'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'text/plain','audio/mpeg','audio/wav','video/mp4','audio/webm','video/webm'
       ]
     where id in ('user-media','temp-uploads');

    update storage.buckets
       set allowed_mime_types = array[
         'application/json','application/pdf','text/plain',
         'image/png','image/jpeg','image/webp'
       ]
     where id = 'exports';
  end if;
end;
$$ language plpgsql;

-- Helper to inspect key prefixes (kept in public to avoid storage perms)-
drop function if exists public.storage_folder(text);

create or replace function public.storage_folder(key text)
returns text
language sql
immutable
as $fn$
  select nullif(split_part(trim(both '/' from coalesce(key, '')), '/', 1), '');
$fn$;

comment on function public.storage_folder(text) is
  'Returns the first folder segment for a storage key, for example users/{user_id}.';

-- Conditionally manage RLS on storage.objects --------------------------
do $blk$
declare
  is_owner boolean := false;
begin
  -- Detect if current role owns storage.objects
  select c.relowner = (select usesysid from pg_user where usename = current_user)
    into is_owner
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects';

  if not is_owner then
    raise notice 'Skipping RLS changes on storage.objects because % is not the owner', current_user;
    return;
  end if;

  -- We are the owner. Apply RLS and policies.

  alter table storage.objects enable row level security;
  alter table storage.objects force  row level security;

  -- Drop our named policies if they exist
  drop policy if exists "public-assets read"          on storage.objects;
  drop policy if exists "public-assets insert admin"  on storage.objects;
  drop policy if exists "public-assets update admin"  on storage.objects;
  drop policy if exists "public-assets delete admin"  on storage.objects;

  drop policy if exists "user-media read own"         on storage.objects;
  drop policy if exists "user-media insert own"       on storage.objects;
  drop policy if exists "user-media update own"       on storage.objects;
  drop policy if exists "user-media delete own"       on storage.objects;

  drop policy if exists "exports read own"            on storage.objects;
  drop policy if exists "exports insert service"      on storage.objects;
  drop policy if exists "exports update service"      on storage.objects;
  drop policy if exists "exports delete service"      on storage.objects;

  drop policy if exists "temp-uploads read own"       on storage.objects;
  drop policy if exists "temp-uploads insert own"     on storage.objects;
  drop policy if exists "temp-uploads update own"     on storage.objects;
  drop policy if exists "temp-uploads delete own"     on storage.objects;

  -- Public assets: anyone can read; only service role or admins can mutate
  create policy "public-assets read"
    on storage.objects
    for select
    to public
    using (bucket_id = 'public-assets');

  create policy "public-assets insert admin"
    on storage.objects
    for insert
    with check (
      bucket_id = 'public-assets'
      and (auth.role() = 'service_role' or public.is_admin())
    );

  create policy "public-assets update admin"
    on storage.objects
    for update
    using (
      bucket_id = 'public-assets'
      and (auth.role() = 'service_role' or public.is_admin())
    )
    with check (
      bucket_id = 'public-assets'
      and (auth.role() = 'service_role' or public.is_admin())
    );

  create policy "public-assets delete admin"
    on storage.objects
    for delete
    using (
      bucket_id = 'public-assets'
      and (auth.role() = 'service_role' or public.is_admin())
    );

  -- User media: users/{auth.uid()}/...
  create policy "user-media read own"
    on storage.objects
    for select
    using (
      bucket_id = 'user-media'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );

  create policy "user-media insert own"
    on storage.objects
    for insert
    with check (
      bucket_id = 'user-media'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );

  create policy "user-media update own"
    on storage.objects
    for update
    using (
      bucket_id = 'user-media'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    )
    with check (
      bucket_id = 'user-media'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );

  create policy "user-media delete own"
    on storage.objects
    for delete
    using (
      bucket_id = 'user-media'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );

  -- Exports: service writes; users read only their own path
  create policy "exports read own"
    on storage.objects
    for select
    using (
      bucket_id = 'exports'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );

  create policy "exports insert service"
    on storage.objects
    for insert
    with check (
      bucket_id = 'exports'
      and auth.role() = 'service_role'
    );

  create policy "exports update service"
    on storage.objects
    for update
    using (
      bucket_id = 'exports'
      and auth.role() = 'service_role'
    )
    with check (
      bucket_id = 'exports'
      and auth.role() = 'service_role'
    );

  create policy "exports delete service"
    on storage.objects
    for delete
    using (
      bucket_id = 'exports'
      and auth.role() = 'service_role'
    );

  -- Temp uploads: user-scoped scratch
  create policy "temp-uploads read own"
    on storage.objects
    for select
    using (
      bucket_id = 'temp-uploads'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );

  create policy "temp-uploads insert own"
    on storage.objects
    for insert
    with check (
      bucket_id = 'temp-uploads'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );

  create policy "temp-uploads update own"
    on storage.objects
    for update
    using (
      bucket_id = 'temp-uploads'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    )
    with check (
      bucket_id = 'temp-uploads'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );

  create policy "temp-uploads delete own"
    on storage.objects
    for delete
    using (
      bucket_id = 'temp-uploads'
      and (
        auth.role() = 'service_role'
        or public.is_admin()
        or (auth.uid() is not null and name like ('users/' || auth.uid()::text || '/%'))
      )
    );
end;
$blk$ language plpgsql;
