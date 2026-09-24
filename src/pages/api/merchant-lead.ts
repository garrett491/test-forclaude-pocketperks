import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { getAdminDb } from '../../lib/supabase';
import { logDataError } from '../../lib/errors';

export const prerender = false;

const EMAIL = /^[^@\s]+@[^@\s.]+\.[a-z]{2,}$/i;

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

/** JSON for the script-driven form; a plain form post is sent back to the page. */
const replier = (asPage: boolean) => (status: number, message: string) =>
  asPage
    ? new Response(null, {
        status: 303,
        headers: { Location: `/for-business?enquiry=${status < 300 ? 'ok' : status === 429 ? 'limited' : status === 400 ? 'invalid' : 'error'}#enquiry` },
      })
    : new Response(JSON.stringify({ message }), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });

export const GET: APIRoute = () => new Response(null, { status: 405, headers: { Allow: 'POST' } });

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

  // Honeypot, same as the newsletter form.
  if (typeof body.company_url === 'string' && body.company_url.trim() !== '') {
    return json(200, 'Thanks — we will be in touch.');
  }

  const businessName = String(body.business_name ?? '').trim();
  const contactName = String(body.contact_name ?? '').trim();
  const phone = String(body.phone ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();

  if (!businessName || !contactName || !phone) {
    return json(400, 'Business name, your name and a phone number are all needed.');
  }
  if (!email || !EMAIL.test(email)) {
    return json(400, 'That email address does not look right.');
  }

  const ip = clientIp(request);

  try {
    const db = getAdminDb();

    // Three enquiries per IP per hour. Nobody legitimately fills this in
    // more often than that.
    const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
    const key = `lead:${ip}`;
    const { data: limitRow } = await db
      .from('rate_limits').select('hit_count')
      .eq('bucket_key', key).eq('window_start', windowStart).maybeSingle();

    const count = (limitRow?.hit_count ?? 0) + 1;
    if (count > 3) return json(429, 'Too many enquiries from this connection. Try again later.');

    await db.from('rate_limits').upsert(
      { bucket_key: key, window_start: windowStart, hit_count: count },
      { onConflict: 'bucket_key,window_start' }
    );

    const { error } = await db.from('merchant_leads').insert({
      business_name: businessName.slice(0, 120),
      contact_name: contactName.slice(0, 120),
      phone: phone.slice(0, 40),
      email,
      town_text: typeof body.town === 'string' ? body.town.trim().slice(0, 80) : null,
      message: typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : null,
      status: 'new',
      ip_hash: ipHash(ip),
    });

    if (error) {
      console.error('lead insert failed', error.code);
      return json(500, 'That did not send. Try again, or email us directly.');
    }

    return json(200, 'Got it. We will be in touch within a day or two.');
  } catch (err) {
    logDataError('lead', err);
    return json(500, 'That did not send. Try again, or email us directly.');
  }
};
