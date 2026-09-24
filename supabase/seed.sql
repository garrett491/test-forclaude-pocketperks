-- =====================================================================
-- Pocket Perks — Seed
--
-- Reference and configuration data only. No sample merchants, no sample
-- deals, no placeholder copy pretending to be real content. The five
-- live businesses get entered through the admin dashboard, which is also
-- the first real test of whether the dashboard is good enough to use.
--
-- Safe to re-run: every insert is idempotent.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Towns
-- ---------------------------------------------------------------------

insert into public.towns (slug, name, state_code, latitude, longitude, sort_order, is_active, seo_title, seo_description)
values (
  'carrollton', 'Carrollton', 'OH', 40.573000, -81.086000, 10, true,
  'Local Deals in Carrollton, Ohio',
  'Current coupons, discounts and offers from businesses around Carrollton, Ohio. Free to use, updated as merchants add them.'
)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- Categories
-- Named the way a customer would say them, not the way the old database
-- abbreviated them. "Auto" became "Auto & Repair" because a customer
-- searching for a mechanic does not think of themselves as shopping for
-- "auto".
-- ---------------------------------------------------------------------

insert into public.categories (slug, name, icon_key, sort_order) values
  ('food-drink',    'Food & Drink',      'utensils',  10),
  ('auto-repair',   'Auto & Repair',     'wrench',    20),
  ('health-beauty', 'Health & Beauty',   'sparkle',   30),
  ('shopping',      'Shopping',          'bag',       40),
  ('home-services', 'Home & Services',   'toolbox',   50),
  ('things-to-do',  'Things to Do',      'ticket',    60),
  ('other',         'Everything Else',   'shop',      99)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- Badges
-- Every badge means one specific thing. A badge that appears on
-- everything communicates nothing, so there are only four.
-- ---------------------------------------------------------------------

insert into public.badges (slug, label, style_key, is_system) values
  ('new',           'New',           'lime',    true),
  ('featured',      'Featured',      'deep',    true),
  ('ending-soon',   'Ending soon',   'outline', true),
  ('limited',       'Limited',       'neutral', false)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- Site settings
-- is_public = true means the anonymous website can read it. Anything
-- operational stays false and is visible only to a signed-in admin.
-- ---------------------------------------------------------------------

