-- =====================================================================
-- Pocket Perks — 0010 Business portal
--
-- Lets a business sign in and propose changes to its own listing:
-- new coupons, coupon edits (including ending one), business details,
-- opening hours and photos. Nothing a business submits touches the live
-- site. Every submission waits in change_requests until an administrator
-- approves it, and only then is it applied — by the database, as the
-- administrator.
--
-- Security model, in one paragraph:
--   * A business login is an auth.users account with a row in
--     portal_users and one or more rows in merchant_members. It has NO
--     profiles row, so every existing policy treats it exactly like the
--     public: it can read what the website shows and write nothing.
--   * The only things a business login can do are call the functions
--     below. Each one checks membership of that particular business
--     itself, so one business can never read or change another's data,
--     whatever the website code does.
--   * Every submission is signed: the typed name, the account's email,
--     the time, and the person's special word, which is checked here
--     against a bcrypt hash. Five wrong words lock that login for
--     15 minutes.
--
-- Additive and safe to run more than once. Requires 0009.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Housekeeping functions are not for the public.
-- rollup_events and prune_events run as the database owner. Supabase
-- grants EXECUTE on new functions to anon and authenticated by default,
-- which meant anyone holding the public key could call
-- prune_events(0) and delete every raw visit record. They are run by
-- pg_cron (as the owner) or a server job (service role), never a browser.
-- ---------------------------------------------------------------------

revoke all on function public.rollup_events(date)  from public, anon, authenticated;
revoke all on function public.prune_events(integer) from public, anon, authenticated;
grant execute on function public.rollup_events(date)  to service_role;
grant execute on function public.prune_events(integer) to service_role;

-- ---------------------------------------------------------------------
-- 2. The audit trail records administrators only.
-- audit_log.actor_id references profiles. Changes a business proposes
-- are applied by an administrator's approval, so the actor is always an
-- administrator; anything else (a server job, a dry run of a business's
-- submission) is recorded with no actor instead of failing.
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
    (select p.id from public.profiles p where p.id = auth.uid()),
    lower(tg_op),
    tg_table_name,
    coalesce((to_jsonb(new) ->> 'id')::uuid, (to_jsonb(old) ->> 'id')::uuid),
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
    case when tg_op in ('UPDATE', 'INSERT') then to_jsonb(new) end
  );
  return coalesce(new, old);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------

-- One row per person who can sign in to the business portal.
create table if not exists public.portal_users (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  display_name    text not null default '',
  email           text not null,
  secret_hash     text,
  secret_set_at   timestamptz,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  created_by      uuid references public.profiles (id) on delete set null,

  constraint portal_users_name_len  check (length(display_name) <= 80),
  constraint portal_users_email_len check (length(email) between 3 and 254)
);

-- Which businesses each person may propose changes for.
create table if not exists public.merchant_members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.portal_users (user_id) on delete cascade,
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null,

  constraint merchant_members_unique unique (user_id, merchant_id)
);

create index if not exists merchant_members_merchant_idx on public.merchant_members (merchant_id);

-- Every proposed change, who signed it, and what happened to it.
create table if not exists public.change_requests (
  id            uuid primary key default gen_random_uuid(),
  merchant_id   uuid not null references public.merchants (id) on delete cascade,
  deal_id       uuid references public.deals (id) on delete set null,
  kind          text not null,
  summary       text not null,
  payload       jsonb not null,
  before_data   jsonb,

  submitted_by  uuid references auth.users (id) on delete set null,
  signed_name   text not null,
  signed_email  text not null,
  submitted_at  timestamptz not null default now(),

  status        text not null default 'pending',
  reviewed_at   timestamptz,
  reviewed_by   uuid references public.profiles (id) on delete set null,
  reviewer_name text,
  review_note   text,

  constraint change_requests_kind check (kind in (
    'deal_create', 'deal_update', 'business_update', 'hours_update', 'gallery_add', 'gallery_remove'
  )),
  constraint change_requests_status check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  constraint change_requests_name_len check (length(btrim(signed_name)) between 2 and 80),
  constraint change_requests_note_len check (review_note is null or length(review_note) <= 500),
  constraint change_requests_reviewed check ((status in ('pending', 'withdrawn')) = (reviewed_at is null))
);

