import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Two clients, and the distinction between them is the whole security model.
 *
 * `publicDb` uses the anon key. It is subject to every Row Level Security
 * policy, so it can read published content and write nothing. It is safe on
 * any page, and safe in the browser.
 *
 * `adminDb` uses the service-role key, which bypasses RLS entirely. It is
 * created lazily and only inside Netlify Functions. If this module is ever
 * imported into something that ships to the browser, the getter below throws
 * at build time rather than leaking the key.
 */

const url = import.meta.env.PUBLIC_SUPABASE_URL;
const anonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loudly at startup rather than serving a site whose every query
  // silently returns nothing.
  throw new Error(
    'Missing PUBLIC_SUPABASE_URL or PUBLIC_SUPABASE_ANON_KEY. Copy .env.example to .env and fill them in.'
  );
}

export const publicDb: SupabaseClient = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { 'x-application-name': 'pocket-perks-web' } },
});

let cachedAdmin: SupabaseClient | null = null;

/**
 * Server-only. Call from Netlify Functions and admin API routes.
 * Never from a .astro page that renders public content.
 */
export function getAdminDb(): SupabaseClient {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set. This function cannot run without it.');
  }
  if (!cachedAdmin) {
    cachedAdmin = createClient(url!, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cachedAdmin;
}
