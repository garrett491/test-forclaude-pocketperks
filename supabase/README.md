# Pocket Perks — database setup

Everything here has been run end to end against a clean PostgreSQL 16 and
passes 32 assertions in `tests/01_guarantees.sql`. Run the files in order;
all of them are safe to run more than once.

---

## 1. Create the project

Supabase dashboard → New project.

- **Region:** `us-east-1` (closest to Ohio; keeps query latency to Netlify's
  US edge in the single-digit milliseconds).
- **Plan:** Free is fine. At five merchants you will not approach any limit.
  The paid tier matters only when you want daily backups, which is worth
  $25/month once real merchant data lives here — not today.

Write down the database password. You will not see it again.

---

## 2. Apply the migrations

SQL Editor → paste each file → Run, in this order:

| Order | File | What it does |
|---|---|---|
| 1 | `migrations/0001_foundation.sql` | Extensions, enum types, slug/phone/timestamp helpers |
| 2 | `migrations/0002_tables.sql` | All tables, constraints, indexes, integrity triggers |
| 3 | `migrations/0003_rls.sql` | `is_admin()`, Row Level Security policies, grants |
| 4 | `migrations/0004_analytics.sql` | Rollup, pruning, merchant reporting functions |
| 5 | `migrations/0005_storage.sql` | The `merchant-media` bucket and its policies |
| 6 | `seed.sql` | Carrollton, categories, badges, site copy, navigation |

Order matters: `is_admin()` cannot be created before the `profiles` table
exists, and `0005` cannot create its policies before `is_admin()` exists.

`seed.sql` contains **no sample merchants and no placeholder deals**. Your
five live businesses get entered through the admin dashboard, which doubles
as the first honest test of whether the dashboard is good enough to use.

---

## 3. Create your admin account

There is deliberately no signup route. Accounts are created by hand.

1. Authentication → Users → **Add user**. Use a real address and a password
   from a password manager, not one you can remember.
2. Copy the new user's UUID.
3. SQL Editor:

```sql
insert into public.profiles (id, role, display_name)
values ('<paste-the-uuid>', 'owner', 'Garrett');
```

**A row in `profiles` is what grants administrator rights.** There is no
policy allowing anything to insert into `profiles`, including a signed-in
admin. If your admin session is ever stolen, the attacker still cannot mint
a second administrator — they would need your Supabase dashboard login.

Turn on MFA for your Supabase dashboard account. That login is now the most
valuable credential in the business.

Also: Authentication → Providers → disable **Enable email signups**. Without
this, anyone can create an `auth.users` account. They would land with zero
privileges because they have no `profiles` row, but there is no reason to
leave the door open.

---

## 4. Environment variables

In Netlify → Site settings → Environment variables.

| Variable | Value | Where it runs |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Project URL | Browser. Safe |
| `PUBLIC_SUPABASE_ANON_KEY` | `anon` `public` key | Browser. Safe |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` `secret` key | **Netlify Functions only** |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile secret | Functions only |
| `PUBLIC_TURNSTILE_SITE_KEY` | Turnstile site key | Browser. Safe |
| `SESSION_SALT` | 32 random bytes, hex | Functions only |

The anon key appearing in your page source is expected and safe. It is not a
password — it identifies the `anon` role, whose entire capability is defined
by the policies in `0003_rls.sql`. The tests prove it can read published
content and write nothing anywhere.

The service-role key bypasses every policy in this schema. It must never
appear in a variable prefixed `PUBLIC_`, never be imported into a page or
component, and never be logged.

---

## 5. Verify it yourself

Don't take my word for the security model. In the SQL Editor:

```sql
-- Impersonate an anonymous website visitor
set role anon;

-- Should return your published merchants
select name, slug from public.merchants;

-- Every one of these should fail with "permission denied"
insert into public.merchants (name) values ('Test');
select * from public.subscribers;
select * from public.event_daily;
insert into public.events (event_type) values ('call_click');

reset role;
```

That last one matters most: if a visitor could write to `events`, anyone
could inflate or sabotage a merchant's numbers, and every report you show
at renewal would be worthless.

---

## 6. Analytics scheduling

`0004_analytics.sql` schedules two jobs through `pg_cron` if it is available:

- **05:20 daily** — `rollup_events(current_date - 1)` aggregates yesterday
  into `event_daily`.
- **05:40 Sundays** — `prune_events(400)` drops raw events older than ~13
  months and clears expired rate-limit windows.

Check they registered:

```sql
select jobname, schedule, active from cron.job;
```

If `pg_cron` is unavailable, the migration logs a notice and continues; a
Netlify scheduled function calling `rollup_events` does the same job.

`rollup_events` is idempotent. Re-run it for any past date after fixing a
bot rule and the numbers correct themselves rather than doubling.

---

## 7. Reporting

```sql
-- Every merchant, last 30 days — this is the renewal conversation
select * from public.merchant_report_summary();

-- One merchant, a specific month
select * from public.merchant_report(
  (select id from public.merchants where slug = 'crossroads-pizza'),
  '2026-09-01', '2026-09-30'
);
```

`merchant_report` groups everything into `impressions`, `views` and
`intent`. There is no `conversions` group, because a website cannot observe
someone walking into a store. When the admin UI renders these:

- "3 people tapped Call" — true, and provable.
- "We sent you 3 customers" — not true, and the first merchant who checks
  their own call log will know it. Never write it.

`reached_people` in the summary is derived from daily session counts and
double-counts a visitor who returns on a different day. Label it
approximate wherever it appears.

---

## 8. Running the tests locally

Requires PostgreSQL 16 on your machine; nothing here touches Supabase.

```bash
cd supabase
PGHOST=/tmp PGPORT=5433 bash tests/run.sh
```

The runner drops the scratch database, applies every migration, runs the
seed **twice** to prove idempotency, and asserts all 32 guarantees.

`tests/00_supabase_stub.sql` fakes the `auth` and `storage` schemas so the
migrations can run outside Supabase. Never run it against a real project.

---

## Notes on decisions you may want to revisit

**Deals are limited by plan tier at the database level.** A Standard
merchant physically cannot have three active deals; the insert fails with a
message naming the merchant, their plan, and the fix. If you want to comp
someone extra deals, change their tier — that keeps the plan and the
delivered product in sync, which is exactly what broke on the old site.

**Merchants and deals cannot be deleted, only archived.** Deleting would
orphan historical analytics and break any link already printed on a flyer or
posted to Facebook. Archived records disappear from the public site
immediately.

**System rows are undeletable.** The header nav, footer nav, hero block and
core site settings can be edited and switched off but not removed. A bad
click costs you a minute, not your navigation.

**No IP address is stored anywhere.** `session_hash` is a salted digest
computed in the Netlify Function; rotate `SESSION_SALT` daily and the hash
cannot follow anyone across days. This keeps the analytics useful for
deduplication and useless for tracking individuals.

**`newsletter.mode` in `site_settings` is the ActiveCampaign switch.** Set it
to `activecampaign_link`, fill in `newsletter.external_form_url`, and every
signup form on the site points at your hosted form instead of Supabase. No
code change, no redeploy. `subscribers.external_id` and `synced_at` are
already in place for a full API sync later.
