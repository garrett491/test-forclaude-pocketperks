import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Two clients, and the distinction between them is the whole security model.
 *
 * `publicDb` uses the anon key. It is subject to every Row Level Security
 * policy, so it can read published content and write nothing. It is safe on
 * any page, and safe in the browser.
 *
 * `adminDb` uses the service-role key, which bypasses RLS entirely. It is
 * created lazily and only inside Netlify Functions, and reads a variable
 * without the PUBLIC_ prefix, which Astro never ships to the browser.
 */

const url = import.meta.env.PUBLIC_SUPABASE_URL;
const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

/** False when the Supabase variables are missing from this deployment. */
export const isConfigured = Boolean(url && anonKey);

if (!isConfigured) {
  // Loud in the logs, but not fatal: every page renders a friendly
  // "temporarily unavailable" notice instead of a bare 500.
  console.error(
    '[pocket-perks] PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY is missing. ' +
      'Set both in Netlify → Site configuration → Environment variables.'
  );
}

/**
 * Failing fast when Supabase is down.
 *
 * Netlify stops a function after ten seconds and shows its own bare error
 * page. A paused or overloaded project can hold a connection open and never
 * answer, and the client library also retries a 503 three times with
 * back-off (1s, 2s, 4s) — for every query on the page. Together that meant
 * an outage produced a long wait and then a crash page, never our friendly
 * "try again" notice.
 *
 * So: no automatic retries, a six-second deadline per request, and once a
 * request has failed, everything for the next five seconds fails at once
 * instead of each waiting out its own deadline. The visitor sees the notice
 * within a few seconds, and the site recovers by itself as soon as
 * Supabase does.
 */
const REQUEST_TIMEOUT_MS = 6000;
const FAIL_FAST_MS = 5000;
let unavailableUntil = 0;

const fetchWithTimeout: typeof fetch = async (input, init) => {
  if (Date.now() < unavailableUntil) {
    throw new TypeError('Supabase was unreachable a moment ago; not waiting on it again yet');
  }
  try {
    const response = await fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status >= 500) unavailableUntil = Date.now() + FAIL_FAST_MS;
    return response;
  } catch (error) {
    unavailableUntil = Date.now() + FAIL_FAST_MS;
    throw error;
  }
};

export const publicDb: SupabaseClient = createClient(
  url || 'http://127.0.0.1:9',
  anonKey || 'not-configured',
  {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { retry: false },
    global: { headers: { 'x-application-name': 'pocket-perks-web' }, fetch: fetchWithTimeout },
  }
);

let cachedAdmin: SupabaseClient | null = null;

/**
 * Server-only. Call from API routes that must write where the public
 * cannot: signups, enquiries, analytics, unsubscribes.
 * Never from a page that renders public content.
 */
export function getAdminDb(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey || !url) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set. This function cannot run without it.');
  }
  if (!cachedAdmin) {
    cachedAdmin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { retry: false },
      global: { fetch: fetchWithTimeout },
    });
  }
  return cachedAdmin;
}
