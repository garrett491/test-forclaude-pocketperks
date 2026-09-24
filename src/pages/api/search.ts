import type { APIRoute } from 'astro';
import { searchEverything, getTowns } from '../../lib/queries';
import { resolveTownContext, townFilter } from '../../lib/location';
import { logDataError } from '../../lib/errors';
import { cardDeals } from '../../lib/listing';

export const prerender = false;

/**
 * Suggestions for the homepage search box: a short, flat list of places to
 * go — a deal or a business — as the visitor types.
 *
 * Read-only, anon-scoped, bounded by the same Row Level Security as
 * everything else. The full results grid uses /search-results instead.
 */
export const GET: APIRoute = async ({ url, cookies, locals }) => {
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex',
  };

  if (query.length < 2) return new Response(JSON.stringify({ results: [], total: 0 }), { headers });

  try {
    const towns = await getTowns(locals);
    const context = resolveTownContext(url, cookies, towns);
    const found = await searchEverything(query, townFilter(context));

    const results: { title: string; subtitle: string; href: string }[] = [];
    for (const m of found.cards) {
      const { shown } = cardDeals(m.deals, 2);
      for (const deal of shown) {
        results.push({
          title: deal.headline,
          subtitle: [m.name, m.town?.name].filter(Boolean).join(' · '),
          href: `/b/${m.slug}/${deal.slug}`,
        });
      }
    }
    for (const m of [...found.cards, ...found.quiet]) {
      results.push({
        title: m.name,
        subtitle: [m.category?.name, m.town?.name].filter(Boolean).join(' · '),
        href: `/b/${m.slug}`,
      });
    }
    return new Response(JSON.stringify({ results: results.slice(0, 8), total: found.total }), { headers });
  } catch (error) {
    logDataError('search suggestions', error);
    return new Response(JSON.stringify({ results: [], total: 0, error: true }), { status: 503, headers });
  }
};
