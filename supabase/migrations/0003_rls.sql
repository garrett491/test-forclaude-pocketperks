-- =====================================================================
-- Pocket Perks — 0003 Row Level Security
--
-- Security model in one paragraph:
--   * anon (the public website) can SELECT published content and nothing
--     else. It has no INSERT, UPDATE or DELETE anywhere in the database.
--   * authenticated + a row in profiles = administrator, full content CRUD.
--   * Everything the public "writes" (signups, leads, analytics) goes
--     through a Netlify Function holding the service-role key, which is
--     where validation, rate limiting and bot filtering live.
--
-- The anon key is published in the browser bundle. That is expected and
-- safe: these policies, not the key, are the security boundary. Someone
-- reading the page source gains exactly the read access they already had
-- by looking at the website.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper: is the caller an authorised administrator?
-- security definer so the policy can read profiles without the caller
-- needing select rights on it. search_path is pinned to defeat
-- search-path hijacking, which is the standard attack on definer functions.
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid()
  );
$$;

comment on function public.is_admin() is
  'True when the current JWT belongs to a row in public.profiles. Membership in profiles IS the grant of admin rights; there is no public signup path into it.';

alter table public.profiles       enable row level security;
alter table public.towns          enable row level security;
alter table public.categories     enable row level security;
alter table public.badges         enable row level security;
alter table public.media          enable row level security;
alter table public.merchants      enable row level security;
alter table public.merchant_hours enable row level security;
alter table public.deals          enable row level security;
alter table public.site_settings  enable row level security;
alter table public.content_blocks enable row level security;
alter table public.nav_items      enable row level security;
alter table public.subscribers    enable row level security;
alter table public.merchant_leads enable row level security;
alter table public.events         enable row level security;
alter table public.event_daily    enable row level security;
alter table public.rate_limits    enable row level security;
alter table public.audit_log      enable row level security;

-- Force RLS so even the table owner is subject to policy. Prevents a
-- future definer function from quietly bypassing these rules.
alter table public.subscribers    force row level security;
alter table public.merchant_leads force row level security;
alter table public.events         force row level security;
alter table public.audit_log      force row level security;

-- ---------------------------------------------------------------------
-- Baseline grants. Nothing is granted to anon that a policy does not
-- also permit, but revoking first means a future table added without a
-- policy is closed by default rather than open.
-- ---------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant usage on schema public to anon, authenticated;

grant select on
  public.towns, public.categories, public.badges, public.media,
  public.merchants, public.merchant_hours, public.deals,
  public.site_settings, public.content_blocks, public.nav_items
to anon, authenticated;

grant select, insert, update, delete on
  public.towns, public.categories, public.badges, public.media,
  public.merchants, public.merchant_hours, public.deals,
  public.site_settings, public.content_blocks, public.nav_items,
  public.subscribers, public.merchant_leads
to authenticated;

grant select on public.events, public.event_daily, public.audit_log, public.profiles to authenticated;

grant execute on function public.is_admin()        to anon, authenticated;
grant execute on function public.slugify(text)     to authenticated;
grant execute on function public.normalize_phone(text) to authenticated;
grant execute on function public.deal_limit_for_tier(public.merchant_tier) to authenticated;

-- =====================================================================
-- profiles
-- =====================================================================

drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

-- No insert/update/delete policy at all: the admin roster is managed in
-- the Supabase dashboard, so a compromised admin session cannot mint
-- additional administrators.

-- =====================================================================
-- Reference data — towns, categories, badges
-- =====================================================================

drop policy if exists towns_public_read on public.towns;
create policy towns_public_read on public.towns
  for select to anon, authenticated
  using (is_active or public.is_admin());

drop policy if exists towns_admin_write on public.towns;
create policy towns_admin_write on public.towns
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists categories_public_read on public.categories;
create policy categories_public_read on public.categories
  for select to anon, authenticated
  using (is_active or public.is_admin());

drop policy if exists categories_admin_write on public.categories;
create policy categories_admin_write on public.categories
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists badges_public_read on public.badges;
create policy badges_public_read on public.badges
  for select to anon, authenticated
  using (is_active or public.is_admin());

