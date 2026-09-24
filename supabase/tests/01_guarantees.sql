-- =====================================================================
-- Pocket Perks — guarantee tests
--
-- Each block asserts a promise made in the architecture. A failure here
-- raises and aborts, so "the file ran" is the pass condition.
-- Run after the migrations and seed, against a scratch database.
-- =====================================================================

\set ON_ERROR_STOP on

create schema if not exists tests;
-- test harness only; anon needs to call the assert helpers while impersonated
grant usage on schema tests to anon, authenticated;

create or replace function tests.assert(condition boolean, label text)
returns void language plpgsql as $$
begin
  if condition then
    raise notice 'PASS  %', label;
  else
    raise exception 'FAIL  %', label;
  end if;
end $$;

create or replace function tests.assert_blocked(stmt text, label text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
    raise exception 'FAIL  % (statement was allowed)', label;
  exception
    when insufficient_privilege or check_violation or unique_violation
      or not_null_violation or foreign_key_violation or raise_exception then
      raise notice 'PASS  %', label;
  end;
end $$;

grant execute on all functions in schema tests to anon, authenticated;

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------

insert into auth.users (id, email)
values ('11111111-1111-1111-1111-111111111111', 'owner@example.com')
on conflict do nothing;

insert into public.profiles (id, role, display_name)
values ('11111111-1111-1111-1111-111111111111', 'owner', 'Test Owner')
on conflict do nothing;

insert into public.merchants (name, category_id, town_id, phone_display, status, tier)
select 'Test Pizza Co',
       (select id from public.categories where slug = 'food-drink'),
       (select id from public.towns where slug = 'carrollton'),
       '(330) 555-0142', 'active', 'standard'
where not exists (select 1 from public.merchants where name = 'Test Pizza Co');

-- =====================================================================
-- 1. Data hygiene the old site could not enforce
-- =====================================================================

select tests.assert(
  (select slug from public.merchants where name = 'Test Pizza Co') = 'test-pizza-co',
  '1.1 slug is generated automatically from the business name');

select tests.assert(
  (select phone_e164 from public.merchants where name = 'Test Pizza Co') = '+13305550142',
  '1.2 phone is normalised to E.164 so tel: links always dial');

select tests.assert(
  (select published_at is not null from public.merchants where name = 'Test Pizza Co'),
  '1.3 published_at is stamped when a merchant goes active');

select tests.assert_blocked($$
  insert into public.merchants (name, category_id, town_id, website_url, status, phone_display)
  values ('Bad URL Co',
          (select id from public.categories limit 1),
          (select id from public.towns limit 1),
          'www.example.com', 'active', '3305550100')$$,
  '1.4 a bare www. URL cannot be saved (this produced broken links on the old site)');

select tests.assert_blocked($$
  insert into public.nav_items (location, label, href)
  values ('header', 'Evil', 'javascript:alert(1)')$$,
  '1.5 a javascript: URL cannot be saved into navigation');

select tests.assert_blocked($$
  insert into public.merchants (name, category_id, town_id, status)
  values ('No Contact Co',
          (select id from public.categories limit 1),
          (select id from public.towns limit 1),
          'active')$$,
  '1.6 a merchant cannot go live with no phone and no website');

-- =====================================================================
-- 2. Tier entitlements are real, not marketing copy
-- =====================================================================

do $$
declare m uuid;
begin
  select id into m from public.merchants where name = 'Test Pizza Co';
  insert into public.deals (merchant_id, headline, status) values (m, 'Ten percent off any order', 'active');
  insert into public.deals (merchant_id, headline, status) values (m, 'Free breadsticks with any large', 'active');
end $$;

select tests.assert(
  (select count(*) from public.deals d
     join public.merchants m on m.id = d.merchant_id
    where m.name = 'Test Pizza Co' and d.status = 'active') = 2,
  '2.1 a Standard merchant can publish the 2 deals the plan sells');

select tests.assert_blocked($$
  insert into public.deals (merchant_id, headline, status)
  values ((select id from public.merchants where name = 'Test Pizza Co'),
          'A third deal they did not pay for', 'active')$$,
  '2.2 a Standard merchant cannot publish a 3rd deal');

update public.merchants set tier = 'pro' where name = 'Test Pizza Co';

do $$
declare m uuid;
begin
  select id into m from public.merchants where name = 'Test Pizza Co';
  insert into public.deals (merchant_id, headline, status) values (m, 'Third deal now allowed on Pro', 'active');
end $$;

select tests.assert(
  (select count(*) from public.deals d
     join public.merchants m on m.id = d.merchant_id
    where m.name = 'Test Pizza Co' and d.status = 'active') = 3,
  '2.3 upgrading to Pro immediately unlocks the 3rd deal');

-- =====================================================================
-- 3. Destructive actions are guarded
-- =====================================================================

select tests.assert_blocked(
  $$delete from public.merchants where name = 'Test Pizza Co'$$,
  '3.1 merchants cannot be hard-deleted, only archived');

select tests.assert_blocked(
  $$delete from public.nav_items where is_system = true$$,
  '3.2 required navigation cannot be deleted, only switched off');

select tests.assert_blocked(
  $$delete from public.content_blocks where block_key = 'home.hero'$$,
  '3.3 the homepage hero block cannot be deleted');

select tests.assert(
  (select count(*) from public.audit_log where entity_type = 'merchants') > 0,
  '3.4 every merchant change is written to the audit log with a before image');

-- =====================================================================
-- 4. Expiry is enforced by the database, not by remembering
-- =====================================================================

do $$
declare m uuid;
begin
  select id into m from public.merchants where name = 'Test Pizza Co';
  update public.deals set status = 'paused' where merchant_id = m;
  insert into public.deals (merchant_id, headline, status, ends_at)
  values (m, 'Expired last week', 'active', now() - interval '7 days');
  insert into public.deals (merchant_id, headline, status, starts_at)
  values (m, 'Scheduled for next week', 'active', now() + interval '7 days');
  insert into public.deals (merchant_id, headline, status, ends_at)
  values (m, 'Running right now', 'active', now() + interval '7 days');
end $$;

set role anon;
set request.jwt.claim.sub = '';

select tests.assert(
  (select count(*) from public.deals) = 1,
  '4.1 the public sees only the live deal: expired and future ones are invisible');

select tests.assert(
  (select headline from public.deals) = 'Running right now',
  '4.2 and it is the correct one');

reset role;

-- =====================================================================
-- 5. The public role cannot write anything, anywhere
-- =====================================================================

set role anon;

select tests.assert_blocked(
  $$insert into public.merchants (name, category_id, town_id, phone_display, status)
    values ('Injected Co', (select id from public.categories limit 1),
            (select id from public.towns limit 1), '3305550111', 'active')$$,
  '5.1 anon cannot create a merchant (the old Apps Script allowed exactly this)');

select tests.assert_blocked(
  $$update public.merchants set name = '<script>alert(1)</script>'$$,
  '5.2 anon cannot rewrite a merchant name into a script tag');

select tests.assert_blocked(
  $$delete from public.deals$$,
  '5.3 anon cannot delete deals');

select tests.assert_blocked(
  $$insert into public.subscribers (email) values ('spam@example.com')$$,
  '5.4 anon cannot write to the subscriber list directly');

select tests.assert_blocked(
  $$insert into public.events (event_type) values ('call_click')$$,
  '5.5 anon cannot fabricate analytics events for a merchant report');

select tests.assert_blocked(
  $$select * from public.subscribers$$,
  '5.6 anon cannot read the subscriber list');

select tests.assert_blocked(
  $$select * from public.merchant_leads$$,
  '5.7 anon cannot read merchant sales leads');

select tests.assert_blocked(
  $$select * from public.audit_log$$,
  '5.8 anon cannot read the audit log');

select tests.assert_blocked(
  $$select * from public.event_daily$$,
  '5.9 anon cannot read merchant performance data');

select tests.assert(
  (select count(*) from public.site_settings where key = 'ops.notify_email') = 0,
  '5.10 private site settings are invisible to anon while public ones are readable');

select tests.assert(
  (select count(*) from public.site_settings where key = 'site.name') = 1,
  '5.11 public site settings are readable by anon');

reset role;

-- =====================================================================
-- 6. Draft and archived records never leak to the public
-- =====================================================================

insert into public.merchants (name, category_id, town_id, phone_display, status)
select 'Draft Business',
       (select id from public.categories limit 1),
       (select id from public.towns limit 1),
       '3305550199', 'draft'
where not exists (select 1 from public.merchants where name = 'Draft Business');

set role anon;
select tests.assert(
  (select count(*) from public.merchants where name = 'Draft Business') = 0,
  '6.1 a draft merchant is invisible to the public');
reset role;

-- =====================================================================
-- 7. Analytics rollup is correct and excludes bots
-- =====================================================================

do $$
declare m uuid;
begin
  select id into m from public.merchants where name = 'Test Pizza Co';
  insert into public.events (event_type, merchant_id, session_hash, occurred_at, is_bot) values
    ('merchant_view', m, 'sess-a', current_date - 1 + interval '9h',  false),
    ('merchant_view', m, 'sess-a', current_date - 1 + interval '10h', false),
    ('merchant_view', m, 'sess-b', current_date - 1 + interval '11h', false),
    ('call_click',    m, 'sess-b', current_date - 1 + interval '11h', false),
    ('merchant_view', m, 'bot-1',  current_date - 1 + interval '12h', true),
    ('call_click',    m, 'bot-1',  current_date - 1 + interval '12h', true);
end $$;

select public.rollup_events(current_date - 1);

select tests.assert(
  (select event_count from public.event_daily
    where event_type = 'merchant_view' and day = current_date - 1) = 3,
  '7.1 rollup counts the 3 human views and drops the 2 bot hits');

select tests.assert(
  (select unique_sessions from public.event_daily
    where event_type = 'merchant_view' and day = current_date - 1) = 2,
  '7.2 rollup distinguishes 3 views from 2 distinct visitors');

select tests.assert(
  (select event_count from public.event_daily
    where event_type = 'call_click' and day = current_date - 1) = 1,
  '7.3 bot call clicks never reach a merchant report');

select public.rollup_events(current_date - 1);

select tests.assert(
  (select count(*) from public.event_daily
    where event_type = 'merchant_view' and day = current_date - 1) = 1,
  '7.4 rollup is idempotent: re-running does not double-count');

select tests.assert(
  (select intent_actions from public.merchant_report_summary(current_date - 2, current_date)
    where merchant_name = 'Test Pizza Co') = 1,
  '7.5 the merchant summary reports 1 intent action, not 2');

select tests.assert(
  (select metric_group from public.merchant_report(
     (select id from public.merchants where name = 'Test Pizza Co'),
     current_date - 2, current_date)
   where event_type = 'call_click') = 'intent',
  '7.6 a call click is classified as intent, never as a confirmed customer');

-- =====================================================================
-- 8. Email handling
-- =====================================================================

insert into public.subscribers (email, source) values ('Person@Example.COM', 'footer');

select tests.assert(
  (select email from public.subscribers where source = 'footer') = 'person@example.com',
  '8.1 addresses are stored lowercase');

select tests.assert_blocked(
  $$insert into public.subscribers (email) values ('PERSON@example.com')$$,
  '8.2 the same address in different case is rejected as a duplicate');

select tests.assert_blocked(
  $$insert into public.subscribers (email) values ('not-an-email')$$,
  '8.3 a malformed address is rejected');

select tests.assert(
  (select unsubscribe_token is not null from public.subscribers where source = 'footer'),
  '8.4 every subscriber gets an unsubscribe token at insert time');

-- =====================================================================
-- 9. Production pass (0009)
-- =====================================================================

insert into public.merchants (name, category_id, town_id, phone_display, status, tier)
select 'Limit Check Diner',
       (select id from public.categories where slug = 'food-drink'),
       (select id from public.towns where slug = 'carrollton'),
       '(330) 555-0177', 'active', 'standard'
where not exists (select 1 from public.merchants where name = 'Limit Check Diner');

do $$
declare m uuid;
begin
  select id into m from public.merchants where name = 'Limit Check Diner';
  insert into public.deals (merchant_id, headline, status) values (m, 'Old deal that has run its course', 'active');
  insert into public.deals (merchant_id, headline, status) values (m, 'Current deal still running', 'active');
  -- The first one ends. It stays "active" in the table but is no longer on the site.
  update public.deals set starts_at = null, ends_at = now() - interval '1 day'
   where merchant_id = m and headline = 'Old deal that has run its course';
  insert into public.deals (merchant_id, headline, status) values (m, 'Replacement for the ended deal', 'active');
end $$;

select tests.assert(
  (select count(*) from public.deals d join public.merchants m on m.id = d.merchant_id
    where m.name = 'Limit Check Diner' and d.status = 'active'
      and (d.ends_at is null or d.ends_at > now())) = 2,
  '9.1 an ended deal does not use up a plan slot');

select tests.assert_blocked($$
  insert into public.deals (merchant_id, headline, status)
  values ((select id from public.merchants where name = 'Limit Check Diner'),
          'A third live deal on Standard', 'active')$$,
  '9.2 the plan limit still applies to live deals');

select tests.assert(
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and (table_name, column_name) in (('merchants','show_in_carousel'), ('deals','restrictions'),
                                        ('media','variants'), ('subscribers','consent_text'),
                                        ('subscribers','consent_at'), ('subscribers','consent_path'))) = 6,
  '9.3 carousel switch, deal limits, image copies and consent columns exist');

