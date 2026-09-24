# Pocket Perks

Local deals and business directory for Carroll County, Ohio.

**New here? Read `DEPLOY.md` first.** It walks through setup start to finish.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Astro 5, server output | Real HTML for every merchant and deal page. About 1 kB of JavaScript reaches the browser. |
| Hosting | Netlify | The Astro adapter compiles pages and API routes into Netlify Functions. |
| Database | Supabase (Postgres) | Row Level Security is the security boundary. See `supabase/README.md`. |
| Media | Supabase Storage | On-the-fly resize and WebP conversion, so a 2400px photo never fills a 320px card. |
| Bot protection | Honeypot plus rate limiting in Postgres | No extra vendor for three forms. |

Nothing else. No paid tier, no analytics vendor, no CMS.

## Folder map

```
public/       Images, robots.txt, and the two JavaScript files. Served as-is.
src/          The site itself — pages, components, styles, data layer.
supabase/     SQL you paste into the Supabase dashboard. NOT deployed.
netlify.toml  Build settings and security headers. Netlify reads this itself.
```

## Running locally

```bash
cp .env.example .env      # fill in your Supabase values
npm install
npm run dev               # http://localhost:4321
npm run check             # type-check every file
npm run build
```

Set the database up first — see `supabase/README.md`.

## Public routes

| Path | What it is |
|---|---|
| `/` | Homepage. Deals render immediately; there is no town gate. |
| `/deals` | All deals, filterable by category, town, featured, ending soon. Paginated. |
| `/businesses` | Directory, filterable and paginated. |
| `/b/[merchant]` | Business profile. Emits `LocalBusiness` structured data. |
| `/b/[merchant]/[deal]` | Individual deal. A shareable link with its own preview image. |
| `/[town]` | Town landing page, e.g. `/carrollton`. |
| `/for-business` | Merchant sales page, plan matrix, and the enquiry form. |
| `/privacy`, `/unsubscribe`, `/404` | |
| `/sitemap.xml` | Generated from the database, so it never lists an expired deal. |
| `/api/subscribe` | Newsletter signup. Validation, honeypot, rate limit, dedupe. |
| `/api/merchant-lead` | Business enquiry. Feeds `/admin/leads`. |
| `/api/track` | Event ingest. Bot filtering and session hashing happen here. |

Filters are plain links, so every combination has a real URL that is
shareable, bookmarkable, back-button friendly, and works before any
JavaScript runs.

## Admin

`/admin`, gated by middleware before any page code runs. Sign in with a
Supabase Auth account that also has a row in `public.profiles` — both checks
must pass. Accounts are created by hand in the Supabase dashboard; there is
no signup route, so a stolen admin session cannot mint more administrators.

| Path | What it does |
|---|---|
| `/admin` | Last 30 days of activity, deals expiring within a week, drafts, new enquiries |
| `/admin/merchants` | List, filter, create, edit, archive |
| `/admin/deals` | Same, plus the true showing state — live, scheduled, or expired |
| `/admin/reports` | Per-merchant report grouped into impressions, views and intent. Prints to PDF |
| `/admin/subscribers` | List, search, CSV export shaped for ActiveCampaign |
| `/admin/leads` | Enquiries from `/for-business`, with status and notes |
| `/admin/content` | Hero, announcement bar, how-it-works, newsletter wording, empty states, navigation |
| `/admin/settings` | Site details, SEO defaults, newsletter destination, towns, categories |

Admin forms are ordinary HTML posts. They work without JavaScript; the only
scripts are the confirmation dialogs on destructive actions, the print button
on reports, and image resizing.

The admin client uses the **anon key**, not the service role, so every write
is still checked against RLS with your own JWT. A bug in the admin code
cannot exceed what the policies allow.

## Caching

Public pages set `s-maxage=300, stale-while-revalidate=3600`. Netlify's CDN
serves them at static speed, and a deal published from the dashboard is live
within five minutes with no deploy. Admin pages set `private, no-store` and
`X-Robots-Tag: noindex` so they are never cached or indexed.

## Where the copy lives

Hero, announcement bar, how-it-works, newsletter wording, empty states,
navigation, footer links, contact details and social links all come from
`site_settings`, `content_blocks` and `nav_items`. None of it is in the
source, which is the point — running the site should never mean opening an
editor.

## Still to do before launch

- **Replace the placeholder marks.** `public/logo.svg`, `logo-mark-light.svg`
  and `favicon.svg` are stand-ins traced from the brand colours. Export the
  real ones.
- **Add `public/og-default.png`** — a 1200×630 image for link previews.
  Without it, links shared to Facebook look broken.
- **Delete the old Google Apps Script deployment** once the domain is moved.
  Until then its webhook is still live and still writable by anyone.
