-- =====================================================================
-- Pocket Perks — 0006 Fixes
--
-- Purely additive. Nothing is dropped, no data is lost, and it is safe to
-- run more than once. Run it after 0001–0005 and seed.sql.
--
-- What it does:
--   1. Auto-fills slugs for towns and categories, so both can be created
--      from the admin panel the way merchants and deals already can.
--   2. Adds a Home link to the header navigation.
--   3. Adds an empty-state block for a category with no businesses.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Slug auto-fill
--
-- Merchants and deals generate their own slug when the field is left
-- blank; towns and categories did not, which meant the admin had no way to
-- create either without writing SQL. Same trigger shape, same collision
-- handling: a second "Malvern" becomes malvern-2 rather than an error.
-- ---------------------------------------------------------------------

create or replace function public.towns_fill_slug()
returns trigger
language plpgsql
as $$
declare
  base text;
  candidate text;
  n integer := 1;
begin
  if new.slug is null or btrim(new.slug) = '' then
    base := public.slugify(new.name);
    if base = '' then base := 'town'; end if;
    candidate := base;
    while exists (
      select 1 from public.towns t
      where lower(t.slug) = lower(candidate) and t.id is distinct from new.id
    ) loop
      n := n + 1;
      candidate := base || '-' || n;
    end loop;
    new.slug := candidate;
  end if;

  new.state_code := upper(coalesce(new.state_code, 'OH'));
  return new;
end;
$$;

drop trigger if exists towns_before_write on public.towns;
create trigger towns_before_write
  before insert or update on public.towns
  for each row execute function public.towns_fill_slug();

create or replace function public.categories_fill_slug()
returns trigger
language plpgsql
as $$
declare
  base text;
  candidate text;
  n integer := 1;
begin
  if new.slug is null or btrim(new.slug) = '' then
    base := public.slugify(new.name);
    if base = '' then base := 'category'; end if;
    candidate := base;
    while exists (
      select 1 from public.categories c
      where lower(c.slug) = lower(candidate) and c.id is distinct from new.id
    ) loop
      n := n + 1;
      candidate := base || '-' || n;
    end loop;
    new.slug := candidate;
  end if;
  return new;
end;
$$;

drop trigger if exists categories_before_write on public.categories;
create trigger categories_before_write
  before insert or update on public.categories
  for each row execute function public.categories_fill_slug();

create or replace function public.badges_fill_slug()
returns trigger
language plpgsql
as $$
declare
  base text;
  candidate text;
  n integer := 1;
begin
  if new.slug is null or btrim(new.slug) = '' then
    base := public.slugify(new.label);
    if base = '' then base := 'badge'; end if;
    candidate := base;
    while exists (
      select 1 from public.badges b
      where lower(b.slug) = lower(candidate) and b.id is distinct from new.id
    ) loop
      n := n + 1;
      candidate := base || '-' || n;
    end loop;
    new.slug := candidate;
  end if;
  return new;
end;
$$;

drop trigger if exists badges_before_write on public.badges;
create trigger badges_before_write
  before insert or update on public.badges
  for each row execute function public.badges_fill_slug();

-- ---------------------------------------------------------------------
-- 2. A Home link in the header.
--
-- Clicking a logo to get home is a convention, not an instruction. Not
-- everyone knows it, and an explicit link costs one slot in a four-item nav.
-- Marked is_system so it cannot be deleted by accident, only switched off.
-- ---------------------------------------------------------------------

insert into public.nav_items (location, section, label, href, sort_order, is_system, is_active)
select 'header', null, 'Home', '/', 5, true, true
where not exists (
  select 1 from public.nav_items
  where location = 'header' and href = '/'
);

-- ---------------------------------------------------------------------
-- 3. Empty state for a category with no businesses in it.
-- ---------------------------------------------------------------------

insert into public.content_blocks (block_key, block_type, title, payload, sort_order, is_active, is_system)
select 'empty.no_businesses', 'empty_state', 'No businesses in this category',
  jsonb_build_object(
    'headline', 'Nobody here yet',
    'body',     'No businesses in this category so far. Browse the rest, or tell us who should be on it.',
    'cta_label','Show all businesses',
    'cta_href', '/businesses'
  ), 40, true, true
where not exists (
  select 1 from public.content_blocks where block_key = 'empty.no_businesses'
);

-- ---------------------------------------------------------------------
-- 4. Manual unsubscribe helper.
--
-- Someone will ask to be taken off the list by text or in person. This lets
-- the admin honour that without writing SQL. Sets the status rather than
-- deleting the row, so the address is not silently re-added by a later
-- signup import.
-- ---------------------------------------------------------------------

create or replace function public.unsubscribe_email(target_email text)
returns boolean
language plpgsql
security invoker
as $$
declare
  hit integer;
begin
  update public.subscribers
     set status = 'unsubscribed', unsubscribed_at = now()
   where email = lower(btrim(target_email))
     and status <> 'unsubscribed';
  get diagnostics hit = row_count;
  return hit > 0;
end;
$$;

grant execute on function public.unsubscribe_email(text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Honest labelling for a setting that is not yet wired up.
--
-- ops.notify_email looked like it would email you when an enquiry arrived.
-- Nothing sends it, because sending email needs a mail provider and this
-- build deliberately adds no vendors. Rather than leave a field that
-- silently does nothing, say so. New enquiries are surfaced on the admin
-- dashboard under "Needs attention".
-- ---------------------------------------------------------------------

update public.site_settings
   set label = 'Alert address (not yet connected)',
       description = 'Reserved for future email alerts. Nothing is sent yet — new enquiries appear on the dashboard under "Needs attention".'
 where key = 'ops.notify_email';