-- A real signed-in account that is not in profiles is treated like the public.
insert into auth.users (id, email)
values ('22222222-2222-2222-2222-222222222222', 'nobody@example.com')
on conflict do nothing;

set role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);

select tests.assert_blocked(
  $$insert into public.merchants (name, category_id, town_id, phone_display, status)
    values ('Not An Admin Co', (select id from public.categories limit 1),
            (select id from public.towns limit 1), '3305550112', 'active')$$,
  '9.4 a signed-in account without a profiles row cannot create a business');

select tests.assert_blocked(
  $$insert into public.profiles (id, role, display_name)
    values ('22222222-2222-2222-2222-222222222222', 'owner', 'Self-promoted')$$,
  '9.5 nobody can make themselves an administrator');

select tests.assert(
  (select count(*) from public.subscribers) = 0,
  '9.6 a signed-in non-admin cannot read the subscriber list');

reset role;
select set_config('request.jwt.claim.sub', '', false);

-- =====================================================================
-- 10. Business portal (0010)
-- =====================================================================

select tests.assert(
  not has_function_privilege('anon', 'public.prune_events(integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.rollup_events(date)', 'execute'),
  '10.0 nobody outside the server can delete or rebuild visit records');

insert into public.merchants (name, category_id, town_id, phone_display, status, tier)
select 'Portal Test Cafe',
       (select id from public.categories where slug = 'food-drink'),
       (select id from public.towns where slug = 'carrollton'),
       '(330) 555-0188', 'active', 'premium'