create index if not exists change_requests_pending_idx
  on public.change_requests (submitted_at) where status = 'pending';
create index if not exists change_requests_merchant_idx
  on public.change_requests (merchant_id, submitted_at desc);

-- ---------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------

create or replace function public.pp_uuid_or_null(input text)
returns uuid
language plpgsql
immutable
as $$
begin
  return input::uuid;
exception when others then
  return null;
end;
$$;

-- True when the caller is an active portal login for this business.
create or replace function public.is_merchant_member(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.merchant_members mm
    join public.portal_users pu on pu.user_id = mm.user_id
    where mm.user_id = auth.uid()
      and mm.merchant_id = p_merchant_id
      and pu.is_active
  );
$$;

-- A photo a business uploaded for this business, waiting to be used.
create or replace function public.portal_media_ok(p_merchant_id uuid, p_media_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_media_id is null or exists (
    select 1 from public.media m
    where m.id = p_media_id
      and m.storage_path like 'pending/' || p_merchant_id::text || '/%'
  );
$$;

-- Blank text becomes NULL, as everywhere else in this schema.
create or replace function public.pp_text(p jsonb, key text)
returns text
language sql
immutable
as $$
  select nullif(btrim(p ->> key), '');
$$;

-- ---------------------------------------------------------------------
-- 5. Applying a change. Internal: never callable from outside.
-- Runs as the table owner, so every caller of this function must have
-- checked permission first. Table constraints and triggers (plan limits,
-- URL formats, date windows) still apply to everything it writes.
-- ---------------------------------------------------------------------

create or replace function public.portal_apply(
  p_merchant_id uuid,
  p_kind        text,
  p_deal_id     uuid,
  p_payload     jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  p   jsonb := coalesce(p_payload, '{}'::jsonb);
  new_id uuid;
  day jsonb;
begin
  if p_kind = 'deal_create' then
    insert into public.deals (
      merchant_id, headline, description, terms, restrictions, coupon_code,
      starts_at, ends_at, status
    ) values (
      p_merchant_id,
      coalesce(public.pp_text(p, 'headline'), ''),
      public.pp_text(p, 'description'),
      public.pp_text(p, 'terms'),
      public.pp_text(p, 'restrictions'),
      public.pp_text(p, 'coupon_code'),
      (public.pp_text(p, 'starts_at'))::timestamptz,
      (public.pp_text(p, 'ends_at'))::timestamptz,
      coalesce(public.pp_text(p, 'status'), 'active')::public.publish_status
    )
    returning id into new_id;
    return new_id;

  elsif p_kind = 'deal_update' then
    update public.deals d set
      headline     = case when p ? 'headline'     then coalesce(public.pp_text(p, 'headline'), '') else d.headline end,
      description  = case when p ? 'description'  then public.pp_text(p, 'description')  else d.description end,
      terms        = case when p ? 'terms'        then public.pp_text(p, 'terms')        else d.terms end,
      restrictions = case when p ? 'restrictions' then public.pp_text(p, 'restrictions') else d.restrictions end,
      coupon_code  = case when p ? 'coupon_code'  then public.pp_text(p, 'coupon_code')  else d.coupon_code end,
      starts_at    = case when p ? 'starts_at'    then (public.pp_text(p, 'starts_at'))::timestamptz else d.starts_at end,
      ends_at      = case when p ? 'ends_at'      then (public.pp_text(p, 'ends_at'))::timestamptz   else d.ends_at end,
      status       = case when p ? 'status'       then (public.pp_text(p, 'status'))::public.publish_status else d.status end
    where d.id = p_deal_id and d.merchant_id = p_merchant_id and d.status <> 'archived'
    returning d.id into new_id;
    if new_id is null then
      raise exception 'That coupon no longer exists.' using errcode = 'PP404';
    end if;
    return new_id;

  elsif p_kind = 'business_update' then
    if not public.portal_media_ok(p_merchant_id, public.pp_uuid_or_null(p ->> 'logo_media_id'))
       or not public.portal_media_ok(p_merchant_id, public.pp_uuid_or_null(p ->> 'cover_media_id')) then
      raise exception 'That photo was not uploaded for this business.' using errcode = 'PP403';
    end if;
    update public.merchants m set
      tagline        = case when p ? 'tagline'        then public.pp_text(p, 'tagline')        else m.tagline end,
      description    = case when p ? 'description'    then public.pp_text(p, 'description')    else m.description end,
      phone_display  = case when p ? 'phone_display'  then public.pp_text(p, 'phone_display')  else m.phone_display end,
      phone_e164     = case when p ? 'phone_display'  then public.normalize_phone(public.pp_text(p, 'phone_display')) else m.phone_e164 end,
      website_url    = case when p ? 'website_url'    then public.pp_text(p, 'website_url')    else m.website_url end,
      facebook_url   = case when p ? 'facebook_url'   then public.pp_text(p, 'facebook_url')   else m.facebook_url end,
      instagram_url  = case when p ? 'instagram_url'  then public.pp_text(p, 'instagram_url')  else m.instagram_url end,
      address_line1  = case when p ? 'address_line1'  then public.pp_text(p, 'address_line1')  else m.address_line1 end,
      address_line2  = case when p ? 'address_line2'  then public.pp_text(p, 'address_line2')  else m.address_line2 end,
      city           = case when p ? 'city'           then public.pp_text(p, 'city')           else m.city end,
      postal_code    = case when p ? 'postal_code'    then public.pp_text(p, 'postal_code')    else m.postal_code end,
      logo_media_id  = case when p ? 'logo_media_id'  then public.pp_uuid_or_null(p ->> 'logo_media_id')  else m.logo_media_id end,
      cover_media_id = case when p ? 'cover_media_id' then public.pp_uuid_or_null(p ->> 'cover_media_id') else m.cover_media_id end
    where m.id = p_merchant_id
    returning m.id into new_id;
    return new_id;

  elsif p_kind = 'hours_update' then
    delete from public.merchant_hours where merchant_id = p_merchant_id;
    for day in select * from jsonb_array_elements(coalesce(p -> 'days', '[]'::jsonb)) loop
      insert into public.merchant_hours (merchant_id, day_of_week, is_closed, opens_at, closes_at)
      values (
        p_merchant_id,
        (day ->> 'day')::smallint,
        coalesce((day ->> 'closed')::boolean, false),
        case when coalesce((day ->> 'closed')::boolean, false) then null else (nullif(day ->> 'opens', ''))::time end,
        case when coalesce((day ->> 'closed')::boolean, false) then null else (nullif(day ->> 'closes', ''))::time end
      );
    end loop;
    return p_merchant_id;

  elsif p_kind = 'gallery_add' then
    if not public.portal_media_ok(p_merchant_id, public.pp_uuid_or_null(p ->> 'media_id'))
       or public.pp_uuid_or_null(p ->> 'media_id') is null then
      raise exception 'That photo was not uploaded for this business.' using errcode = 'PP403';
    end if;
    insert into public.merchant_gallery (merchant_id, media_id, caption, sort_order)
    values (
      p_merchant_id,
      public.pp_uuid_or_null(p ->> 'media_id'),
      public.pp_text(p, 'caption'),
      coalesce((select max(sort_order) + 1 from public.merchant_gallery where merchant_id = p_merchant_id), 0)
    )
    returning id into new_id;
    return new_id;

  elsif p_kind = 'gallery_remove' then
    delete from public.merchant_gallery
    where id = public.pp_uuid_or_null(p ->> 'gallery_id') and merchant_id = p_merchant_id
    returning id into new_id;
    if new_id is null then
      raise exception 'That photo is no longer on the page.' using errcode = 'PP404';
    end if;
    return new_id;
  end if;

  raise exception 'Unknown kind of change.' using errcode = 'PP400';
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Business-facing functions
-- ---------------------------------------------------------------------

-- Who am I, and which businesses can I work on? NULL for anyone who is
-- not a portal login.
create or replace function public.portal_me()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'user_id',      pu.user_id,
    'display_name', pu.display_name,
    'email',        pu.email,
    'has_secret',   pu.secret_hash is not null,
    'is_active',    pu.is_active,
    'merchants', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'slug', m.slug) order by m.name)
      from public.merchant_members mm
      join public.merchants m on m.id = mm.merchant_id
      where mm.user_id = pu.user_id and m.status <> 'archived'
    ), '[]'::jsonb)
  )
  from public.portal_users pu
  where pu.user_id = auth.uid();
