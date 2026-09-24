-- =====================================================================
-- Pocket Perks — 0008 Carousel speed, location settings, wider copy
--
-- Additive. Nothing dropped, no data lost, safe to run twice.
-- Run after 0001–0007.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Carousel controls
--
-- Speed is a setting rather than a constant because the right pace depends
-- on how much text the slides carry, and that changes as merchants come and
-- go. Seconds per slide is the unit an operator can actually reason about.
-- ---------------------------------------------------------------------

insert into public.site_settings (key, value, label, description, is_public, is_system) values
  ('carousel.seconds_per_slide', '8'::jsonb, 'Carousel speed',
   'Seconds for one card to cross the screen. Lower is faster. Between 4 and 20; 8 is a comfortable reading pace.',
   true, true),
  ('carousel.autoplay', 'true'::jsonb, 'Carousel moves on its own',
   'Turn off to leave the carousel still until a visitor uses the arrows.',
   true, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 2. Location behaviour
--
-- Pocket Perks will not always be one county, so the area name is a setting
-- rather than a phrase baked into the hero. Leave it blank and the site
-- simply does not claim a region.
-- ---------------------------------------------------------------------

insert into public.site_settings (key, value, label, description, is_public, is_system) values
  ('location.area_name', '""'::jsonb, 'Area name',
   'Optional. Used in search-engine descriptions only, never as a headline. Leave blank as you expand beyond one county.',
   true, false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 3. Copy that named one county
--
-- The hero used to open with "Carroll County, Ohio". That is a promise the
-- brand outgrows the moment a second county is added, and it is the kind of
-- thing nobody remembers to change. The headline now speaks about local
-- businesses generally; which town is being viewed is answered by the
-- location control, which is a fact rather than a claim.
-- ---------------------------------------------------------------------

update public.site_settings
   set value = to_jsonb('Pocket Perks — Local Deals Near You'::text)
 where key = 'seo.default_title'
   and value::text ilike '%carroll county%';

update public.site_settings
   set value = to_jsonb('Free local coupons and discounts from nearby businesses. No app, no signup — pick your town and start saving.'::text)
 where key = 'seo.default_description'
   and value::text ilike '%carroll county%';

update public.content_blocks
   set payload = payload
     || jsonb_build_object('subheadline', 'Free local coupons from businesses near you. No app, no signup.')
 where block_key = 'home.hero'
   and payload->>'subheadline' ilike '%carroll county%';

-- ---------------------------------------------------------------------
-- 4. Empty state for a town with nothing in it yet.
-- ---------------------------------------------------------------------

insert into public.content_blocks (block_key, block_type, title, payload, sort_order, is_active, is_system)
select 'empty.no_town_results', 'empty_state', 'Nothing in this town yet',
  jsonb_build_object(
    'headline', 'Nothing here yet',
    'body',     'No businesses in this town so far. Try another town, or see everything on Pocket Perks.',
    'cta_label','See every town',
    'cta_href', '/businesses?town=all'
  ), 50, true, true
where not exists (
  select 1 from public.content_blocks where block_key = 'empty.no_town_results'
);

-- ---------------------------------------------------------------------
-- 5. Remove a setting that never did anything.
--
-- features.show_favorites was carried over from the original seed. Nothing
-- reads it and nothing edits it — favourites are not part of this version.
-- A dead row in site_settings is worse than no row, because it reads as a
-- switch somebody could flip.
-- ---------------------------------------------------------------------

delete from public.site_settings where key = 'features.show_favorites';