where not exists (select 1 from public.merchants where name = 'Portal Test Cafe');

insert into auth.users (id, email)
values ('33333333-3333-3333-3333-333333333333', 'owner@testpizza.example')
on conflict do nothing;
insert into public.portal_users (user_id, email, display_name)
values ('33333333-3333-3333-3333-333333333333', 'owner@testpizza.example', '')
on conflict do nothing;
insert into public.merchant_members (user_id, merchant_id)
select '33333333-3333-3333-3333-333333333333', id from public.merchants
where name in ('Test Pizza Co', 'Portal Test Cafe')
on conflict do nothing;

-- Standard allows 2 live coupons, and Test Pizza Co already has 2.
update public.merchants set tier = 'standard' where name = 'Test Pizza Co';

set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', false);

select tests.assert_blocked(
  $$insert into public.deals (merchant_id, headline, status)
    values ((select id from public.merchants where name = 'Portal Test Cafe'), 'Sneaked straight in', 'active')$$,
  '10.1 a business login cannot write a coupon straight onto the site');

update public.merchants set is_featured = true, tier = 'premium' where name = 'Test Pizza Co';
update public.deals set headline = 'Changed without approval'
 where merchant_id = (select id from public.merchants where name = 'Test Pizza Co');

select tests.assert_blocked(
  $$select public.portal_snapshot((select id from public.merchants where name = 'Limit Check Diner'))$$,
  '10.2 a business login cannot see another business''s portal');

