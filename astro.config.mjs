// @ts-check
import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';

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
  vite: {
    build: {
      // No source maps in production: they hand an attacker a readable map
      // of the client bundle for zero benefit to visitors.
      sourcemap: false,
    },
  },
});
