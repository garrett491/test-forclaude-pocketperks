import { purgeCache } from '@netlify/functions';
import { CACHE_TAG } from './queries';

/**
 * Clears every cached public page at Netlify's CDN.
 *
 * Called after admin saves. Public pages are held at the CDN for a minute
 * and served stale for up to ten while they refresh, which meant a change
 * saved in the dashboard could take minutes to appear — and "I saved it,
 * refreshed, and it didn't change" is indistinguishable from a save that
 * failed. Purging makes the next page view fresh.
 *
 * Outside Netlify (local development, tests) there is no CDN to purge, so
 * this does nothing. A failed purge is logged and never blocks the save:
 * the worst case is the old one-minute delay.
 */
export async function purgePublicCache(): Promise<void> {
  if (!process.env.NETLIFY_PURGE_API_TOKEN || !process.env.SITE_ID) return;
  try {
    await Promise.race([
      purgeCache({ tags: [CACHE_TAG] }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('purge timed out')), 4000)),
    ]);
  } catch (error) {
    console.warn('[pocket-perks] cache purge failed', error instanceof Error ? error.message : error);
  }
}