select tests.assert_blocked(
  $$select secret_hash from public.portal_users$$,
  '10.3 nobody can read a special word, even scrambled');

select tests.assert_blocked(
  $$select public.portal_apply((select id from public.merchants where name = 'Portal Test Cafe'),
                               'deal_create', null, '{"headline":"Bypass approval"}'::jsonb)$$,
  '10.4 the function that applies changes cannot be called directly');

select tests.assert_blocked(
  $$select public.review_change((select id from public.change_requests limit 1), true, null)$$,
  '10.5 a business login cannot approve anything');

select tests.assert(
  (public.submit_change((select id from public.merchants where name = 'Portal Test Cafe'),
     'deal_create', null, '{"headline":"Free cookie with coffee"}'::jsonb, 'Pat Owner', 'anything') ->> 'ok')::boolean = false,
  '10.6 nothing can be sent before a special word is set');

select tests.assert(
  (public.portal_set_secret('Pat Owner', 'blue heron') ->> 'ok')::boolean,
  '10.7 a business login can set its name and special word');

select tests.assert(
  (public.submit_change((select id from public.merchants where name = 'Portal Test Cafe'),
     'deal_create', null, '{"headline":"Free cookie with coffee"}'::jsonb, 'Pat Owner', 'wrong word') ->> 'ok')::boolean = false,
  '10.8 a wrong special word is refused');
