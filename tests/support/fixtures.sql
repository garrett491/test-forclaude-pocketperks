-- =====================================================================
-- End-to-end fixtures. Local test database only — never run on Supabase.
--
-- Businesses are chosen to exercise the edges rather than the happy path:
-- every awkward image ratio, a business with no deals, a draft that must
-- stay hidden, an expired and a scheduled deal, and a second town.
-- =====================================================================

alter table auth.users add column if not exists test_password text;

insert into auth.users (id, email, test_password) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com', 'correct-horse-battery'),
  ('22222222-2222-2222-2222-222222222222', 'nobody@example.com', 'correct-horse-battery')
on conflict (id) do update set test_password = excluded.test_password;

-- Only the first account is an administrator. The second can sign in to
-- Supabase Auth but has no profiles row, and must get nowhere.
insert into public.profiles (id, role, display_name)
values ('11111111-1111-1111-1111-111111111111', 'owner', 'Test Owner')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Media: one row per generated fixture image.
-- ---------------------------------------------------------------------

insert into public.media (id, bucket_id, storage_path, alt_text, width, height, mime_type) values
  ('a0000000-0000-0000-0000-000000000001', 'merchant-media', 'fixtures/logo-very-wide.webp', 'Crossroads Pizza logo', 1200, 240, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000002', 'merchant-media', 'fixtures/logo-very-tall.webp', 'Tall Tales Books logo', 240, 900, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000003', 'merchant-media', 'fixtures/logo-square-dark.webp', 'Square Deal Auto logo', 600, 600, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000004', 'merchant-media', 'fixtures/logo-lowres.webp', 'Tiny Logo Salon logo', 40, 40, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000005', 'merchant-media', 'fixtures/logo-white-bg.webp', 'Wide Awake Coffee logo', 800, 400, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000006', 'merchant-media', 'fixtures/photo-landscape-16x9.webp', 'Crossroads Pizza storefront', 1600, 900, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000007', 'merchant-media', 'fixtures/photo-portrait-3x4.webp', 'Inside Tall Tales Books', 900, 1200, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000008', 'merchant-media', 'fixtures/photo-panorama-2x1.webp', 'Wide Awake Coffee counter', 1600, 800, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000009', 'merchant-media', 'fixtures/photo-4x3.webp', 'A large pepperoni pizza', 1200, 900, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000010', 'merchant-media', 'fixtures/photo-1x2.webp', 'Pizza oven', 700, 1400, 'image/webp'),
  ('a0000000-0000-0000-0000-000000000011', 'merchant-media', 'fixtures/flyer-9x16.webp', 'Flyer: $5 off any order over $25', 900, 1600, 'image/webp'),
  -- Points at a file that does not exist, to prove the broken-image fallback.
  ('a0000000-0000-0000-0000-000000000012', 'merchant-media', 'fixtures/missing-file.webp', 'Broken Image Bakery logo', 400, 400, 'image/webp')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Merchants
-- ---------------------------------------------------------------------

insert into public.merchants
  (id, name, slug, tagline, description, category_id, town_id, address_line1, city, state_code, postal_code,
   phone_display, website_url, facebook_url, tier, is_featured, display_priority, status,
   logo_media_id, cover_media_id)
values
  ('b0000000-0000-0000-0000-000000000001', 'Crossroads Pizza', 'crossroads-pizza',
   'Hand-tossed pizza since 1998', 'Family-owned pizza shop on the square. Dine in, carry out or delivery.',
   (select id from public.categories where slug = 'food-drink'), (select id from public.towns where slug = 'carrollton'),
   '12 Public Square', 'Carrollton', 'OH', '44615', '(330) 555-0142', 'https://example.com/crossroads',
   'https://www.facebook.com/crossroadspizza', 'premium', true, 10, 'active',
   'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000006'),

  ('b0000000-0000-0000-0000-000000000002', 'Tall Tales Books', 'tall-tales-books',
   'Used and new books', null,
   (select id from public.categories where slug = 'shopping'), (select id from public.towns where slug = 'carrollton'),
   '40 Main St', 'Carrollton', 'OH', '44615', '330-555-0199', null, null, 'pro', false, 0, 'active',
   'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000007'),

  ('b0000000-0000-0000-0000-000000000003', 'Square Deal Auto', 'square-deal-auto',
   'Honest repairs', null,
   (select id from public.categories where slug = 'auto-repair'), (select id from public.towns where slug = 'carrollton'),
   '900 Canton Rd', 'Carrollton', 'OH', '44615', '3305550100', null, null, 'standard', false, 0, 'active',
   'a0000000-0000-0000-0000-000000000003', null),

  ('b0000000-0000-0000-0000-000000000004', 'Tiny Logo Salon', 'tiny-logo-salon',
   null, null,
   (select id from public.categories where slug = 'health-beauty'), (select id from public.towns where slug = 'carrollton'),
   null, null, 'OH', null, '330 555 0177', null, null, 'pro', false, 0, 'active',
   'a0000000-0000-0000-0000-000000000004', null),

  ('b0000000-0000-0000-0000-000000000005', 'No Deals Hardware', 'no-deals-hardware',
   'Nuts, bolts and advice', null,
   (select id from public.categories where slug = 'home-services'), (select id from public.towns where slug = 'carrollton'),
   '5 Elm St', 'Carrollton', 'OH', '44615', '330-555-0111', null, null, 'standard', false, 0, 'active',
   null, null),

  ('b0000000-0000-0000-0000-000000000006', 'Wide Awake Coffee', 'wide-awake-coffee',
   'Espresso and pastries', 'Small-batch roaster in Malvern.',
   (select id from public.categories where slug = 'food-drink'), (select id from public.towns where slug = 'malvern'),
   '1 Porter St', 'Malvern', 'OH', '44644', '330-555-0123', 'https://example.com/wideawake', null,
   'premium', true, 5, 'active',
   'a0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000008'),

  ('b0000000-0000-0000-0000-000000000007', 'Broken Image Bakery', 'broken-image-bakery',
   'Bread daily', null,
   (select id from public.categories where slug = 'food-drink'), (select id from public.towns where slug = 'carrollton'),
   null, null, 'OH', null, '330-555-0155', null, null, 'premium', false, 0, 'active',
   'a0000000-0000-0000-0000-000000000012', null),

  ('b0000000-0000-0000-0000-000000000008', 'Draft Diner', 'draft-diner',
   'Not open yet', null,
   (select id from public.categories where slug = 'food-drink'), (select id from public.towns where slug = 'carrollton'),
   null, null, 'OH', null, '330-555-0188', null, null, 'standard', false, 0, 'draft',
   null, null)
on conflict (id) do nothing;

insert into public.merchant_hours (merchant_id, day_of_week, is_closed, opens_at, closes_at)
select 'b0000000-0000-0000-0000-000000000001', d, false, '11:00', '22:00' from generate_series(0, 6) d
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------

insert into public.deals (id, merchant_id, slug, headline, description, terms, coupon_code, ends_at, starts_at,
                          is_featured, display_priority, status, image_media_id, deal_type)
values
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'ten-off-large',
   '$10 off any large pizza', 'Any large specialty or build-your-own pizza.', 'One per visit. Not valid with other offers.',
   'PERKS10', now() + interval '20 days', null, true, 10, 'active', 'a0000000-0000-0000-0000-000000000009', 'dollar_off'),
  ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 'free-garlic-bread',
   'Free garlic bread with any pizza', null, null, null, null, null, false, 5, 'active', null, 'freebie'),
  ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 'tuesday-bogo',
   'Buy one, get one half off on Tuesdays', 'Equal or lesser value.', null, null, now() + interval '2 days', null,
   false, 0, 'active', 'a0000000-0000-0000-0000-000000000010', 'bogo'),

  ('c0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', 'twenty-percent-used',
   '20% off used books', null, null, null, null, null, false, 0, 'active', null, 'percent_off'),
  ('c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000002', 'kids-story-hour',
   'Free kids story hour, Saturdays', 'Ages 3 to 8.', null, null, null, null, false, 0, 'active', null, 'freebie'),

  ('c0000000-0000-0000-0000-000000000006', 'b0000000-0000-0000-0000-000000000003', 'five-off-oil',
   '$5 off any oil change over $25', null, 'Most vehicles. Synthetic extra.', null, null, null, false, 0, 'active',
   'a0000000-0000-0000-0000-000000000011', 'dollar_off'),

  ('c0000000-0000-0000-0000-000000000007', 'b0000000-0000-0000-0000-000000000004', 'first-cut',
   '15% off your first haircut', null, 'New clients only.', 'NEWCUT', now() + interval '1 day', null, false, 0, 'active',
   null, 'percent_off'),

  ('c0000000-0000-0000-0000-000000000008', 'b0000000-0000-0000-0000-000000000006', 'free-drip',
   'Free drip coffee with any pastry', null, null, null, null, null, true, 0, 'active', null, 'freebie'),
  ('c0000000-0000-0000-0000-000000000009', 'b0000000-0000-0000-0000-000000000006', 'bag-deal',
   '$3 off a bag of beans', null, null, null, null, null, false, 0, 'active', null, 'dollar_off'),

  ('c0000000-0000-0000-0000-000000000010', 'b0000000-0000-0000-0000-000000000007', 'day-old',
   'Half price day-old bread', null, null, null, null, null, false, 0, 'active', null, 'percent_off'),

  -- Must never be visible: expired, scheduled, draft, and on a draft merchant.
  ('c0000000-0000-0000-0000-000000000011', 'b0000000-0000-0000-0000-000000000002', 'expired-sale',
   'Expired clearance sale', null, null, null, now() - interval '1 day', now() - interval '10 days',
   false, 0, 'active', null, 'special'),
  ('c0000000-0000-0000-0000-000000000012', 'b0000000-0000-0000-0000-000000000004', 'future-promo',
   'Scheduled holiday promo', null, null, null, null, now() + interval '5 days', false, 0, 'active', null, 'special'),
  ('c0000000-0000-0000-0000-000000000013', 'b0000000-0000-0000-0000-000000000003', 'draft-offer',
   'Draft offer nobody should see', null, null, null, null, null, false, 0, 'draft', null, 'special'),
  ('c0000000-0000-0000-0000-000000000014', 'b0000000-0000-0000-0000-000000000008', 'draft-diner-deal',
   'Deal on a draft business', null, null, null, null, null, false, 0, 'active', null, 'special')
