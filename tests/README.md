# Tests

Three suites, from fastest to most thorough. None of them touch the hosted
Supabase project.

| Suite | Command | What it proves |
|---|---|---|
| Unit | `npm test` | Card deal limits and "+N more", sorting, pagination, search-term cleaning, expiry wording in Ohio time, image `srcset`/aspect maths, town cookie handling, admin write checks. |
| Database | `PGUSER=postgres npm run test:db` | Every migration applies to a fresh database and can be re-run. RLS keeps drafts, archived businesses, subscribers and enquiries away from the public. Admin rights come from the `profiles` table, not the browser. Plan limits and consent columns hold. |
| Browser | `npm run test:e2e` | The production build, served the way Netlify serves it, driven by Chromium at phone size, against the real migrations and RLS. |

## What you need

- Node 22.12 or newer, and `npm install`.
- A local PostgreSQL 16 on port 5433 that the `postgres` role can use
  without a password (for example `initdb` plus `pg_ctl -o "-p 5433 -k /tmp"`).
  Both the database and browser suites build their own scratch databases on
  it and drop them first.
- Chromium for Playwright. Either `npx playwright install chromium`, or point
  at an existing one with `PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium`.
- For the browser suite, a `.env` pointing at the local stand-in:

  ```
  PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
  PUBLIC_SUPABASE_ANON_KEY=local-anon-key
  SUPABASE_SERVICE_ROLE_KEY=local-service-key
  PUBLIC_SITE_URL=http://127.0.0.1:4321
  SESSION_SALT=any-long-random-string
  ```

  These are fake values that only the stand-in accepts. Never commit real
  keys; `.env` is gitignored.

## Running the browser suite

```bash
npm run images:fixtures   # once: the awkward test images
npm run build
npm run test:e2e
```

Build last: `astro check` clears the build output, so run it before
`npm run build`, not after.

`test:e2e` starts two things, runs Playwright, then stops them:

- `tests/support/supabase-local.mjs` — a small stand-in for the parts of
  Supabase this site uses (REST, Auth, Storage). Every request runs as the
  Postgres role Supabase would use, so RLS decides what each caller sees.
  It can also simulate a paused project (`/__control/outage?on=1`).
- `tests/support/serve-build.mjs` — serves `dist/` the way Netlify does,
  with the headers from `netlify.toml` (including the CSP).

The database is rebuilt from `supabase/migrations` plus
`tests/support/fixtures.sql` before the run and before each spec file, so
results never depend on order. The fixtures deliberately include every
awkward image shape (very wide, very tall, square, transparent, a flyer with
text, a tiny logo, a missing file), a business with no deals, a draft, an
expired and a scheduled deal, and a second town. Each test image has a
solid border and corner labels, so a screenshot proves nothing was cropped.

Test sign-ins: `owner@example.com` / `correct-horse-battery` is an admin;
`nobody@example.com` with the same password can sign in to Auth but has no
`profiles` row and must be refused.

To poke at the site by hand against the same data:

```bash
bash tests/support/reset-db.sh
bash tests/support/services.sh start dev     # or: start preview (needs a build)
# … http://127.0.0.1:4321 …
bash tests/support/services.sh stop
```

## The specs

| File | Covers |
|---|---|
| `public.spec.ts` | Business and deal pages from a direct link, refresh, back/forward; every business page loads; real 404s; a Supabase outage shows a notice (503, not cached, not blank); expired/scheduled/drafts hidden; town choice remembered and changeable; up to three coupons and "+N more"; search; titles, canonicals, structured data, sitemap. |
| `carousel.spec.ts` | Continuous loop with no jump, pause/resume, arrows only when paused, swipe, reduced motion, slides stay tappable. |
| `layout-images.spec.ts` | No horizontal scroll at every width from 320px to large desktop; every image drawn whole (not cropped or stretched); missing images fall back to an initials tile; a tall flyer shows its fine print; card image bands line up; tap targets are big enough. |
| `accessibility.spec.ts` | axe-core (WCAG 2.0–2.2 A/AA rules plus best practice) on every public page at phone and desktop widths; the homepage by keyboard alone; text enlarged to 200%. |
| `admin.spec.ts` | Sign-in gate, non-admins refused, password reset; switches, deals, content and settings save, survive a reload and show on the site; Ohio-time end dates; validation (dates, hours, https links); plan limits explained; uploads preview, save, show whole and store the 1200px copy phones load; failed saves keep what was typed; archiving asks first. |
| `forms.spec.ts` | Newsletter signup (with and without JavaScript), consent record, unsubscribe and re-signup, business enquiry reaching the admin, click tracking without IP addresses, robots filtered out. |

## What these tests cannot tell you

They run in Chromium only, against a stand-in rather than hosted Supabase and
Netlify. Before launch, also check by hand: a real deploy, a real
Supabase project, the CDN purge after an admin save, email delivery, and
Safari on an iPhone.
