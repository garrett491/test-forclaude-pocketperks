import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { getAdminDb } from '../../lib/supabase';
import { logDataError } from '../../lib/errors';
import { getSiteChrome } from '../../lib/queries';

export const prerender = false;

const EMAIL = /^[^@\s]+@[^@\s.]+\.[a-z]{2,}$/i;

/**
 * Addresses that are always a mistake, and free-mail typos worth catching
 * before they become a permanent bounce on the list.
 */
const TYPOS: Record<string, string> = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'yahooo.com': 'yahoo.com', 'hotmial.com': 'hotmail.com', 'outlok.com': 'outlook.com',
};

function clientIp(request: Request): string {
  return (
    request.headers.get('x-nf-client-connection-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

function ipHash(ip: string): string {
  const salt = process.env.SESSION_SALT ?? 'pocket-perks-dev-salt';
  return createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 32);
}

/**
 * JSON for the script-driven form. A plain form post (JavaScript off or
 * failed) gets a redirect to a readable result page instead of raw JSON.
 */
const replier = (replyAsPage: boolean) => (status: number, message: string, extra: Record<string, unknown> = {}) =>
  replyAsPage
    ? new Response(null, {
        status: 303,
        headers: { Location: `/newsletter?status=${status < 300 ? 'ok' : status === 429 ? 'limited' : status === 400 ? 'invalid' : 'error'}` },
      })
    : new Response(JSON.stringify({ message, ...extra }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });

async function overRateLimit(db: ReturnType<typeof getAdminDb>, ip: string): Promise<boolean> {
  // Five signups per IP per hour. A household or a coffee shop stays under
  // it; a script does not.
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
  const key = `subscribe:${ip}`;

  const { data } = await db
    .from('rate_limits')
    .select('hit_count')
    .eq('bucket_key', key)
    .eq('window_start', windowStart)
    .maybeSingle();

  const count = (data?.hit_count ?? 0) + 1;
  if (count > 5) return true;

  await db.from('rate_limits').upsert(
    { bucket_key: key, window_start: windowStart, hit_count: count },
    { onConflict: 'bucket_key,window_start' }
  );
  return false;
}

export const POST: APIRoute = async ({ request }) => {
  const json = replier(!request.headers.get('content-type')?.includes('application/json'));
  let body: any;
  try {
    body = request.headers.get('content-type')?.includes('application/json')
      ? await request.json()
      : Object.fromEntries(await request.formData());
  } catch {
    return json(400, 'That request could not be read. Try again.');
  }

  // Honeypot. A real person never sees this field, so a value in it means a
  // script filled the form. Return success so the bot stops retrying.
  if (typeof body.company === 'string' && body.company.trim() !== '') {
    return json(200, "You're on the list.");
  }

  const email = String(body.email ?? '').trim().toLowerCase();

  if (!email || !EMAIL.test(email) || email.length > 254) {
    return json(400, 'That address does not look right. Check it and try again.');
  }

  const [local, domain] = email.split('@');
  if (domain && TYPOS[domain]) {
    return json(400, `Did you mean ${local}@${TYPOS[domain]}?`);
  }

  const ip = clientIp(request);

  try {
    const db = getAdminDb();

    if (await overRateLimit(db, ip)) {
      return json(429, 'Too many signups from this connection. Try again later.');
    }

    const source = typeof body.source === 'string' ? body.source.slice(0, 60) : 'unknown';
    const referrer = request.headers.get('referer')?.slice(0, 500) ?? null;
    const path = typeof body.path === 'string' ? body.path.slice(0, 300) : null;

    // A record of what the person agreed to, in the words they were shown.
    // Read from the database rather than trusted from the browser.
    const { blocks } = await getSiteChrome();
    const copy = (blocks['home.newsletter']?.payload ?? {}) as Record<string, string>;
    const consentText = [
      copy.headline || 'New deals, once a week',
      copy.body || 'One email each week with what is new from local businesses.',
      copy.fine_print || 'We only email about local deals. Unsubscribe any time.',
    ].join(' — ').slice(0, 500);
    const consent = { consent_text: consentText, consent_at: new Date().toISOString(), consent_path: path };

    const { data: existing, error: lookupError } = await db
      .from('subscribers').select('id, status').eq('email', email).maybeSingle();
    if (lookupError) throw lookupError;

    let error: { code?: string } | null = null;
    if (!existing) {
      ({ error } = await db.from('subscribers').insert({
        email, status: 'active', source, referrer, ip_hash: ipHash(ip),
        utm: typeof body.utm === 'object' && body.utm ? body.utm : {},
        ...consent,
      }));
      // Legacy database without the consent columns: store the signup anyway.
      if (error?.code === 'PGRST204' || error?.code === '42703') {
        ({ error } = await db.from('subscribers').insert({
          email, status: 'active', source, referrer, ip_hash: ipHash(ip),
          utm: typeof body.utm === 'object' && body.utm ? body.utm : {},
        }));
      }
    } else if (existing.status !== 'active') {
      // Someone who left and has now deliberately signed up again is back
      // on the list, with the new consent recorded. Previously they were
      // told "you're on the list" and silently stayed unsubscribed.
      ({ error } = await db.from('subscribers')
        .update({ status: 'active', unsubscribed_at: null, source, ...consent })
        .eq('id', existing.id));
      if (error?.code === 'PGRST204' || error?.code === '42703') {
        ({ error } = await db.from('subscribers')
          .update({ status: 'active', unsubscribed_at: null, source })
          .eq('id', existing.id));
      }
    }

    // Two taps of the button can race; the second finding the first is fine.
    if (error?.code === '23505') error = null;

    if (error) {
      // Log the failure, but never return the database message to the
      // browser — error text leaks schema detail.
      console.error('subscribe failed', error.code);
      return json(500, 'That did not save. Try again in a moment.');
    }

    return json(200, "You're on the list. Watch your inbox.");
  } catch (err) {
    logDataError('subscribe', err);
    return json(500, 'That did not save. Try again in a moment.');
  }
};

export const GET: APIRoute = () => new Response(null, { status: 405, headers: { Allow: 'POST' } });
