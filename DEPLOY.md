# Deploying Pocket Perks

Start to finish, about 45 minutes. Nothing here needs you to edit code.

Do all of it against a **Netlify preview URL first**. Your live site at
yourpocketperks.com keeps running untouched until you point the domain over
at the very end, which is a one-click change you can also undo.

---

## Step 1 — Put the files somewhere Netlify can read them

Everything in this bundle is one project. Keep the folder structure exactly
as it is — the paths matter.

```
pocket-perks/
├── astro.config.mjs
├── netlify.toml
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── public/            ← images, robots.txt, and the two JS files
├── src/               ← the site itself
└── supabase/          ← SQL you paste into Supabase; NOT deployed
```

**The recommended route is GitHub.** Create a new empty repository, drop the
whole `pocket-perks` folder in, commit, push. Netlify then rebuilds every
time you change anything, and you have a history to roll back to.

If you would rather not use Git: run `npm install` then `npm run build`
locally, and drag the resulting folder onto Netlify. You will have to repeat
that by hand after every change, which is why Git is worth the twenty minutes.

Do **not** upload `node_modules` or `dist`. Netlify builds those itself, and
`.gitignore` already excludes them.

The `supabase/` folder never gets deployed. It is SQL you paste into the
Supabase dashboard in Step 2, kept alongside the code so it does not get lost.

---

## Step 2 — Set up the database

Follow `supabase/README.md`. In short:

1. Create a Supabase project (Free tier, region `us-east-1`).
2. SQL Editor → run the ten files in order:
   `0001_foundation` → `0002_tables` → `0003_rls` → `0004_analytics` →
   `0005_storage` → `seed.sql` → `0006_fixes` →
   `0007_gallery_theme_branding` → `0008_location_carousel` →
   `0009_production_pass`.
   Order matters. Each one assumes the previous ran.

   **Already set up?** Run whichever of `0006`–`0009` you have not run yet,
   in order. Each is additive and safe to run more than once — nothing is
   dropped and no data is lost. If you are not sure whether you ran one,
   run it again.
3. Authentication → Users → Add user. Use a real address and a password from
   a password manager.
4. Copy that user's UUID and run:

```sql
insert into public.profiles (id, role, display_name)
values ('<paste-the-uuid>', 'owner', 'Garrett');
```

That row is what makes the account an administrator. Nothing in the website
can create one.

5. Authentication → Providers → turn **off** email signups. Without this,
   anyone can create an account. They would land with zero privileges, but
   there is no reason to leave the door open.
6. Turn on MFA for your own Supabase dashboard login. That is now the most
   valuable credential in the business.

---

## Step 3 — Connect Netlify

New site → import from your Git repository. Netlify reads `netlify.toml` and
fills in the build settings; you should not have to type them:

- Build command: `npm run build`
- Publish directory: `dist`

Before the first deploy, add the environment variables. Site configuration →
Environment variables. Values come from Supabase under Project Settings → API.