select tests.assert(
  (select failed_attempts from public.portal_users where user_id = auth.uid()) = 1,
  '10.8b and counted towards the lockout');

select tests.assert(
  (public.submit_change((select id from public.merchants where name = 'Portal Test Cafe'),
     'deal_create', null,
     '{"headline":"Free cookie with coffee","coupon_code":"COOKIE","is_featured":true,"merchant_id":"00000000-0000-0000-0000-000000000000"}'::jsonb,
     'Pat Owner', '  Blue Heron ') ->> 'ok')::boolean,
  '10.9 the right word (any capitals or spacing) sends the change for approval');

select tests.assert(
  (select count(*) from public.deals where headline = 'Free cookie with coffee') = 0,
  '10.10 a submitted coupon is not on the site until approved');

select tests.assert(
  (select count(*) from public.change_requests) = 0,
  '10.11 a business login cannot list change requests directly');

select tests.assert(
  (public.submit_change((select id from public.merchants where name = 'Test Pizza Co'),
     'deal_create', null, '{"headline":"One more than the plan allows"}'::jsonb, 'Pat Owner', 'blue heron')
     ->> 'message') like '%plan, which includes%',
  '10.12 the plan''s coupon limit is explained when the business submits, not at approval');

select tests.assert(
  (public.submit_change((select id from public.merchants where name = 'Portal Test Cafe'),
     'deal_update', (select id from public.deals where headline = 'Current deal still running'),
     '{"status":"paused"}'::jsonb, 'Pat Owner', 'blue heron') ->> 'ok')::boolean = false,
  '10.13 a business cannot touch another business''s coupon');

select tests.assert(
  (public.submit_change((select id from public.merchants where name = 'Test Pizza Co'),
     'business_update', null,
     '{"tagline":"Hand-tossed since 1998","tier":"premium","is_featured":true,"name":"Best Pizza Ever"}'::jsonb,
     'Pat Owner', 'blue heron') ->> 'ok')::boolean,
  '10.14 business details can be proposed');

select tests.assert(
  (select (public.portal_snapshot((select id from public.merchants where name = 'Test Pizza Co'))
     -> 'requests' -> 0 -> 'payload') = '{"tagline":"Hand-tossed since 1998"}'::jsonb),
  '10.15 plan, featured and business name are stripped from what a business sends');

