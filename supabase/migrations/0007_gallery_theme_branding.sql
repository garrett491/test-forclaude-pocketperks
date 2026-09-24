-- =====================================================================
-- Pocket Perks — 0007 Gallery, theme, branding
--
-- Additive. Nothing is dropped, no data is lost, safe to run twice.
-- Run after 0001–0006.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Merchant photo gallery
--
-- Photos are uploaded during onboarding rather than scraped from a
-- merchant's website or Facebook page. Scraping republishes images we have
-- no rights to, breaks whenever their layout changes, and produces
-- inconsistent, badly cropped, often years-out-of-date results. Asking for
-- four photos when you sign a business costs one line in the conversation
-- and produces a page that looks better than the one they already have.
-- ---------------------------------------------------------------------

create table if not exists public.merchant_gallery (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  media_id    uuid not null references public.media (id) on delete cascade,
  caption     text,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),

  constraint gallery_caption_len check (caption is null or length(caption) <= 160),
  constraint gallery_unique_photo unique (merchant_id, media_id)
);

create index if not exists gallery_merchant_idx
  on public.merchant_gallery (merchant_id, sort_order);

-- Gallery size is a plan entitlement, enforced here so the sold product and
-- the delivered product cannot drift apart the way the deal limits did.
create or replace function public.gallery_limit_for_tier(t public.merchant_tier)
returns integer
language sql
immutable
as $$
  select case t when 'standard' then 1 when 'pro' then 3 when 'premium' then 9 end;
$$;

create or replace function public.enforce_gallery_tier_limit()
returns trigger
language plpgsql
as $$
declare
  m_tier public.merchant_tier;
  m_name text;
  existing integer;
  cap integer;
begin
  select tier, name into m_tier, m_name from public.merchants where id = new.merchant_id;
  cap := public.gallery_limit_for_tier(m_tier);

  select count(*) into existing
  from public.merchant_gallery g
  where g.merchant_id = new.merchant_id and g.id is distinct from new.id;

  if existing + 1 > cap then
    raise exception
      '% is on the % plan, which includes % gallery photo(s). Remove one, or upgrade the plan.',
      m_name, m_tier, cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists gallery_tier_limit on public.merchant_gallery;
create trigger gallery_tier_limit
  before insert or update on public.merchant_gallery
  for each row execute function public.enforce_gallery_tier_limit();

alter table public.merchant_gallery enable row level security;

grant select on public.merchant_gallery to anon, authenticated;
grant insert, update, delete on public.merchant_gallery to authenticated;

drop policy if exists gallery_public_read on public.merchant_gallery;
create policy gallery_public_read on public.merchant_gallery
  for select to anon, authenticated
  using (
    public.is_admin() or exists (
      select 1 from public.merchants m
      where m.id = merchant_gallery.merchant_id and m.status = 'active'
    )
  );

drop policy if exists gallery_admin_write on public.merchant_gallery;
create policy gallery_admin_write on public.merchant_gallery
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop trigger if exists write_audit on public.merchant_gallery;
create trigger write_audit
  after insert or update or delete on public.merchant_gallery
  for each row execute function public.write_audit();

-- ---------------------------------------------------------------------
-- 2. Branding slots
--
-- The logo lived in public/ as a static file, which meant changing it
-- required opening the source — exactly what this build exists to avoid.
-- These hold media ids; the site falls back to the bundled SVGs when a slot
-- is empty, so nothing breaks before anything is uploaded.
-- ---------------------------------------------------------------------

insert into public.site_settings (key, value, label, description, is_public, is_system) values
  ('branding.logo_media_id', '""'::jsonb, 'Header logo',
   'Shown top-left on every page and on the admin sign-in. A wide image works best.', true, true),
  ('branding.footer_mark_media_id', '""'::jsonb, 'Footer mark',
   'The small mark in the dark footer. A square image that reads well on dark green.', true, true),
  ('branding.favicon_media_id', '""'::jsonb, 'Browser tab icon',
   'Square. Keep it simple — it renders about 16 pixels wide.', true, true),
  ('branding.og_image_media_id', '""'::jsonb, 'Link preview image',
   'Shown when a link is shared to Facebook. 1200 by 630 pixels.', true, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 3. Theme
--
-- One JSON object rather than a column per token, so adding a control later
-- is an admin change rather than a migration. Empty means "use the palette
-- derived from the logo", which is also what Reset writes back.
-- ---------------------------------------------------------------------

insert into public.site_settings (key, value, label, description, is_public, is_system)
select 'theme.tokens', '{}'::jsonb, 'Colours, fonts and sizes',
  'Set from the Design page. Empty means the default Pocket Perks look.', true, true
where not exists (select 1 from public.site_settings where key = 'theme.tokens');

-- ---------------------------------------------------------------------
-- 4. Malvern
--
-- A second town, so the location picker and the per-town carousel have
-- something to actually do. Deactivate or rename it from the admin if you
-- do not want it live yet.
-- ---------------------------------------------------------------------

insert into public.towns (slug, name, state_code, latitude, longitude, sort_order, is_active, seo_title, seo_description)
select 'malvern', 'Malvern', 'OH', 40.691700, -81.180600, 20, true,
  'Local Deals in Malvern, Ohio',
  'Current coupons, discounts and offers from businesses around Malvern, Ohio. Free to use, updated as merchants add them.'
where not exists (select 1 from public.towns where slug = 'malvern');