insert into public.site_settings (key, value, label, description, is_public, is_system) values
  ('site.name',
   '"Pocket Perks"'::jsonb,
   'Site name', 'Appears in the browser tab, search results and share previews.', true, true),

  ('site.tagline',
   '"Your local deals, all in one place"'::jsonb,
   'Tagline', 'Short line under the logo in the footer.', true, true),

  ('seo.default_title',
   '"Pocket Perks — Local Deals in Carroll County, Ohio"'::jsonb,
   'Default page title', 'Used on any page without its own title.', true, true),

  ('seo.default_description',
   '"Free local coupons and discounts from businesses around Carroll County, Ohio. No app, no signup required."'::jsonb,
   'Default meta description', 'Shown in Google results. Keep under 155 characters.', true, true),

  ('seo.og_image_path',
   '"/og-default.png"'::jsonb,
   'Default share image', 'The picture that appears when a link is posted to Facebook.', true, true),

  ('contact.email',
   '"hello@yourpocketperks.com"'::jsonb,
   'Contact email', 'Shown in the footer and used as the reply-to on notifications.', true, true),

  ('contact.phone_display',
   '""'::jsonb,
   'Contact phone', 'Leave blank to hide it from the footer.', true, false),

  ('social.facebook_url',
   '""'::jsonb,
   'Facebook page', 'Full https link. Leave blank to hide the icon.', true, false),

  ('social.instagram_url',
   '""'::jsonb,
   'Instagram page', 'Full https link. Leave blank to hide the icon.', true, false),

  ('newsletter.mode',
   '"supabase"'::jsonb,
   'Newsletter destination',
   'supabase = store signups here. activecampaign_link = send people to a hosted form instead. Switching this is the whole ActiveCampaign migration.',
   true, true),

  ('newsletter.external_form_url',
   '""'::jsonb,
   'ActiveCampaign form link', 'Only used when the destination above is set to activecampaign_link.', true, false),

  ('ops.notify_email',
   '""'::jsonb,
   'Send new lead alerts to', 'Internal only. Never shown on the website.', false, false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Content blocks
--
-- Copy notes:
--   The old hero read "Save Money at Businesses You Already Visit" —
--   benefit-led, local, no overclaim. It stays, because it is the best
--   sentence on the current site.
--
--   The old newsletter box said "Get Local Deals Delivered" with the
--   subheading hidden by CSS. Rewritten to say what actually arrives and
--   how often, because a specific promise converts better than a vague
--   one and is also the only version that is true.
--
--   Empty states tell the visitor what to do next instead of apologising.
-- ---------------------------------------------------------------------

insert into public.content_blocks (block_key, block_type, title, payload, sort_order, is_active, is_system) values
  ('home.hero', 'hero', 'Homepage hero',
   jsonb_build_object(
     'headline',    'Save money at the places you already go',
     'subheadline', 'Local coupons from Carroll County businesses. Free, no app, no signup.',
     'primary_cta_label', 'Browse deals',
     'primary_cta_href',  '/deals',
     'secondary_cta_label', 'See businesses',
     'secondary_cta_href',  '/businesses'
   ), 10, true, true),

  ('home.how_it_works', 'how_it_works', 'How it works',
   jsonb_build_object('steps', jsonb_build_array(
     jsonb_build_object('title', 'Find a deal', 'body', 'Browse by category or search for a business.'),
     jsonb_build_object('title', 'Show your phone', 'body', 'Nothing to print. Show the offer at the counter.'),
     jsonb_build_object('title', 'Save', 'body', 'The business honours it on the spot.')
   )), 30, true, false),

  ('home.newsletter', 'newsletter', 'Newsletter block',
   jsonb_build_object(
     'headline', 'New deals, once a week',
     'body',     'One email each week with what is new from local businesses. Unsubscribe any time.',
     'cta_label','Send me deals',
     'fine_print','We only email about local deals. Your address is never sold or shared.'
   ), 60, true, true),

  ('empty.no_deals', 'empty_state', 'No deals in this filter',
   jsonb_build_object(
     'headline', 'Nothing here right now',
     'body',     'No deals match those filters yet. Try another category, or see everything on offer.',
     'cta_label','Show all deals',
     'cta_href', '/deals'
   ), 10, true, true),

  ('empty.no_search_results', 'empty_state', 'No search results',
   jsonb_build_object(
     'headline', 'No match for that',
     'body',     'Check the spelling, or browse by category instead.',
     'cta_label','Browse categories',
     'cta_href', '/deals'
   ), 20, true, true),

  ('empty.merchant_no_deals', 'empty_state', 'Business has no live deals',
   jsonb_build_object(
     'headline', 'No offer running right now',
     'body',     'This business is on Pocket Perks but has nothing live today. Their details are below.',
     'cta_label','', 'cta_href', ''
   ), 30, true, true)
on conflict (block_key) do nothing;

-- ---------------------------------------------------------------------
-- Navigation
--
-- Four items. Hick's Law is real and a directory with one town does not
-- need a mega-menu. "List your business" moves out of the primary
-- consumer nav — it was occupying the most valuable position on the page
-- while speaking to roughly one visitor in a hundred.
-- ---------------------------------------------------------------------

insert into public.nav_items (location, section, label, href, sort_order, is_system) values
  ('header', null, 'Deals',      '/deals',      10, true),
  ('header', null, 'Businesses', '/businesses', 20, true),
  ('header', null, 'Categories', '/deals#categories', 30, false),

  ('footer', 'Browse', 'All deals',       '/deals',       10, true),
  ('footer', 'Browse', 'All businesses',  '/businesses',  20, true),
  ('footer', 'Browse', 'Carrollton',      '/carrollton',  30, false),

  ('footer', 'For businesses', 'Advertise on Pocket Perks', '/for-business', 10, true),

  ('footer', 'About', 'Privacy',     '/privacy',     10, true),
  ('footer', 'About', 'Unsubscribe', '/unsubscribe', 20, true)
on conflict do nothing;
