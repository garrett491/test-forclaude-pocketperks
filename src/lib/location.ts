import type { AstroCookies } from 'astro';
import type { Town } from './types';

/**
 * Where the selected town comes from, and why it is a cookie.
 *
 * The choice has to be readable on the server, because every list on this
 * site is rendered on the server. Keeping it only in localStorage meant the
 * picker changed a label in the header and nothing else — the carousel
 * respected the town, the business directory did not, and Malvern businesses
 * turned up in a Carrollton visitor's list.
 *
 * Precedence, highest first:
 *   1. ?town=<slug> in the URL — an explicit, shareable request
 *   2. ?town=all — deliberately asking to see everything
 *   3. the /<town> page being viewed
 *   4. the pp_town cookie — what they chose last time ("all" included)
 *   5. the first active town, flagged isDefault so the homepage can ask
 *
 * Any page using this must send `Vary: Cookie`, or the CDN will hand one
 * visitor's town to the next visitor.
 */

export const TOWN_COOKIE = 'pp_town';

export interface TownContext {
  /** The town to filter by, or null when showing every town. */
  town: Town | null;
  /** True when the visitor explicitly asked for all towns. */
  showingAll: boolean;
  /** True when nothing has been chosen and we fell back to a default. */
  isDefault: boolean;
  towns: Town[];
}

export function resolveTownContext(
  url: URL,
  cookies: AstroCookies,
  towns: Town[],
  pathTownSlug?: string
): TownContext {
  const byslug = (slug?: string | null) => towns.find((t) => t.slug === slug) ?? null;
  const param = url.searchParams.get('town');

  if (param === 'all') {
    return { town: null, showingAll: true, isDefault: false, towns };
  }

  const fromParam = byslug(param);
  if (fromParam) return { town: fromParam, showingAll: false, isDefault: false, towns };

  const fromPath = byslug(pathTownSlug);
  if (fromPath) return { town: fromPath, showingAll: false, isDefault: false, towns };

  const cookie = cookies.get(TOWN_COOKIE)?.value;
  // "all" is a remembered choice too: someone who asked for every town
  // should not be asked to pick one again on their next visit.
  if (cookie === 'all') return { town: null, showingAll: true, isDefault: false, towns };
  const fromCookie = byslug(cookie);
  if (fromCookie) return { town: fromCookie, showingAll: false, isDefault: false, towns };

  // Only one town in the system means there is no choice to make, so this is
  // not really a default — it is the whole set.
  return {
    town: towns[0] ?? null,
    showingAll: false,
    isDefault: towns.length > 1,
    towns,
  };
}

/** The filter value to pass to the query layer. */
export function townFilter(context: TownContext): string | undefined {
  return context.showingAll ? undefined : context.town?.slug;
}

/**
 * Adds `town` to a URL so a filtered view is a real, shareable link rather
 * than something that only works for whoever has the right cookie.
 */
export function withTown(url: URL, slug: string | null): string {
  const next = new URL(url);
  next.searchParams.delete('page');
  if (slug) next.searchParams.set('town', slug);
  else next.searchParams.set('town', 'all');
  return next.pathname + next.search;
}
