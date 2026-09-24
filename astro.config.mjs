// @ts-check
import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import { loadEnv } from 'vite';

// In `astro dev` only: make the server-only secrets in .env (the service-role
// key, the session salt) visible to process.env, as Netlify does in
// production. Builds are untouched, so no secret is ever written into the
// build output.
if (process.argv.includes('dev')) {
  for (const [key, value] of Object.entries(loadEnv('development', process.cwd(), ''))) {
    if (!key.startsWith('PUBLIC_') && process.env[key] === undefined) process.env[key] = value;
  }
}

// Server output with per-page opt-in to prerendering.
//
// Why not a static build: deal expiry is a live property of the database.
// A statically generated site would keep showing an expired offer until the
// next deploy, which is the exact failure the old free-text `expires` field
// caused. Pages instead render on request and are held at Netlify's CDN for
// five minutes (see the Cache-Control header each page sets), so they serve
// at near-static speed and go stale for at most five minutes.
//
// Why not a client-rendered SPA: merchant and deal pages are the site's
// entire organic search surface. They ship as real HTML.
export default defineConfig({
  site: 'https://yourpocketperks.com',
  output: 'server',
  adapter: netlify(),
  compressHTML: true,
  build: { inlineStylesheets: 'auto' },
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  devToolbar: { enabled: false },
  vite: {
    build: {
      // No source maps in production: they hand an attacker a readable map
      // of the client bundle for zero benefit to visitors.
      sourcemap: false,
    },
  },
});