$$;

-- Set the name and special word, or change the word (which needs the old one).
create or replace function public.portal_set_secret(
  p_display_name text,
  p_new_secret   text,
  p_old_secret   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  me public.portal_users;
  word text := lower(btrim(coalesce(p_new_secret, '')));
begin
  select * into me from public.portal_users where user_id = auth.uid() and is_active;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'This account does not have access to the business portal.');
  end if;
  if length(btrim(coalesce(p_display_name, ''))) < 2 then
    return jsonb_build_object('ok', false, 'message', 'Type your name, as you would sign it.');
  end if;
  if length(word) < 4 or length(word) > 64 then
    return jsonb_build_object('ok', false, 'message', 'Your special word needs 4 to 64 characters.');
  end if;
  if me.secret_hash is not null then
    if me.locked_until is not null and me.locked_until > now() then
      return jsonb_build_object('ok', false, 'message', 'Too many wrong special words. Try again in 15 minutes.');
    end if;
    if p_old_secret is null or extensions.crypt(lower(btrim(p_old_secret)), me.secret_hash) <> me.secret_hash then
      update public.portal_users
         set failed_attempts = failed_attempts + 1,
             locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
       where user_id = me.user_id;
      return jsonb_build_object('ok', false, 'message', 'Your current special word is not right.');
    end if;
  end if;

  update public.portal_users set
    display_name    = left(btrim(p_display_name), 80),
    secret_hash     = extensions.crypt(word, extensions.gen_salt('bf', 8)),
    secret_set_at   = now(),
    failed_attempts = 0,
    locked_until    = null
  where user_id = me.user_id;

  return jsonb_build_object('ok', true);