on conflict (id) do nothing;

insert into public.merchant_gallery (merchant_id, media_id, caption, sort_order) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000009', 'Our pepperoni', 10),
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000010', 'The oven', 20),
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000008', null, 30)
on conflict do nothing;

-- Migration 0009 switches the carousel on for Premium businesses that
-- existed when it ran. These fixtures are inserted afterwards, so set it.
update public.merchants set show_in_carousel = true where tier = 'premium';

-- A business login for Tall Tales Books (b...0002), ready to use:
-- signed in with correct-horse-battery, special word "blue heron".
insert into auth.users (id, email, test_password) values
  ('44444444-4444-4444-4444-444444444444', 'books@example.com', 'correct-horse-battery')
on conflict (id) do update set test_password = excluded.test_password;
insert into public.portal_users (user_id, email, display_name, secret_hash, secret_set_at)
values ('44444444-4444-4444-4444-444444444444', 'books@example.com', 'Sam Reader',
        extensions.crypt('blue heron', extensions.gen_salt('bf', 8)), now())
on conflict (user_id) do nothing;
insert into public.merchant_members (user_id, merchant_id)
values ('44444444-4444-4444-4444-444444444444', 'b0000000-0000-0000-0000-000000000002')
on conflict do nothing;

-- Hosted Supabase grants the service role full access to public tables by
-- default; the local stub does not, so grant it here. RLS still applies
-- to anon and authenticated exactly as in production.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
