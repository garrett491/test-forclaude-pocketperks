import { createServerClient } from '@supabase/ssr';
import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Admin session handling.
 *
 * The session lives in httpOnly cookies, so no access token is readable by
 * page JavaScript and an XSS bug cannot lift an admin session.
 *
 * Authorization is two separate checks, and both must pass:
 *   1. Supabase Auth says the JWT is valid  (authentication)
 *   2. A row exists in public.profiles      (authorization)
 *
 * The second is the one that matters. Anyone who somehow obtains an
 * auth.users account still has zero privileges without a profiles row, and
 * nothing in the application can create one — that is done by hand in the
 * Supabase dashboard. Compromising an admin session therefore cannot be
 * escalated into minting more admins.
 *
 * Note this client uses the ANON key, not the service role. Every admin
 * write is still evaluated against RLS with the administrator's own JWT, so
 * a bug in this code cannot exceed what the policies allow.
 */

/**
 * Astro's cookie API adapted to the shape @supabase/ssr expects.
 *
 * getAll parses the raw Cookie header rather than looking up fixed names,
 * because supabase-ssr chunks large session cookies into `name.0`, `name.1`
 * and so on. Guessing names loses the chunks and silently logs you out.
 */
export function cookieAdapter(cookies: AstroCookies, request: Request) {
  return {
    getAll: () => {
      const header = request.headers.get('cookie') ?? '';
      if (!header) return [];
      return header
        .split(';')
        .map((pair) => {
          const index = pair.indexOf('=');
          if (index < 0) return null;
          return {
            name: pair.slice(0, index).trim(),
            value: decodeURIComponent(pair.slice(index + 1).trim()),
          };
        })
        .filter((c): c is { name: string; value: string } => !!c && c.name !== '');
    },
    setAll: (list: { name: string; value: string; options?: Record<string, unknown> }[]) => {
      for (const { name, value, options } of list) {
        cookies.set(name, value, {
          path: '/',
          httpOnly: true,
          secure: import.meta.env.PROD,
          sameSite: 'lax',
          maxAge: 60 * 60 * 24 * 7,
          ...(options ?? {}),
        });
      }
    },
  };
}

export function getAuthClient(cookies: AstroCookies, request: Request): SupabaseClient {
  return createServerClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.PUBLIC_SUPABASE_ANON_KEY,
    { cookies: cookieAdapter(cookies, request) }
  );
}

export interface AdminProfile {
  id: string;
  role: 'owner' | 'admin';
  display_name: string;
  email: string | null;
}

/**
 * Returns the profile only when both checks pass. Uses getUser(), which
 * validates the token against Supabase, rather than getSession(), which
 * trusts whatever is in the cookie.
 */
export async function requireAdmin(
  cookies: AstroCookies,
  request: Request
): Promise<{ db: SupabaseClient; profile: AdminProfile } | null> {
  const db = getAuthClient(cookies, request);

  const { data: userData, error } = await db.auth.getUser();
  if (error || !userData?.user) return null;

  const { data: profile } = await db
    .from('profiles')
    .select('id, role, display_name')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (!profile) return null;

  return {
    db,
    profile: { ...(profile as Omit<AdminProfile, 'email'>), email: userData.user.email ?? null },
  };
}

/* ------------------------------------------------------------------ */
/* Form helpers                                                        */
/* ------------------------------------------------------------------ */

export type FormResult =
  | { ok: true; message: string; redirect?: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string> };

/** Trimmed string, or null when blank. Blank should be NULL, never "". */
export function str(form: FormData, key: string): string | null {
  const raw = form.get(key);
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

export function bool(form: FormData, key: string): boolean {
  return form.get(key) === 'on' || form.get(key) === 'true';
}

export function int(form: FormData, key: string, fallback = 0): number {
  const value = parseInt(String(form.get(key) ?? ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

/** datetime-local gives "2026-09-01T17:30" with no zone. Treat as Eastern. */
export function timestamp(form: FormData, key: string): string | null {
  const value = str(form, key);
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Renders an ISO timestamp back into a datetime-local input value. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Postgres errors, translated.
 *
 * Constraint violations carry the guardrails this system relies on, and a
 * raw "new row violates check constraint merchants_website_url" teaches an
 * operator nothing. These messages say what to do instead. Anything
 * unrecognised falls back to a generic line rather than leaking schema.
 */
export function humanError(error: { code?: string; message?: string } | null): string {
  if (!error) return 'Something went wrong. Nothing was saved.';
  const message = error.message ?? '';

  // Messages raised deliberately by our own triggers are already written
  // for a human. Pass them through.
  if (/plan, which includes|cannot be deleted|are archived, not deleted/.test(message)) {
    return message.replace(/^.*?ERROR:\s*/i, '');
  }

  if (error.code === '23505') return 'Something with that name or address already exists.';
  if (error.code === '23503') return 'That references a record that no longer exists. Reload and try again.';

  if (/merchants_website_url|merchants_facebook_url|merchants_instagram_url|nav_items_href_safe/.test(message))
    return 'Links must start with https:// and be a full web address.';
  if (/merchants_active_needs_phone_or_site/.test(message))
    return 'A live business needs a phone number or a website. Add one, or set the status back to Draft.';
  if (/merchants_zip_format/.test(message)) return 'ZIP code should be 5 digits, e.g. 44615.';
  if (/merchants_phone_e164/.test(message)) return 'That phone number is not a valid 10-digit US number.';
  if (/deals_window/.test(message)) return 'The end date has to be after the start date.';
  if (/deals_code_format/.test(message)) return 'Coupon codes can use letters, numbers, dots and dashes only.';
  if (/deals_headline_len/.test(message)) return 'The headline needs to be between 3 and 120 characters.';
  if (/_len\b/.test(message)) return 'One of the fields is too long. Shorten it and try again.';

  return 'That could not be saved. Check the fields and try again.';
}