end;
$$;

-- Everything the portal shows for one business, including coupons that are
-- paused or not yet live, which the public cannot see.
create or replace function public.portal_snapshot(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  result jsonb;
begin
  if not (public.is_merchant_member(p_merchant_id) or public.is_admin()) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'merchant', jsonb_build_object(
      'id', m.id, 'name', m.name, 'slug', m.slug, 'status', m.status, 'tier', m.tier,
      'tagline', m.tagline, 'description', m.description,
      'phone_display', m.phone_display, 'website_url', m.website_url,
      'facebook_url', m.facebook_url, 'instagram_url', m.instagram_url,
      'address_line1', m.address_line1, 'address_line2', m.address_line2,
      'city', m.city, 'postal_code', m.postal_code,
      'logo_media_id', m.logo_media_id, 'cover_media_id', m.cover_media_id
    ),
    'logo',  (select to_jsonb(x) from (select id, bucket_id, storage_path, alt_text, width, height from public.media where id = m.logo_media_id) x),
    'cover', (select to_jsonb(x) from (select id, bucket_id, storage_path, alt_text, width, height from public.media where id = m.cover_media_id) x),
    'deal_limit',    public.deal_limit_for_tier(m.tier),
    'gallery_limit', public.gallery_limit_for_tier(m.tier),
    'deals', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.created_at desc)
      from (
        select id, slug, headline, description, terms, restrictions, coupon_code,
               starts_at, ends_at, status, created_at, updated_at
        from public.deals
        where merchant_id = m.id and status <> 'archived'
      ) d
    ), '[]'::jsonb),
    'hours', coalesce((
      select jsonb_agg(to_jsonb(h) order by h.day_of_week)
      from (select day_of_week, is_closed, opens_at, closes_at from public.merchant_hours where merchant_id = m.id) h
    ), '[]'::jsonb),
    'gallery', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'caption', g.caption,
        'media', jsonb_build_object('id', md.id, 'bucket_id', md.bucket_id, 'storage_path', md.storage_path,
                                    'alt_text', md.alt_text, 'width', md.width, 'height', md.height)
      ) order by g.sort_order)
      from public.merchant_gallery g join public.media md on md.id = g.media_id
      where g.merchant_id = m.id
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.submitted_at desc)
      from (
        select id, kind, summary, deal_id, payload, before_data, signed_name, signed_email,
               submitted_at, status, reviewed_at, reviewer_name, review_note,
               submitted_by = auth.uid() as mine
        from public.change_requests
        where merchant_id = m.id
        order by submitted_at desc
        limit 100
      ) r
    ), '[]'::jsonb)
  ) into result
  from public.merchants m
  where m.id = p_merchant_id;

  return result;
