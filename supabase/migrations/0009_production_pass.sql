-- =====================================================================
-- Pocket Perks — 0009 Production pass
--
-- Additive. Nothing is dropped, no data is lost, safe to run twice.
-- Run after 0001–0008.
--
-- What it does:
--   1. A per-business "show in the featured carousel" switch.
--   2. A short, card-sized line for a deal's key limits.
--   3. Smaller copies of uploaded images, so a phone never downloads the
--      full-size original for a thumbnail.
--   4. Consent records on newsletter signups.
--   5. Terms and Accessibility pages in the footer.
--   6. Editable wording for the first-visit town chooser.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Carousel eligibility
--
-- The carousel used to include every Premium business automatically, with
-- no way to take one out or comp another in. It is now an explicit switch
-- on each business. Existing Premium businesses are switched on once, when
-- the column is first added, so the live carousel does not change.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'merchants' and column_name = 'show_in_carousel'
  ) then
    alter table public.merchants add column show_in_carousel boolean not null default false;
    update public.merchants set show_in_carousel = true where tier = 'premium';
  end if;
end $$;

create index if not exists merchants_carousel_idx
  on public.merchants (town_id, display_priority desc) where show_in_carousel;

-- ---------------------------------------------------------------------
-- 2. Key limits, shown on cards
--
-- "Dine-in only · Min. $20 · One per visit". The full terms stay on the
-- deal page; this short line is what makes a card honest at a glance.
-- ---------------------------------------------------------------------

alter table public.deals add column if not exists restrictions text;

do $$ begin
  alter table public.deals add constraint deals_restrictions_len
    check (restrictions is null or length(restrictions) <= 120);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 3. Image variants
--
-- The admin uploader now also stores a copy no wider or taller than 640px.
-- Each entry is {"w": 640, "h": 360, "path": "uploads/…-640.webp"}. Older
-- uploads have none and simply keep serving the single original.
-- ---------------------------------------------------------------------

alter table public.media add column if not exists variants jsonb not null default '[]'::jsonb;

do $$ begin
  alter table public.media add constraint media_variants_array check (jsonb_typeof(variants) = 'array');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 4. Consent records
--
-- What the visitor was shown when they signed up, and when. Useful when
-- someone asks "why am I getting this?", and required reading before any
-- list is moved to a sending platform.
-- ---------------------------------------------------------------------

alter table public.subscribers add column if not exists consent_text text;
alter table public.subscribers add column if not exists consent_at timestamptz;
alter table public.subscribers add column if not exists consent_path text;

do $$ begin
  alter table public.subscribers add constraint subscribers_consent_len
    check ((consent_text is null or length(consent_text) <= 500)
       and (consent_path is null or length(consent_path) <= 300));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 5. Footer links to the new policy pages.
-- ---------------------------------------------------------------------

insert into public.nav_items (location, section, label, href, sort_order, is_system, is_active)
select 'footer', 'About', 'Terms of use', '/terms', 15, true, true
where not exists (select 1 from public.nav_items where location = 'footer' and href = '/terms');

insert into public.nav_items (location, section, label, href, sort_order, is_system, is_active)
select 'footer', 'About', 'Accessibility', '/accessibility', 18, true, true
where not exists (select 1 from public.nav_items where location = 'footer' and href = '/accessibility');

-- ---------------------------------------------------------------------
-- 6. The first-visit town chooser.
-- ---------------------------------------------------------------------

insert into public.content_blocks (block_key, block_type, title, payload, sort_order, is_active, is_system)
select 'home.town_chooser', 'hero', 'First-visit town chooser',
  jsonb_build_object(
    'headline', 'Where do you want to find deals?',
    'body',     'Pick your town. We''ll remember it on this device, and you can change it any time.'
  ), 5, true, true
where not exists (select 1 from public.content_blocks where block_key = 'home.town_chooser');

-- ---------------------------------------------------------------------
-- 7. Expired deals no longer count against the plan limit.
--
-- A deal whose end date has passed is off the website automatically, but
-- it kept its "Live" status and so kept using one of the business's plan
-- slots. The admin saw two deals on the site and a refusal to add a third.
-- Only deals that are Live and not yet ended count now. (Scheduled deals
-- still count: they are about to go live.)
-- ---------------------------------------------------------------------

create or replace function public.enforce_deal_tier_limit()
returns trigger
language plpgsql
as $$
declare
  m_tier public.merchant_tier;
  m_name text;
  live_count integer;
  cap integer;
begin
  if new.status <> 'active' or (new.ends_at is not null and new.ends_at <= now()) then
    return new;
  end if;

  select tier, name into m_tier, m_name
  from public.merchants where id = new.merchant_id;

  cap := public.deal_limit_for_tier(m_tier);

  select count(*) into live_count
  from public.deals d
  where d.merchant_id = new.merchant_id
    and d.status = 'active'
    and (d.ends_at is null or d.ends_at > now())
    and d.id is distinct from new.id;

  if live_count + 1 > cap then
    raise exception
      '% is on the % plan, which includes % live deal(s) at a time. Pause or end one first, or upgrade the plan.',
      m_name, m_tier, cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