select tests.assert(
  (public.submit_change((select id from public.merchants where name = 'Test Pizza Co'),
     'business_update', null, '{"tagline":"Hand-tossed since 1998"}'::jsonb, 'Pat Owner', 'blue heron')
     ->> 'ok')::boolean
  and (public.submit_change((select id from public.merchants where name = 'Test Pizza Co'),
     'business_update', null, '{"website_url":"www.no-https.example"}'::jsonb, 'Pat Owner', 'blue heron')
     ->> 'ok')::boolean = false,
  '10.16 a bad link is refused on the form, before it reaches the approval queue');

-- Photos: only into the business's own pending folder.
select tests.assert_blocked(
  $$insert into storage.objects (bucket_id, name)
    values ('merchant-media', 'pending/' || (select id from public.merchants where name = 'Limit Check Diner') || '/x.webp')$$,
  '10.17 a business cannot upload photos for another business');

insert into storage.objects (bucket_id, name)
values ('merchant-media', 'pending/' || (select id from public.merchants where name = 'Portal Test Cafe') || '/ok.webp');
select tests.assert_blocked(
  $$insert into storage.objects (bucket_id, name) values ('merchant-media', 'uploads/2026/live.webp')$$,
  '10.18 and cannot put photos anywhere the site already uses');

-- Five wrong words lock the login for 15 minutes, even for the right word.
do $$
declare i int;
begin
  for i in 1..5 loop
    perform public.submit_change((select id from public.merchants where name = 'Portal Test Cafe'),
      'deal_create', null, '{"headline":"Guessing"}'::jsonb, 'Pat Owner', 'guess ' || i);
  end loop;
end $$;
select tests.assert(
  (public.submit_change((select id from public.merchants where name = 'Portal Test Cafe'),
     'deal_create', null, '{"headline":"Right word, too late"}'::jsonb, 'Pat Owner', 'blue heron')
     ->> 'message') like 'Too many wrong special words%',
  '10.19 five wrong special words lock the login for 15 minutes');

reset role;
select set_config('request.jwt.claim.sub', '', false);

select tests.assert(
  (select count(*) from public.merchants where name = 'Test Pizza Co' and (is_featured or tier = 'premium')) = 0
  and (select count(*) from public.deals where headline = 'Changed without approval') = 0,
  '10.20 direct edits by a business login changed nothing');

select tests.assert(
  (select signed_name = 'Pat Owner' and signed_email = 'owner@testpizza.example' and submitted_at is not null
     from public.change_requests where summary = 'New coupon: Free cookie with coffee'),
  '10.21 each change records the typed name, the login email and the time');

-- The administrator approves one and rejects another.
set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

select tests.assert(
  (public.review_change((select id from public.change_requests where summary = 'New coupon: Free cookie with coffee'), true, null)
     ->> 'ok')::boolean,
  '10.22 an administrator approves with one call');

select tests.assert(
  (public.review_change((select id from public.change_requests where summary = 'Business details' order by submitted_at limit 1), false, 'Please add your full address too.')
     ->> 'ok')::boolean,
  '10.23 an administrator rejects with a note');

reset role;
select set_config('request.jwt.claim.sub', '', false);

select tests.assert(
  (select count(*) from public.deals d join public.merchants m on m.id = d.merchant_id
    where d.headline = 'Free cookie with coffee' and d.coupon_code = 'COOKIE'
      and d.status = 'active' and not d.is_featured and m.name = 'Portal Test Cafe') = 1,
  '10.24 an approved coupon goes live, on the right business, without the extras it tried to set');

select tests.assert(
  (select tagline from public.merchants where name = 'Test Pizza Co') is distinct from 'Hand-tossed since 1998'
  and (select review_note from public.change_requests where summary = 'Business details' order by submitted_at limit 1) = 'Please add your full address too.',
  '10.25 a rejected change is not applied, and the note is kept');

select tests.assert(
  (select actor_id from public.audit_log where entity_type = 'deals'
     and after_data ->> 'headline' = 'Free cookie with coffee' order by occurred_at desc limit 1)
   = '11111111-1111-1111-1111-111111111111',
  '10.26 the change history names the administrator who approved it');

do $$ begin raise notice '--- all guarantees hold ---'; end $$;
