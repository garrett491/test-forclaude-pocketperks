-- =====================================================================
-- Pocket Perks — 0005 Storage
--
-- One public bucket for merchant and deal imagery.
--
-- Why uploads instead of pasted image URLs: a pasted URL means the image
-- can vanish, can't be resized, can't be converted to WebP, and serves
-- from someone else's server at whatever size they happened to save it.
-- Three of the site's Core Web Vitals problems trace back to that single
-- field. Uploading costs the same admin effort and lets the pipeline
-- strip EXIF, cap dimensions and emit width/height for every <img>.
--
-- The size and MIME limits below are the last line of defence. The real
-- validation happens in the upload Netlify Function, which re-encodes the
-- image rather than trusting its declared type.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'merchant-media',
  'merchant-media',
  true,
  5242880,
  array['image/webp', 'image/jpeg', 'image/png', 'image/avif']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public read. These files are served on every page of the website, so
-- there is nothing to gain from signed URLs and a lot of caching to lose.
drop policy if exists merchant_media_public_read on storage.objects;
create policy merchant_media_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'merchant-media');

-- Only administrators can add, replace or remove assets.
drop policy if exists merchant_media_admin_insert on storage.objects;
create policy merchant_media_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'merchant-media' and public.is_admin());

drop policy if exists merchant_media_admin_update on storage.objects;
create policy merchant_media_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'merchant-media' and public.is_admin())
  with check (bucket_id = 'merchant-media' and public.is_admin());

drop policy if exists merchant_media_admin_delete on storage.objects;
create policy merchant_media_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'merchant-media' and public.is_admin());
