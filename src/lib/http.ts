import type { AstroGlobal } from 'astro';
import { CACHE_PUBLIC, CACHE_NONE, CACHE_TAG, CACHE_NOT_FOUND } from './queries';
import { TOWN_COOKIE } from './location';

/**
 * Response headers for public pages, set in one place.
 *
 * These must be set in a page's frontmatter, before rendering starts.
 * Pages stream, and a header added later — from inside the layout, say — can
 * arrive after the response has already begun and silently never be sent.
 */

type Page = Pick<AstroGlobal, 'response'>;

/**
 * A normal public page: cached at the CDN for a minute, purgeable by tag
 * when the admin saves something.
 *
 * `varyByTown` for pages whose content depends on the remembered town.
 * Without it the CDN would hand one visitor's town to the next visitor.
 */
export function cachePublic(page: Page, { varyByTown = false } = {}) {
  page.response.headers.set('Cache-Control', CACHE_PUBLIC);
  page.response.headers.set('Netlify-Cache-Tag', CACHE_TAG);
  if (varyByTown) {
    page.response.headers.set('Vary', 'Cookie');
    page.response.headers.set('Netlify-Vary', `cookie=${TOWN_COOKIE}`);
  }
}

/** Not found: a real 404, cached only briefly. */
export function cacheNotFound(page: Page) {
  page.response.status = 404;
  page.response.headers.set('Cache-Control', CACHE_NOT_FOUND);
  page.response.headers.set('Netlify-Cache-Tag', CACHE_TAG);
}

/**
 * The database could not answer. 503 with Retry-After, never cached, so
 * the very next request tries again rather than being served this notice
 * from the CDN for the next ten minutes.
 */
export function markUnavailable(page: Page) {
  page.response.status = 503;
  page.response.headers.set('Cache-Control', CACHE_NONE);
  page.response.headers.set('Retry-After', '30');
}
