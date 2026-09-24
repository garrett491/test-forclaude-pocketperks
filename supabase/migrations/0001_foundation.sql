-- =====================================================================
-- Pocket Perks — 0001 Foundation
-- Extensions, enumerated types, and shared helper functions.
-- Safe to re-run.
-- =====================================================================

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------
-- Enumerated types
-- Enums (not free text) so the admin UI can render dropdowns that cannot
-- produce an invalid value, and so bad data is rejected at the database
-- rather than discovered on the live site.
-- ---------------------------------------------------------------------

do $$ begin
  create type public.admin_role as enum ('owner', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.merchant_tier as enum ('standard', 'pro', 'premium');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.publish_status as enum ('draft', 'active', 'paused', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.deal_type as enum (
    'percent_off', 'dollar_off', 'bogo', 'freebie', 'bundle', 'special', 'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.subscriber_status as enum ('pending', 'active', 'unsubscribed', 'bounced');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.lead_status as enum ('new', 'contacted', 'won', 'lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.nav_location as enum ('header', 'footer');
exception when duplicate_object then null; end $$;

-- Deliberately narrow. Every value maps to something that can be honestly
-- described to a paying merchant. No scroll depth, no hover, no time-on-page.
do $$ begin
  create type public.event_type as enum (
    'merchant_view',      -- merchant profile page loaded
    'deal_view',          -- deal appeared in a viewport (impression)
    'deal_open',          -- deal detail opened (intent)
    'code_copy',          -- coupon code copied (strong intent)
    'call_click',         -- tel: link activated (strong intent)
    'directions_click',   -- map link activated (strong intent)
    'website_click',      -- outbound click to merchant site (strong intent)
    'share',              -- deal shared
    'subscribe',          -- newsletter signup
    'search'              -- search performed
  );
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Helper: URL-safe slug from arbitrary text
-- ---------------------------------------------------------------------

create or replace function public.slugify(input text)
returns text
language sql
immutable
as $$
  select trim(both '-' from
    regexp_replace(
      regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g'),
      '-{2,}', '-', 'g'
    )
  );
$$;

-- ---------------------------------------------------------------------
-- Helper: keep updated_at honest without trusting the application
-- ---------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Helper: normalise a US phone number to E.164, or null if unusable.
-- Stored separately from the display string so tel: links are always
-- dialable regardless of how the number was typed into the admin form.
-- ---------------------------------------------------------------------

create or replace function public.normalize_phone(input text)
returns text
language plpgsql
immutable
as $$
declare
  digits text;
begin
  if input is null or btrim(input) = '' then
    return null;
  end if;
  digits := regexp_replace(input, '[^0-9]', '', 'g');
  if length(digits) = 10 then
    return '+1' || digits;
  elsif length(digits) = 11 and left(digits, 1) = '1' then
    return '+' || digits;
  end if;
  return null;
end;
$$;
