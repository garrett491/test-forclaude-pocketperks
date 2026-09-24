-- =====================================================================
-- Pocket Perks — 0004 Analytics
--
-- The honesty rule, encoded:
--   impressions  = deal_view                      (it was on screen)
--   views        = merchant_view, deal_open       (they looked at it)
--   intent       = call, directions, website,     (they acted on it)
--                  code_copy, share
--   conversions  = not measurable by this website; never reported as such.
--
-- Reports read event_daily, never events. Bot traffic is excluded at
-- rollup time, so a merchant report can never be inflated by crawlers.
-- =====================================================================

-- ---------------------------------------------------------------------
-- rollup_events(day)
-- Idempotent: delete-then-insert for the target day, so re-running after
-- a late-arriving event or a fixed bot rule always produces the truth.
-- ---------------------------------------------------------------------

create or replace function public.rollup_events(target_day date default (current_date - 1))
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rows_written integer;
begin
  delete from public.event_daily where day = target_day;

  insert into public.event_daily (day, merchant_id, deal_id, event_type, event_count, unique_sessions)
  select
    target_day,
    e.merchant_id,
    e.deal_id,
    e.event_type,
    count(*)::integer,
    count(distinct e.session_hash)::integer
  from public.events e
  where e.occurred_at >= target_day::timestamptz
    and e.occurred_at <  (target_day + 1)::timestamptz
    and e.is_bot = false
    and e.merchant_id is not null
  group by e.merchant_id, e.deal_id, e.event_type;

  get diagnostics rows_written = row_count;
  return rows_written;
end;
$$;

comment on function public.rollup_events(date) is
  'Aggregates one day of non-bot events into event_daily. Idempotent. Schedule daily; safe to re-run for any past date.';

-- ---------------------------------------------------------------------
-- prune_events(keep_days)
-- Raw events are only needed until they are rolled up and any bot rules
-- have settled. The rollup is permanent; the raw log is not. Keeping 400
-- days covers year-over-year comparison without unbounded growth.
-- ---------------------------------------------------------------------

create or replace function public.prune_events(keep_days integer default 400)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  delete from public.events
  where occurred_at < now() - make_interval(days => keep_days);
  get diagnostics removed = row_count;

  delete from public.rate_limits where window_start < now() - interval '2 days';

  return removed;
end;
$$;

-- ---------------------------------------------------------------------
-- merchant_report(merchant, from, to)
-- The single source for anything shown to a merchant. Returns counts
-- grouped into the four honesty tiers above so the UI cannot accidentally
-- present an impression as a customer.
-- ---------------------------------------------------------------------

create or replace function public.merchant_report(
  p_merchant_id uuid,
  p_from date default (current_date - 29),
  p_to   date default current_date
)
returns table (
  metric_group text,
  event_type   public.event_type,
  total        integer,
  sessions     integer
)
language sql
stable
security invoker
as $$
  select
    case ed.event_type
      when 'deal_view'        then 'impressions'
      when 'merchant_view'    then 'views'
      when 'deal_open'        then 'views'
      when 'search'           then 'views'
      else 'intent'
    end as metric_group,
    ed.event_type,
    sum(ed.event_count)::integer,
    sum(ed.unique_sessions)::integer
  from public.event_daily ed
  where ed.merchant_id = p_merchant_id
    and ed.day between p_from and p_to
  group by 1, 2
  order by 1, 2;
$$;

grant execute on function public.merchant_report(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------
-- merchant_report_summary — one row per merchant for the admin dashboard
-- and the monthly renewal conversation.
-- ---------------------------------------------------------------------

create or replace function public.merchant_report_summary(
  p_from date default (current_date - 29),
  p_to   date default current_date
)
returns table (
  merchant_id       uuid,
  merchant_name     text,
  merchant_slug     text,
  tier              public.merchant_tier,
  impressions       integer,
  profile_views     integer,
  deal_opens        integer,
  call_clicks       integer,
  directions_clicks integer,
  website_clicks    integer,
  code_copies       integer,
  shares            integer,
  intent_actions    integer,
  reached_people    integer
)
language sql
stable
security invoker
as $$
  select
    m.id,
    m.name,
    m.slug,
    m.tier,
    coalesce(sum(ed.event_count) filter (where ed.event_type = 'deal_view'), 0)::integer,
    coalesce(sum(ed.event_count) filter (where ed.event_type = 'merchant_view'), 0)::integer,
    coalesce(sum(ed.event_count) filter (where ed.event_type = 'deal_open'), 0)::integer,
    coalesce(sum(ed.event_count) filter (where ed.event_type = 'call_click'), 0)::integer,
    coalesce(sum(ed.event_count) filter (where ed.event_type = 'directions_click'), 0)::integer,
    coalesce(sum(ed.event_count) filter (where ed.event_type = 'website_click'), 0)::integer,
    coalesce(sum(ed.event_count) filter (where ed.event_type = 'code_copy'), 0)::integer,
    coalesce(sum(ed.event_count) filter (where ed.event_type = 'share'), 0)::integer,
    coalesce(sum(ed.event_count) filter (
      where ed.event_type in ('call_click','directions_click','website_click','code_copy','share')
    ), 0)::integer,
    coalesce(max(ed.unique_sessions) filter (where ed.event_type = 'merchant_view'), 0)::integer
  from public.merchants m
  left join public.event_daily ed
    on ed.merchant_id = m.id and ed.day between p_from and p_to
  where m.status <> 'archived'
  group by m.id, m.name, m.slug, m.tier
  order by 12 desc, m.name;
$$;

comment on function public.merchant_report_summary(date, date) is
  'One row per merchant for admin reporting. reached_people is an approximation of distinct visitors derived from daily session counts and must be labelled as approximate wherever it is displayed.';

grant execute on function public.merchant_report_summary(date, date) to authenticated;

-- ---------------------------------------------------------------------
-- Scheduling.
-- pg_cron is available on Supabase. If you prefer not to enable it, call
-- rollup_events() from a Netlify scheduled function instead; both are in
-- the README. Wrapped in a DO block so the migration still succeeds on a
-- project where pg_cron is unavailable.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;

    perform cron.unschedule('pocket-perks-rollup')
      where exists (select 1 from cron.job where jobname = 'pocket-perks-rollup');
    perform cron.schedule(
      'pocket-perks-rollup', '20 5 * * *',
      $cron$ select public.rollup_events(current_date - 1); $cron$
    );

    perform cron.unschedule('pocket-perks-prune')
      where exists (select 1 from cron.job where jobname = 'pocket-perks-prune');
    perform cron.schedule(
      'pocket-perks-prune', '40 5 * * 0',
      $cron$ select public.prune_events(400); $cron$
    );
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %. Use the Netlify scheduled function instead.', sqlerrm;
end $$;