end;
$$;

-- This business's figures, the same numbers the admin Reports page shows.
create or replace function public.portal_report(
  p_merchant_id uuid,
  p_from date default (current_date - 29),
  p_to   date default current_date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_merchant_member(p_merchant_id) or public.is_admin()) then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  return (
    select to_jsonb(r)
    from public.merchant_report_summary(p_from, p_to) r
    where r.merchant_id = p_merchant_id
  );
end;
$$;

-- Propose a change. Returns {ok, id} or {ok: false, message}.
-- Errors are returned rather than raised so that a wrong special word is
-- counted: a raised error would roll the count back.
create or replace function public.submit_change(
  p_merchant_id uuid,
  p_kind        text,
  p_deal_id     uuid,
  p_payload     jsonb,
  p_signed_name text,
  p_secret      text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  me       public.portal_users;
  merchant public.merchants;
  deal     public.deals;
  p        jsonb := '{}'::jsonb;
  before   jsonb;
  allowed  text[];
  k        text;
  v_summary text;
  pending  integer;
  day      jsonb;
begin
  -- Who is asking, and may they?
  select * into me from public.portal_users where user_id = auth.uid() and is_active;
  if not found or not public.is_merchant_member(p_merchant_id) then
    return jsonb_build_object('ok', false, 'message', 'This account cannot make changes for that business.');
  end if;
  select * into merchant from public.merchants where id = p_merchant_id and status <> 'archived';
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That business is no longer on Pocket Perks.');
  end if;

  -- The signature.
  if me.secret_hash is null then
    return jsonb_build_object('ok', false, 'message', 'Set your special word first, on the Account page.');
  end if;
  if me.locked_until is not null and me.locked_until > now() then
    return jsonb_build_object('ok', false, 'message',
      'Too many wrong special words. Try again after ' ||
      to_char(me.locked_until at time zone 'America/New_York', 'FMHH12:MI am') || '.');
  end if;
  if extensions.crypt(lower(btrim(coalesce(p_secret, ''))), me.secret_hash) <> me.secret_hash then
    update public.portal_users
       set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
           locked_until    = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
     where user_id = me.user_id;
    return jsonb_build_object('ok', false, 'message', 'That special word is not right. Nothing was sent.');
  end if;
  update public.portal_users set failed_attempts = 0, locked_until = null where user_id = me.user_id;

  if length(btrim(coalesce(p_signed_name, ''))) < 2 then
    return jsonb_build_object('ok', false, 'message', 'Type your name to sign this change.');
  end if;

  select count(*) into pending from public.change_requests
  where merchant_id = p_merchant_id and status = 'pending';
  if pending >= 25 then
    return jsonb_build_object('ok', false, 'message',
      'There are already 25 changes waiting for approval. Wait for those to be reviewed first.');
  end if;

  -- Keep only the fields a business may change. Anything else in the
  -- payload (plan, featured, name, status of the business…) is dropped.
  allowed := case p_kind
    when 'deal_create'     then array['headline','description','terms','restrictions','coupon_code','starts_at','ends_at','status']
    when 'deal_update'     then array['headline','description','terms','restrictions','coupon_code','starts_at','ends_at','status']
    when 'business_update' then array['tagline','description','phone_display','website_url','facebook_url','instagram_url',
                                      'address_line1','address_line2','city','postal_code','logo_media_id','cover_media_id']
    when 'hours_update'    then array['days']
    when 'gallery_add'     then array['media_id','caption']
    when 'gallery_remove'  then array['gallery_id']
  end;
  if allowed is null then
    return jsonb_build_object('ok', false, 'message', 'Unknown kind of change.');
  end if;

  foreach k in array allowed loop
    if coalesce(p_payload, '{}'::jsonb) ? k then
      p := p || jsonb_build_object(k, p_payload -> k);
    end if;
  end loop;

  if p ? 'status' and coalesce(p ->> 'status', '') not in ('active', 'paused') then
    return jsonb_build_object('ok', false, 'message', 'A coupon can be live or paused.');
  end if;

  -- What it looks like now, and which fields actually change.
  if p_kind = 'deal_update' then
    select * into deal from public.deals
    where id = p_deal_id and merchant_id = p_merchant_id and status <> 'archived';
    if not found then
      return jsonb_build_object('ok', false, 'message', 'That coupon is not one of yours.');
    end if;
    before := jsonb_build_object(
      'headline', deal.headline, 'description', deal.description, 'terms', deal.terms,
      'restrictions', deal.restrictions, 'coupon_code', deal.coupon_code,
      'starts_at', deal.starts_at, 'ends_at', deal.ends_at, 'status', deal.status);
  elsif p_kind = 'business_update' then
    before := jsonb_build_object(
      'tagline', merchant.tagline, 'description', merchant.description,
      'phone_display', merchant.phone_display, 'website_url', merchant.website_url,
      'facebook_url', merchant.facebook_url, 'instagram_url', merchant.instagram_url,
      'address_line1', merchant.address_line1, 'address_line2', merchant.address_line2,
      'city', merchant.city, 'postal_code', merchant.postal_code,
      'logo_media_id', merchant.logo_media_id, 'cover_media_id', merchant.cover_media_id);
  elsif p_kind = 'hours_update' then
    if jsonb_typeof(p -> 'days') <> 'array' then
      return jsonb_build_object('ok', false, 'message', 'Opening hours were not readable. Reload and try again.');
    end if;
    for day in select * from jsonb_array_elements(p -> 'days') loop
      if coalesce((day ->> 'day')::int, -1) not between 0 and 6 then
        return jsonb_build_object('ok', false, 'message', 'Opening hours were not readable. Reload and try again.');
      end if;
    end loop;
    before := jsonb_build_object('days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'day', h.day_of_week, 'closed', h.is_closed,
        'opens', to_char(h.opens_at, 'HH24:MI'), 'closes', to_char(h.closes_at, 'HH24:MI'))
        order by h.day_of_week)
      from public.merchant_hours h where h.merchant_id = p_merchant_id), '[]'::jsonb));
  elsif p_kind = 'gallery_remove' then
    select jsonb_build_object('gallery_id', g.id, 'media_id', g.media_id, 'caption', g.caption)
      into before
    from public.merchant_gallery g
    where g.id = public.pp_uuid_or_null(p ->> 'gallery_id') and g.merchant_id = p_merchant_id;
    if before is null then
      return jsonb_build_object('ok', false, 'message', 'That photo is not on your page.');
    end if;
  end if;

  if p_kind in ('deal_update', 'business_update') then
    -- Only what differs. Keeps the approval screen to the point.
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into p
    from jsonb_each(p) e
    where coalesce(nullif(btrim(e.value #>> '{}'), ''), '') is distinct from
          coalesce(nullif(btrim(before ->> e.key), ''), '')
      and not (e.key in ('starts_at', 'ends_at')
               and nullif(e.value #>> '{}', '') is not null and before ->> e.key is not null
               and (e.value #>> '{}')::timestamptz = (before ->> e.key)::timestamptz);
    if p = '{}'::jsonb then
      return jsonb_build_object('ok', false, 'message', 'Nothing was changed, so there is nothing to send.');
    end if;
  end if;

  if p_kind = 'hours_update' and p -> 'days' = before -> 'days' then
    return jsonb_build_object('ok', false, 'message', 'Nothing was changed, so there is nothing to send.');
  end if;

  -- Try it now and undo it, so a problem (a bad link, the plan's coupon
  -- limit, an end date before the start) is reported to the business
  -- while they are still on the form, not to you at approval time.
  begin
    perform public.portal_apply(p_merchant_id, p_kind, p_deal_id, p);
    raise exception 'dry run' using errcode = 'PP000';
  exception
    when sqlstate 'PP000' then null;
    when others then
      return jsonb_build_object('ok', false, 'code', sqlstate, 'message', sqlerrm);
  end;

  v_summary := case p_kind
    when 'deal_create'     then 'New coupon: ' || coalesce(p ->> 'headline', '')
    when 'deal_update'     then
      case when p ->> 'status' = 'paused' then 'End coupon: '
           when p ->> 'status' = 'active' then 'Put coupon back: '
           else 'Change coupon: ' end || coalesce(p ->> 'headline', deal.headline)
    when 'business_update' then 'Business details'
    when 'hours_update'    then 'Opening hours'
    when 'gallery_add'     then 'Add a photo'
    when 'gallery_remove'  then 'Remove a photo'
  end;

  insert into public.change_requests (
    merchant_id, deal_id, kind, summary, payload, before_data,
    submitted_by, signed_name, signed_email
  ) values (
    p_merchant_id, case when p_kind = 'deal_update' then p_deal_id end, p_kind, left(v_summary, 200), p, before,
    me.user_id, left(btrim(p_signed_name), 80), me.email
  )
  returning jsonb_build_object('ok', true, 'id', id, 'summary', v_summary, 'merchant_name', merchant.name)
  into before;

  return before;
end;
$$;

-- Take back a change that has not been reviewed yet.
create or replace function public.withdraw_change(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.change_requests
     set status = 'withdrawn'
   where id = p_id and status = 'pending' and submitted_by = auth.uid()
     and public.is_merchant_member(merchant_id);
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That change has already been reviewed or is not yours.');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Administrator functions
-- ---------------------------------------------------------------------

-- Approve (apply it) or reject (with an optional note).
create or replace function public.review_change(p_id uuid, p_approve boolean, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  cr   public.change_requests;
  who  text;
  applied uuid;
begin
  if not public.is_admin() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;

  select * into cr from public.change_requests where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'message', 'That change could not be found.');
  end if;
  if cr.status <> 'pending' then
    return jsonb_build_object('ok', false, 'message', 'That change was already ' || cr.status || '.');
  end if;

  select display_name into who from public.profiles where id = auth.uid();

  if p_approve then
    begin
      applied := public.portal_apply(cr.merchant_id, cr.kind, cr.deal_id, cr.payload);
    exception when others then
      return jsonb_build_object('ok', false, 'code', sqlstate, 'message', sqlerrm);
    end;
  end if;

  update public.change_requests set
    status        = case when p_approve then 'approved' else 'rejected' end,
    reviewed_at   = now(),
    reviewed_by   = auth.uid(),
    reviewer_name = who,
    review_note   = nullif(left(btrim(coalesce(p_note, '')), 500), ''),
    deal_id       = case when cr.kind = 'deal_create' then applied else deal_id end
  where id = p_id;

  return jsonb_build_object(
    'ok', true,
    'status', case when p_approve then 'approved' else 'rejected' end,
    'summary', cr.summary,
    'signed_name', cr.signed_name,
    'signed_email', cr.signed_email,
    'merchant_id', cr.merchant_id,
    'merchant_name', (select name from public.merchants where id = cr.merchant_id)
  );
end;
$$;

-- Clear someone's special word; they choose a new one next time they sign in.
create or replace function public.admin_reset_portal_secret(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  update public.portal_users
     set secret_hash = null, secret_set_at = null, failed_attempts = 0, locked_until = null
   where user_id = p_user_id;
  return jsonb_build_object('ok', found);
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Row Level Security
-- ---------------------------------------------------------------------

alter table public.portal_users     enable row level security;
alter table public.merchant_members enable row level security;
alter table public.change_requests  enable row level security;
-- Not FORCE: the functions above run as the table owner and are the
-- only way anyone but an administrator writes to these tables.

revoke all on public.portal_users, public.merchant_members, public.change_requests from anon, authenticated;

-- The special word's hash is readable by nobody, administrators included.
grant select (user_id, display_name, email, secret_set_at, failed_attempts, locked_until,
              is_active, created_at, created_by)
  on public.portal_users to authenticated;
grant insert (user_id, display_name, email, created_by) on public.portal_users to authenticated;
grant update (display_name, is_active) on public.portal_users to authenticated;
grant select, insert, delete on public.merchant_members to authenticated;
grant select on public.change_requests to authenticated;

drop policy if exists portal_users_read on public.portal_users;
create policy portal_users_read on public.portal_users
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists portal_users_admin_insert on public.portal_users;
create policy portal_users_admin_insert on public.portal_users
  for insert to authenticated with check (public.is_admin());

drop policy if exists portal_users_admin_update on public.portal_users;
create policy portal_users_admin_update on public.portal_users
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists merchant_members_read on public.merchant_members;
create policy merchant_members_read on public.merchant_members
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

drop policy if exists merchant_members_admin_insert on public.merchant_members;
create policy merchant_members_admin_insert on public.merchant_members
  for insert to authenticated with check (public.is_admin());

drop policy if exists merchant_members_admin_delete on public.merchant_members;
create policy merchant_members_admin_delete on public.merchant_members
  for delete to authenticated using (public.is_admin());

-- Businesses read their changes through portal_snapshot, which checks
-- membership. Directly, only administrators can list them.
drop policy if exists change_requests_admin_read on public.change_requests;
create policy change_requests_admin_read on public.change_requests
  for select to authenticated using (public.is_admin());

-- Businesses may upload photos, but only into pending/<their business id>/.
-- A photo there appears nowhere until an approved change uses it.
drop policy if exists merchant_media_member_insert on storage.objects;
create policy merchant_media_member_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'merchant-media'
    and name like 'pending/%'
    and public.is_merchant_member(public.pp_uuid_or_null(split_part(name, '/', 2)))
  );

drop policy if exists media_member_insert on public.media;
create policy media_member_insert on public.media
  for insert to authenticated
  with check (
    storage_path like 'pending/%'
    and created_by is null
    and public.is_merchant_member(public.pp_uuid_or_null(split_part(storage_path, '/', 2)))
  );

-- ---------------------------------------------------------------------
-- 9. Function permissions. Closed by default, opened one by one.
-- ---------------------------------------------------------------------

revoke all on function public.pp_uuid_or_null(text)                         from public, anon, authenticated;
revoke all on function public.is_merchant_member(uuid)                      from public, anon, authenticated;
revoke all on function public.portal_media_ok(uuid, uuid)                   from public, anon, authenticated;
revoke all on function public.pp_text(jsonb, text)                          from public, anon, authenticated;
revoke all on function public.portal_apply(uuid, text, uuid, jsonb)         from public, anon, authenticated;
revoke all on function public.portal_me()                                   from public, anon, authenticated;
revoke all on function public.portal_set_secret(text, text, text)           from public, anon, authenticated;
revoke all on function public.portal_snapshot(uuid)                         from public, anon, authenticated;
revoke all on function public.portal_report(uuid, date, date)               from public, anon, authenticated;
revoke all on function public.submit_change(uuid, text, uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.withdraw_change(uuid)                         from public, anon, authenticated;
revoke all on function public.review_change(uuid, boolean, text)            from public, anon, authenticated;
revoke all on function public.admin_reset_portal_secret(uuid)               from public, anon, authenticated;

-- Used inside the storage and media policies, so the caller needs them.
grant execute on function public.pp_uuid_or_null(text)    to authenticated;
grant execute on function public.is_merchant_member(uuid) to authenticated;

grant execute on function public.portal_me()                                   to authenticated;
grant execute on function public.portal_set_secret(text, text, text)           to authenticated;
grant execute on function public.portal_snapshot(uuid)                         to authenticated;
grant execute on function public.portal_report(uuid, date, date)               to authenticated;
grant execute on function public.submit_change(uuid, text, uuid, jsonb, text, text) to authenticated;
grant execute on function public.withdraw_change(uuid)                         to authenticated;
grant execute on function public.review_change(uuid, boolean, text)            to authenticated;
grant execute on function public.admin_reset_portal_secret(uuid)               to authenticated;

grant select, insert, update, delete on public.portal_users, public.merchant_members, public.change_requests to service_role;

-- ---------------------------------------------------------------------
-- 10. A way in, in the footer.
-- ---------------------------------------------------------------------

insert into public.nav_items (location, section, label, href, sort_order, is_system, is_active)
select 'footer', 'For businesses', 'Business login', '/portal/login', 20, false, true
where not exists (select 1 from public.nav_items where location = 'footer' and href = '/portal/login');
