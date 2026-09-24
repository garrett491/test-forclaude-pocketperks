# Pocket Perks

Local deals and business directory for Carroll County, Ohio.

**New here? Read `DEPLOY.md` first.** It walks through setup start to finish.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Astro 7, server output | Real HTML for every business and deal page. One small bundled script (carousel, search suggestions, town memory). |
| Hosting | Netlify | The Astro adapter compiles pages and API routes into Netlify Functions. |
| Database | Supabase (Postgres) | Row Level Security is the security boundary. See `supabase/README.md`. |
| Media | Supabase Storage | Uploads are resized in the browser and stored with 640px and 1200px WebP copies, served through `srcset`. Images are never cropped. |
| Bot protection | Honeypot plus rate limiting in Postgres | No extra vendor for three forms. |
| Fonts | DM Sans and Playfair Display, self-hosted (`@fontsource`, OFL) | No request to Google unless the Design page picks another font. |

Nothing else. No paid tier, no analytics vendor, no CMS.

## Folder map

```
public/       Logos, share image, robots.txt. Served as-is.
src/          The site itself — pages, components, styles, scripts, data layer.
tests/        Unit, database and browser tests. See tests/README.md.
scripts/      One-off generators (brand PNGs from the SVG logo).
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
npm test                  # unit tests; see tests/README.md for the rest
```

Set the database up first — see `supabase/README.md`.

## Public routes

| Path | What it is |
|---|---|
| `/` | Homepage. On a first visit with more than one town it asks which town (remembered in the `pp_town` cookie, changeable any time); after that it shows that town's deals. `/?town=all` shows every town. |
| `/deals` | All deals, filterable by category, town, featured, ending soon. Paginated. With `?q=` it searches businesses and deals. |
| `/businesses` | Directory, filterable and paginated. |
| `/b/[merchant]` | Business profile. Emits `LocalBusiness` structured data. |
| `/b/[merchant]/[deal]` | Individual deal. A shareable link with its own preview image. |
| `/[town]` | Town landing page, e.g. `/carrollton`. |
| `/for-business` | Merchant sales page, plan matrix, and the enquiry form. |
| `/privacy`, `/terms`, `/accessibility` | Draft legal pages. Need review before launch. |
| `/newsletter` | Result page for the signup form when JavaScript is off. |
| `/unsubscribe` | One-click unsubscribe from the token in each email (confirm button, POST). |
| `/search-results` | HTML fragment used by live search. Not linked or indexed. |
| `/portal/login`, `/portal/*` | Business portal: a business proposes coupons, details, hours and photos, signed with its special word. Nothing goes live until approved. |
| `/auth/set-password` | Choosing a password, from a reset email or a new business login's link. |
| `/api/search` | Search suggestions as JSON. |
| `/404` | |
| `/sitemap.xml` | Generated from the database, so it never lists an expired deal. |
| `/api/subscribe` | Newsletter signup. Validation, honeypot, rate limit, dedupe, consent record. |
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
| `/admin/content` | Hero, town chooser, announcement bar, how-it-works, newsletter wording, empty states, navigation |
| `/admin/approvals` | Changes sent by businesses: who signed, when, before and after. One click approves |
| `/admin/business-logins` | Create business logins and sign-in links, reset special words, switch logins off |
| `/admin/design` | Colours, fonts and sizes |
| `/admin/settings` | Site details, SEO defaults, newsletter destination, carousel, towns, categories |

Admin forms are ordinary HTML posts. They work without JavaScript; the only
scripts are the confirmation dialogs on destructive actions, the print button
on reports, and image resizing.

The admin client uses the **anon key**, not the service role, so every write
is still checked against RLS with your own JWT. A bug in the admin code
cannot exceed what the policies allow. Every save checks that a row was
actually written before saying "Saved".

The service-role key is used only on the server, by the public form
endpoints (`/api/subscribe`, `/api/merchant-lead`, `/api/track`),
`/unsubscribe`, and the two steps on Business logins that need Supabase's
admin API (creating a login, making a sign-in link). It never reaches the
browser.

## Caching

Public pages set `s-maxage=60, stale-while-revalidate=600` and the cache tag
`pp-public`. Netlify's CDN serves them at static speed. Every successful admin
save purges that tag (when `NETLIFY_PURGE_API_TOKEN` is set), so changes show
straight away; without the token they show within about a minute. Pages that
depend on the chosen town vary on the `pp_town` cookie. If the database is
unreachable, pages return 503 with a friendly notice and are never cached. Admin pages set `private, no-store` and
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
  real ones, then run `npm run images:brand` to regenerate `logo.png`,
  `apple-touch-icon.png` and `og-default.png` (the 1200×630 link preview).
- **Run migrations 0009 and 0010** in Supabase (see `supabase/README.md`).
- **Have Privacy, Terms and Accessibility reviewed.** They describe what the
  code does, but they are drafts, not legal advice.
- **Delete the old Google Apps Script deployment** once the domain is moved.
  Until then its webhook is still live and still writable by anyone.