| Variable | Value | Notes |
|---|---|---|
| `PUBLIC_SUPABASE_URL` | Project URL | Safe in the browser |
| `PUBLIC_SUPABASE_ANON_KEY` | `anon` `public` key | Safe in the browser |
| `PUBLIC_SITE_URL` | `https://yourpocketperks.com` | Used for canonical URLs and share links |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` `secret` key | **Server only. Never rename this with a PUBLIC_ prefix.** |
| `SESSION_SALT` | 32 random characters | Any long random string; generate one and forget it |

Node 22 is selected in `netlify.toml`; you do not need to set it.

The two `PUBLIC_` values appear in your page source. That is expected. They
identify the `anon` role, whose entire capability is defined by the security
policies you ran in Step 2 — which is why the test suite spends thirteen of
its assertions proving that role can read published content and write nothing.

The service-role key bypasses all of it. It must only ever exist in this
Netlify settings page.

Deploy. You will get a URL like `pocket-perks-abc123.netlify.app`.

---

## Step 4 — Replace the placeholder artwork

Three files in `public/` are stand-ins I traced from your brand colours.
Swap them for exports of the real mark:

| File | What it is | Size |
|---|---|---|
| `public/logo.svg` | Full lockup, header and login | roughly 300×68 |
| `public/logo-mark-light.svg` | Pocket only, for the dark footer | square |
| `public/favicon.svg` | Browser tab icon | square, simple |
| `public/og-default.png` | **Missing — you need to add this** | exactly 1200×630 |

`og-default.png` is the picture Facebook shows when someone shares a link
that has no image of its own. Without it, shared links look broken. Anything
readable at thumbnail size works — the logo on a deep green field is fine.

---

## Step 5 — Enter your five businesses

Go to `<your-netlify-url>/admin` and sign in.

For each business: **Businesses → Add business**. Fill in the name, category,
town, phone, hours and address. Upload a logo and a cover photo — the site
resizes and converts them for you. Set the plan, then set the status to
**Live**.

Then **Deals → Add deal** for each offer. Set a real end date if the offer
has one; the deal comes off the site by itself when it passes, so you never
have to remember.

A business will not go Live without a phone number or a website. That is
deliberate — a listing with no way to contact anyone is worse than no listing.

While you are in there, check **Site content** and **Settings**. The hero
headline, the how-it-works steps, the newsletter wording, the footer links
and your contact email are all editable. Nothing on the public site is
hardcoded.

---

## Step 6 — Look at it on your phone

Not the desktop browser resized — an actual phone, on cell data, the way
someone scanning a QR code off a pizza box would.

Check that a deal is visible without scrolling, that the Call button dials,
that Get Directions opens Maps at the right place, and that sharing a deal to
Facebook shows the right picture and headline.

---

## Step 7 — Point the domain over

Only when you are happy with everything above.

Netlify → Domain management → Add custom domain → `yourpocketperks.com`.
Netlify walks you through the DNS change and issues the certificate.

Your existing QR codes and printed materials all point at the root domain,
which still works exactly as before. Nothing you have handed out breaks.

**Then go and delete the old Apps Script deployment.** While it exists, that
unauthenticated webhook is still live and still writable by anyone who reads
the old page source.

---

## After launch

**Check Reports before renewals.** `/admin/reports`, pick a business, set the
month, print to PDF. That is the conversation.

Numbers are rolled up overnight, so today's visits appear tomorrow morning.
The first day will look empty. That is correct, not broken.

**Submit the sitemap.** Google Search Console → add
`https://yourpocketperks.com/sitemap.xml`. It is generated from the database,
so it updates itself as you add businesses and never lists an expired deal.

**Watch the dashboard.** It surfaces deals expiring within a week, businesses
still sitting in draft, and unanswered enquiries. If nothing appears under
"Needs attention," there is nothing to do.

---

## If something goes wrong

**Build fails on Netlify.** Read the deploy log. It is almost always a
missing environment variable — the site refuses to start without the two
`PUBLIC_SUPABASE_` values rather than silently serving empty pages.

**Pages load but no businesses appear.** They are probably still in Draft.
Check `/admin/merchants?status=draft`.

**A deal you published is not showing.** Open it in the admin. The banner at
the top says exactly what the public sees: live, scheduled, or expired.

**"That could not be saved" on a form.** The message underneath says which
field and what to do. Those come from the database constraints, so if it
refuses, it is refusing for a reason.

**You changed something and want it back.** Every change to businesses,
deals, content and settings is written to `audit_log` with a full before
image. In Supabase SQL Editor:

```sql
select occurred_at, action, entity_type, before_data
from public.audit_log
order by occurred_at desc
limit 20;
```

Nothing you do in the admin is unrecoverable. Businesses and deals cannot be
deleted at all, only archived, and required navigation and content blocks
cannot be removed even on purpose.
