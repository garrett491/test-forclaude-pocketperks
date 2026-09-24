import type { APIRoute } from 'astro';
import { publicDb } from '../lib/supabase';
import { logDataError } from '../lib/errors';

export const prerender = false;

/**
 * Generated from the database rather than a build-time file list, because
 * merchants and deals are added through the dashboard without a deploy —
 * a static sitemap would go stale the moment it shipped.
 *
 * RLS means only published, in-window records appear, so an expired deal
 * cannot be submitted to Google.
 */
export const GET: APIRoute = async ({ site }) => {
  const origin = (import.meta.env.PUBLIC_SITE_URL ?? site?.href ?? '').replace(/\/$/, '');

  const [merchants, deals, towns, categories] = await Promise.all([
    publicDb.from('merchants').select('slug, updated_at'),
    publicDb.from('deals').select('slug, updated_at, merchant:merchants!inner ( slug )'),
    publicDb.from('towns').select('slug, updated_at'),
    publicDb.from('categories').select('slug, updated_at'),
  ]);

  // An empty sitemap served during an outage would tell Google every page
  // had gone. A 503 tells it to come back later instead.
  const failed = [merchants, deals, towns, categories].find((r) => r.error);
  if (failed?.error) {
    logDataError('sitemap', failed.error);
    return new Response('Temporarily unavailable', {
      status: 503,
      headers: { 'Retry-After': '300', 'Cache-Control': 'private, no-store' },
    });
  }

  const entry = (path: string, lastmod?: string, priority = '0.6', freq = 'weekly') =>
    `  <url>\n    <loc>${origin}${path.replace(/&/g, '&amp;')}</loc>\n` +
    (lastmod ? `    <lastmod>${new Date(lastmod).toISOString().slice(0, 10)}</lastmod>\n` : '') +
    `    <changefreq>${freq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

  const urls: string[] = [
    entry('/', undefined, '1.0', 'daily'),
    entry('/deals', undefined, '0.9', 'daily'),
    entry('/businesses', undefined, '0.8', 'weekly'),
    entry('/for-business', undefined, '0.5', 'monthly'),
    entry('/privacy', undefined, '0.2', 'yearly'),
    entry('/terms', undefined, '0.2', 'yearly'),
    entry('/accessibility', undefined, '0.2', 'yearly'),
  ];

  for (const t of towns.data ?? []) urls.push(entry(`/${t.slug}`, t.updated_at, '0.7'));
  for (const c of categories.data ?? []) urls.push(entry(`/deals?category=${c.slug}`, c.updated_at, '0.6'));
  for (const m of merchants.data ?? []) urls.push(entry(`/b/${m.slug}`, m.updated_at, '0.8'));
  for (const d of (deals.data ?? []) as any[]) {
    if (d.merchant?.slug) urls.push(entry(`/b/${d.merchant.slug}/${d.slug}`, d.updated_at, '0.7', 'daily'));
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400',
    },
  });
};
