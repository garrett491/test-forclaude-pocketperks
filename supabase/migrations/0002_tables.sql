-- =====================================================================
-- Pocket Perks — 0002 Tables
-- Core relational schema, constraints, indexes, and integrity triggers.
-- =====================================================================

-- ---------------------------------------------------------------------
-- profiles — the admin roster.
-- A row here is what makes an auth.users account an administrator.
-- Users are created in the Supabase dashboard; there is no signup route.
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  role          public.admin_role not null default 'admin',
  display_name  text not null,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- towns
-- ---------------------------------------------------------------------

create table if not exists public.towns (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null,
  name            text not null,
  state_code      text not null default 'OH',
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  seo_title       text,
  seo_description text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint towns_slug_unique   unique (slug),
  constraint towns_slug_format   check (slug = public.slugify(slug) and length(slug) between 1 and 60),
  constraint towns_name_len      check (length(btrim(name)) between 1 and 80),
  constraint towns_state_format  check (state_code ~ '^[A-Z]{2}$'),
  constraint towns_lat_range     check (latitude is null or latitude between -90 and 90),
  constraint towns_lng_range     check (longitude is null or longitude between -180 and 180),
  constraint towns_seo_desc_len  check (seo_description is null or length(seo_description) <= 300)
);

create index if not exists towns_active_idx on public.towns (is_active, sort_order);

-- ---------------------------------------------------------------------
-- categories
-- icon_key names a bundled SVG. Colour is NOT stored per category:
-- categories are differentiated by icon, tint and border weight so the
-- palette can never drift away from the logo.
-- ---------------------------------------------------------------------

create table if not exists public.categories (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null,
  name            text not null,
  icon_key        text not null default 'shop',
  sort_order      integer not null default 0,
  is_active       boolean not null default true,
  seo_title       text,
  seo_description text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint categories_slug_unique unique (slug),
  constraint categories_slug_format check (slug = public.slugify(slug) and length(slug) between 1 and 60),
  constraint categories_name_len    check (length(btrim(name)) between 1 and 60),
  constraint categories_icon_format check (icon_key ~ '^[a-z0-9-]{1,40}$')
);

create index if not exists categories_active_idx on public.categories (is_active, sort_order);

-- ---------------------------------------------------------------------
-- badges — the labels that can appear on a deal.
-- is_system rows cannot be deleted through the admin UI or the API.
-- ---------------------------------------------------------------------

create table if not exists public.badges (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null,
  label      text not null,
  style_key  text not null default 'neutral',
  is_system  boolean not null default false,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),

  constraint badges_slug_unique  unique (slug),
  constraint badges_slug_format  check (slug = public.slugify(slug) and length(slug) between 1 and 40),
  constraint badges_label_len    check (length(btrim(label)) between 1 and 24),
  constraint badges_style_allow  check (style_key in ('neutral', 'lime', 'deep', 'outline'))
);


-- ---------------------------------------------------------------------
-- media — one row per uploaded asset in Supabase Storage.
-- Dimensions are stored so every <img> can carry width/height and stop
-- causing layout shift, which is a Core Web Vitals fix that has to
-- happen at the data layer to be reliable.
-- ---------------------------------------------------------------------

create table if not exists public.media (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text not null default 'merchant-media',
  storage_path text not null,
  alt_text    text not null default '',
  width       integer,
  height      integer,
  byte_size   integer,
  mime_type   text not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,

  constraint media_mime_allow check (mime_type in ('image/webp', 'image/jpeg', 'image/png', 'image/avif')),
  constraint media_dims_pos   check ((width is null or width > 0) and (height is null or height > 0)),
  constraint media_size_cap   check (byte_size is null or byte_size <= 5242880),
  constraint media_alt_len    check (length(alt_text) <= 200)
);

create unique index if not exists media_path_key on public.media (bucket_id, storage_path);