drop policy if exists badges_admin_write on public.badges;
create policy badges_admin_write on public.badges
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- media
-- Readable by anyone (the files are served publicly from Storage anyway),
-- writable only by admins.
-- =====================================================================

drop policy if exists media_public_read on public.media;
create policy media_public_read on public.media
  for select to anon, authenticated using (true);

drop policy if exists media_admin_write on public.media;
create policy media_admin_write on public.media
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- merchants
-- =====================================================================

drop policy if exists merchants_public_read on public.merchants;
create policy merchants_public_read on public.merchants
  for select to anon, authenticated
  using (status = 'active' or public.is_admin());

drop policy if exists merchants_admin_write on public.merchants;
create policy merchants_admin_write on public.merchants
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists merchant_hours_public_read on public.merchant_hours;
create policy merchant_hours_public_read on public.merchant_hours
  for select to anon, authenticated
  using (
    public.is_admin() or exists (
      select 1 from public.merchants m
      where m.id = merchant_hours.merchant_id and m.status = 'active'
    )
  );

drop policy if exists merchant_hours_admin_write on public.merchant_hours;
create policy merchant_hours_admin_write on public.merchant_hours
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- deals
-- A deal is public only when it is active, its merchant is active, and
-- the current time falls inside its scheduled window. Expiry is therefore
-- a property of the database, not something a cron job has to remember to
-- do or an admin has to notice.
-- =====================================================================

drop policy if exists deals_public_read on public.deals;
create policy deals_public_read on public.deals
  for select to anon, authenticated
  using (
    public.is_admin() or (
      status = 'active'
      and (starts_at is null or starts_at <= now())
      and (ends_at   is null or ends_at   >  now())
      and exists (
        select 1 from public.merchants m
        where m.id = deals.merchant_id and m.status = 'active'
      )
    )
  );

drop policy if exists deals_admin_write on public.deals;
create policy deals_admin_write on public.deals
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- Editable site content
-- =====================================================================

drop policy if exists site_settings_public_read on public.site_settings;
create policy site_settings_public_read on public.site_settings
  for select to anon, authenticated
  using (is_public or public.is_admin());

drop policy if exists site_settings_admin_write on public.site_settings;
create policy site_settings_admin_write on public.site_settings
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists content_blocks_public_read on public.content_blocks;
create policy content_blocks_public_read on public.content_blocks
  for select to anon, authenticated
  using (
    public.is_admin() or (
      is_active
      and (starts_at is null or starts_at <= now())
      and (ends_at   is null or ends_at   >  now())
    )
  );

drop policy if exists content_blocks_admin_write on public.content_blocks;
create policy content_blocks_admin_write on public.content_blocks
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists nav_items_public_read on public.nav_items;
create policy nav_items_public_read on public.nav_items
  for select to anon, authenticated
  using (is_active or public.is_admin());

drop policy if exists nav_items_admin_write on public.nav_items;
create policy nav_items_admin_write on public.nav_items
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- Private tables — admin read, no anon access whatsoever.
-- Writes arrive only via the service role, which bypasses RLS by design.
-- =====================================================================

drop policy if exists subscribers_admin_all on public.subscribers;
create policy subscribers_admin_all on public.subscribers
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists leads_admin_all on public.merchant_leads;
create policy leads_admin_all on public.merchant_leads
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists events_admin_read on public.events;
create policy events_admin_read on public.events
  for select to authenticated using (public.is_admin());

drop policy if exists event_daily_admin_read on public.event_daily;
create policy event_daily_admin_read on public.event_daily
  for select to authenticated using (public.is_admin());

drop policy if exists audit_admin_read on public.audit_log;
create policy audit_admin_read on public.audit_log
  for select to authenticated using (public.is_admin());

-- rate_limits deliberately has RLS enabled and zero policies: it is
-- reachable only by the service role inside a Netlify Function.

-- =====================================================================
-- Default privileges for anything added later
-- =====================================================================

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