-- ---------------------------------------------------------------------
-- merchants
-- ---------------------------------------------------------------------

create table if not exists public.merchants (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null,
  name             text not null,
  tagline          text,
  description      text,

  category_id      uuid not null references public.categories (id) on delete restrict,
  town_id          uuid not null references public.towns (id) on delete restrict,

  address_line1    text,
  address_line2    text,
  city             text,
  state_code       text default 'OH',
  postal_code      text,
  latitude         numeric(9,6),
  longitude        numeric(9,6),

  phone_display    text,
  phone_e164       text,
  website_url      text,
  facebook_url     text,
  instagram_url    text,

  logo_media_id    uuid references public.media (id) on delete set null,
  cover_media_id   uuid references public.media (id) on delete set null,

  tier             public.merchant_tier not null default 'standard',
  is_featured      boolean not null default false,
  display_priority integer not null default 0,
  status           public.publish_status not null default 'draft',

  seo_title        text,
  seo_description  text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  published_at     timestamptz,
  archived_at      timestamptz,

  constraint merchants_slug_unique  unique (slug),
  constraint merchants_slug_format  check (slug = public.slugify(slug) and length(slug) between 1 and 80),
  constraint merchants_name_len     check (length(btrim(name)) between 1 and 120),
  constraint merchants_tagline_len  check (tagline is null or length(tagline) <= 120),
  constraint merchants_desc_len     check (description is null or length(description) <= 2000),
  constraint merchants_state_format check (state_code is null or state_code ~ '^[A-Z]{2}$'),
  constraint merchants_zip_format   check (postal_code is null or postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  constraint merchants_phone_e164   check (phone_e164 is null or phone_e164 ~ '^\+1[0-9]{10}$'),
  constraint merchants_lat_range    check (latitude is null or latitude between -90 and 90),
  constraint merchants_lng_range    check (longitude is null or longitude between -180 and 180),
  constraint merchants_seo_desc_len check (seo_description is null or length(seo_description) <= 300),

  -- URL fields must be absolute https. A bare "www.example.com" typed into
  -- the old admin produced a broken relative link on every card; this makes
  -- that impossible to save.
  constraint merchants_website_url   check (website_url   is null or website_url   ~* '^https://[^\s/$.?#].[^\s]*$'),
  constraint merchants_facebook_url  check (facebook_url  is null or facebook_url  ~* '^https://([a-z0-9-]+\.)*facebook\.com/[^\s]*$'),
  constraint merchants_instagram_url check (instagram_url is null or instagram_url ~* '^https://([a-z0-9-]+\.)*instagram\.com/[^\s]*$'),

  -- An active merchant must actually be presentable.
  constraint merchants_active_needs_phone_or_site
    check (status <> 'active' or phone_e164 is not null or website_url is not null),

  constraint merchants_archived_stamp
    check ((status = 'archived') = (archived_at is not null))
);

create index if not exists merchants_status_idx   on public.merchants (status) where status = 'active';
create index if not exists merchants_town_idx     on public.merchants (town_id, status);
create index if not exists merchants_category_idx on public.merchants (category_id, status);
create index if not exists merchants_ranking_idx  on public.merchants (status, is_featured desc, display_priority desc, name);
create index if not exists merchants_name_trgm    on public.merchants using gin (name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------
-- merchant_hours — structured, not a free-text string.
-- Structured hours are what let the site say "Open now", emit valid
-- LocalBusiness openingHoursSpecification, and stop hours from silently
-- rotting in a text field.
-- ---------------------------------------------------------------------

create table if not exists public.merchant_hours (
  id          uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  day_of_week smallint not null,
  is_closed   boolean not null default false,
  opens_at    time,
  closes_at   time,

  constraint merchant_hours_dow      check (day_of_week between 0 and 6),
  constraint merchant_hours_complete check (is_closed or (opens_at is not null and closes_at is not null))
);

create unique index if not exists merchant_hours_unique on public.merchant_hours (merchant_id, day_of_week);

-- ---------------------------------------------------------------------
-- deals
-- ends_at is a real timestamp. The old free-text "Dec 31, 2025" could not
-- be sorted or auto-expired, so dead offers stayed on the site until
-- someone noticed. Expiry is now enforced by the read policy.
-- ---------------------------------------------------------------------

create table if not exists public.deals (
  id               uuid primary key default gen_random_uuid(),
  merchant_id      uuid not null references public.merchants (id) on delete cascade,
  slug             text not null,
  headline         text not null,
  description      text,
  terms            text,
  deal_type        public.deal_type not null default 'special',
  coupon_code      text,
  badge_id         uuid references public.badges (id) on delete set null,
  image_media_id   uuid references public.media (id) on delete set null,

  starts_at        timestamptz,
  ends_at          timestamptz,

  is_featured      boolean not null default false,
  display_priority integer not null default 0,
  status           public.publish_status not null default 'draft',

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint deals_merchant_slug unique (merchant_id, slug),
  constraint deals_slug_format   check (slug = public.slugify(slug) and length(slug) between 1 and 80),
  constraint deals_headline_len  check (length(btrim(headline)) between 3 and 120),
  constraint deals_desc_len      check (description is null or length(description) <= 1000),
  constraint deals_terms_len     check (terms is null or length(terms) <= 1000),
  constraint deals_code_format   check (coupon_code is null or coupon_code ~ '^[A-Za-z0-9._-]{2,24}$'),
  constraint deals_window        check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create index if not exists deals_merchant_idx on public.deals (merchant_id, status);
create index if not exists deals_live_idx     on public.deals (status, ends_at) where status = 'active';
create index if not exists deals_ranking_idx  on public.deals (status, is_featured desc, display_priority desc, created_at desc);
create index if not exists deals_headline_trgm on public.deals using gin (headline extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------
-- Editable site content
-- ---------------------------------------------------------------------

create table if not exists public.site_settings (
  key         text primary key,
  value       jsonb not null,
  label       text not null,
  description text,
  is_public   boolean not null default false,
  is_system   boolean not null default false,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles (id) on delete set null,

  constraint site_settings_key_format check (key ~ '^[a-z0-9_.]{2,60}$')
);

comment on column public.site_settings.is_public is
  'Only rows with is_public = true are readable by anonymous visitors. Anything operational stays private by default.';

create table if not exists public.content_blocks (
  id          uuid primary key default gen_random_uuid(),
  block_key   text not null,
  block_type  text not null,
  title       text,
  payload     jsonb not null default '{}'::jsonb,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  is_system   boolean not null default false,
  starts_at   timestamptz,
  ends_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint content_blocks_key_unique unique (block_key),
  constraint content_blocks_key_format check (block_key ~ '^[a-z0-9_.-]{2,60}$'),
  constraint content_blocks_type_allow check (block_type in (
    'hero', 'announcement', 'how_it_works', 'newsletter', 'empty_state', 'promo_banner', 'rich_text'
  )),
  constraint content_blocks_window check (starts_at is null or ends_at is null or ends_at > starts_at)
);

create index if not exists content_blocks_live_idx on public.content_blocks (is_active, sort_order);

create table if not exists public.nav_items (
  id            uuid primary key default gen_random_uuid(),
  location      public.nav_location not null,
  section       text,
  label         text not null,
  href          text not null,
  sort_order    integer not null default 0,
  opens_new_tab boolean not null default false,
  is_active     boolean not null default true,
  is_system     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint nav_items_label_len check (length(btrim(label)) between 1 and 40),
  -- Relative path or absolute https only. Blocks javascript: and data: URLs
  -- being saved into navigation, which is a stored-XSS vector.
  constraint nav_items_href_safe check (href ~ '^/[^\s]*$' or href ~* '^https://[^\s/$.?#].[^\s]*$')
);

create index if not exists nav_items_location_idx on public.nav_items (location, is_active, sort_order);

-- ---------------------------------------------------------------------
-- subscribers
-- external_id/synced_at exist now but are unused. When ActiveCampaign
-- becomes the system of record, the sync writes those two columns and
-- nothing else in the schema changes.
-- ---------------------------------------------------------------------

create table if not exists public.subscribers (
  id                 uuid primary key default gen_random_uuid(),
  email              text not null,
  status             public.subscriber_status not null default 'active',
  source             text,
  town_id            uuid references public.towns (id) on delete set null,
  referrer           text,
  utm                jsonb not null default '{}'::jsonb,
  ip_hash            text,
  confirmed_at       timestamptz,
  unsubscribed_at    timestamptz,
  unsubscribe_token  uuid not null default gen_random_uuid(),
  external_id        text,
  synced_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint subscribers_email_unique unique (email),
  constraint subscribers_email_format check (email ~* '^[^@\s]+@[^@\s.]+\.[a-z]{2,}$' and length(email) <= 254),
  constraint subscribers_source_len   check (source is null or length(source) <= 60),
  constraint subscribers_referrer_len check (referrer is null or length(referrer) <= 500)
);

create unique index if not exists subscribers_unsub_token_key on public.subscribers (unsubscribe_token);
create index if not exists subscribers_status_idx on public.subscribers (status, created_at desc);

-- ---------------------------------------------------------------------
-- merchant_leads — the "List your business" inbox
-- ---------------------------------------------------------------------

create table if not exists public.merchant_leads (
  id            uuid primary key default gen_random_uuid(),
  business_name text not null,
  contact_name  text not null,
  phone         text not null,
  email         text not null,
  town_text     text,
  category_id   uuid references public.categories (id) on delete set null,
  message       text,
  status        public.lead_status not null default 'new',
  admin_notes   text,
  ip_hash       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint leads_email_format check (email ~* '^[^@\s]+@[^@\s.]+\.[a-z]{2,}$' and length(email) <= 254),
  constraint leads_name_len     check (length(btrim(business_name)) between 1 and 120),
  constraint leads_contact_len  check (length(btrim(contact_name)) between 1 and 120),
  constraint leads_message_len  check (message is null or length(message) <= 2000)
);

create index if not exists leads_status_idx on public.merchant_leads (status, created_at desc);

-- ---------------------------------------------------------------------
-- events — the raw activity log behind merchant reporting.
-- No IP address is stored, ever. session_hash is a salted one-way digest
-- computed server-side; the salt rotates daily so the hash cannot be used
-- to follow one person across days.
-- ---------------------------------------------------------------------

create table if not exists public.events (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  event_type   public.event_type not null,
  merchant_id  uuid references public.merchants (id) on delete cascade,
  deal_id      uuid references public.deals (id) on delete cascade,
  town_id      uuid references public.towns (id) on delete set null,
  session_hash text,
  source       text,
  path         text,
  is_bot       boolean not null default false,

  constraint events_source_len check (source is null or length(source) <= 60),
  constraint events_path_len   check (path is null or length(path) <= 300)
);

create index if not exists events_merchant_time_idx on public.events (merchant_id, occurred_at desc) where is_bot = false;
create index if not exists events_time_idx          on public.events (occurred_at desc);
create index if not exists events_dedupe_idx        on public.events (event_type, merchant_id, session_hash, occurred_at desc);

-- ---------------------------------------------------------------------
-- event_daily — the rollup every report reads.
-- Reports never scan the raw events table, so merchant reporting stays
-- fast whether there are ten thousand rows or ten million.
-- ---------------------------------------------------------------------

create table if not exists public.event_daily (
  day         date not null,
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  deal_id     uuid references public.deals (id) on delete cascade,
  deal_key    uuid generated always as (coalesce(deal_id, '00000000-0000-0000-0000-000000000000'::uuid)) stored,
  event_type  public.event_type not null,
  event_count integer not null default 0,
  unique_sessions integer not null default 0,

  constraint event_daily_count_nonneg check (event_count >= 0 and unique_sessions >= 0)
);

create unique index if not exists event_daily_unique
  on public.event_daily (day, merchant_id, deal_key, event_type);
create index if not exists event_daily_merchant_idx
  on public.event_daily (merchant_id, day desc);

-- ---------------------------------------------------------------------
-- rate_limits — fixed-window counters for the public Netlify Functions.
-- Kept in Postgres rather than adding a Redis vendor for three forms.
-- ---------------------------------------------------------------------

create table if not exists public.rate_limits (
  bucket_key   text not null,
  window_start timestamptz not null,
  hit_count    integer not null default 0,
  primary key (bucket_key, window_start)
);

create index if not exists rate_limits_window_idx on public.rate_limits (window_start);

-- ---------------------------------------------------------------------
-- audit_log — who changed what, and what it looked like before.
-- This is the safety net behind "build guardrails so I cannot easily
-- destroy the website": every write is recoverable from the before image.
-- ---------------------------------------------------------------------

create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid references public.profiles (id) on delete set null,
  action      text not null,
  entity_type text not null,
  entity_id   uuid,
  before_data jsonb,
  after_data  jsonb,

  constraint audit_action_allow check (action in ('insert', 'update', 'delete'))
);

create index if not exists audit_entity_idx on public.audit_log (entity_type, entity_id, occurred_at desc);
create index if not exists audit_time_idx   on public.audit_log (occurred_at desc);

-- =====================================================================
-- Triggers
-- =====================================================================

-- updated_at maintenance
do $$
declare t text;
begin
  foreach t in array array[
    'towns','categories','merchants','deals','site_settings','content_blocks',
    'nav_items','subscribers','merchant_leads'
  ] loop
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Slug autofill with collision handling.
-- The admin can leave the slug blank and get a clean, unique URL. If two
-- merchants share a name the second becomes name-2, never a save error.
-- ---------------------------------------------------------------------

create or replace function public.merchants_fill_slug()
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
    if base = '' then base := 'business'; end if;
    candidate := base;
    while exists (
      select 1 from public.merchants m
      where lower(m.slug) = lower(candidate) and m.id is distinct from new.id
    ) loop
      n := n + 1;
      candidate := base || '-' || n;
    end loop;
    new.slug := candidate;
  end if;

  new.phone_e164 := coalesce(public.normalize_phone(new.phone_display), new.phone_e164);

  if new.status = 'active' and new.published_at is null then
    new.published_at := now();
  end if;

  if new.status = 'archived' and new.archived_at is null then
    new.archived_at := now();
  elsif new.status <> 'archived' then
    new.archived_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists merchants_before_write on public.merchants;
create trigger merchants_before_write
  before insert or update on public.merchants
  for each row execute function public.merchants_fill_slug();

create or replace function public.deals_fill_slug()
returns trigger
language plpgsql
as $$
declare
  base text;
  candidate text;
  n integer := 1;
begin
  if new.slug is null or btrim(new.slug) = '' then
    base := public.slugify(new.headline);
    if base = '' then base := 'deal'; end if;
    base := left(base, 60);
    candidate := base;
    while exists (
      select 1 from public.deals d
      where d.merchant_id = new.merchant_id
        and lower(d.slug) = lower(candidate)
        and d.id is distinct from new.id
    ) loop
      n := n + 1;
      candidate := base || '-' || n;
    end loop;
    new.slug := candidate;
  end if;
  return new;
end;
$$;

drop trigger if exists deals_before_write on public.deals;
create trigger deals_before_write
  before insert or update on public.deals
  for each row execute function public.deals_fill_slug();

-- ---------------------------------------------------------------------
-- Tier entitlement enforcement.
-- The plan sheet sells 2 deals on Standard and 3 on Pro/Premium. In the
-- old site nothing enforced that, so Standard merchants were shown one
-- deal and Pro merchants got nothing extra. This makes the sold
-- entitlement the actual system behaviour, and refuses the write with a
-- message that tells you exactly what to do instead.
-- ---------------------------------------------------------------------

create or replace function public.deal_limit_for_tier(t public.merchant_tier)
returns integer
language sql
immutable
as $$
  select case t when 'standard' then 2 when 'pro' then 3 when 'premium' then 3 end;
$$;

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
  if new.status <> 'active' then
    return new;
  end if;

  select tier, name into m_tier, m_name
  from public.merchants where id = new.merchant_id;

  cap := public.deal_limit_for_tier(m_tier);

  select count(*) into live_count
  from public.deals d
  where d.merchant_id = new.merchant_id
    and d.status = 'active'
    and d.id is distinct from new.id;

  if live_count + 1 > cap then
    raise exception
      '% is on the % plan, which includes % active deal(s). Pause an existing deal or upgrade the plan.',
      m_name, m_tier, cap
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists deals_tier_limit on public.deals;
create trigger deals_tier_limit
  before insert or update on public.deals
  for each row execute function public.enforce_deal_tier_limit();

-- ---------------------------------------------------------------------
-- Protect system rows from deletion.
-- The header, footer and core content blocks cannot be deleted, only
-- deactivated. This is the difference between a bad click costing you a
-- minute and costing you the navigation.
-- ---------------------------------------------------------------------

create or replace function public.block_system_delete()
returns trigger
language plpgsql
as $$
begin
  if old.is_system then
    raise exception 'This is a required site element and cannot be deleted. Turn it off instead.'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['badges','site_settings','content_blocks','nav_items'] loop
    execute format('drop trigger if exists protect_system_rows on public.%I', t);
    execute format(
      'create trigger protect_system_rows before delete on public.%I
       for each row execute function public.block_system_delete()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Merchants and deals are archived, never deleted.
-- Hard deletes would orphan historical analytics and break any link a
-- merchant already put on Facebook or a printed flyer.
-- ---------------------------------------------------------------------

create or replace function public.block_hard_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Records here are archived, not deleted, so past reports and shared links keep working. Set the status to Archived.'
    using errcode = 'check_violation';
  return null;
end;
$$;

drop trigger if exists merchants_no_hard_delete on public.merchants;
create trigger merchants_no_hard_delete
  before delete on public.merchants
  for each row execute function public.block_hard_delete();

drop trigger if exists deals_no_hard_delete on public.deals;
create trigger deals_no_hard_delete
  before delete on public.deals
  for each row execute function public.block_hard_delete();

-- ---------------------------------------------------------------------
-- Audit trail on the tables worth recovering
-- ---------------------------------------------------------------------

create or replace function public.write_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_log (actor_id, action, entity_type, entity_id, before_data, after_data)
  values (
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce((to_jsonb(new) ->> 'id')::uuid, (to_jsonb(old) ->> 'id')::uuid),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['merchants','deals','content_blocks','nav_items','site_settings','towns','categories'] loop
    execute format('drop trigger if exists write_audit on public.%I', t);
    execute format(
      'create trigger write_audit after insert or update or delete on public.%I
       for each row execute function public.write_audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Email addresses are stored lowercase so uniqueness is a plain column
-- constraint. Without this, Bob@x.com and bob@x.com are two subscribers.
-- ---------------------------------------------------------------------

create or replace function public.lowercase_email()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

drop trigger if exists lowercase_email on public.subscribers;
create trigger lowercase_email before insert or update on public.subscribers
  for each row execute function public.lowercase_email();

drop trigger if exists lowercase_email on public.merchant_leads;
create trigger lowercase_email before insert or update on public.merchant_leads
  for each row execute function public.lowercase_email();
