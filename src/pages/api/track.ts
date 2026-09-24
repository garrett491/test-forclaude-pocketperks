import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
import { getAdminDb } from '../../lib/supabase';

export const prerender = false;

/**
 * The only write path for analytics.
 *
 * Everything that makes a merchant report trustworthy happens here rather
 * than in the browser: bot detection, per-IP rate limiting, and session
 * hashing. The client cannot set is_bot, cannot choose its own session id,
 * and cannot insert into the database at all.
 */

const ALLOWED_EVENTS = new Set([
  'merchant_view', 'deal_view', 'deal_open', 'code_copy', 'call_click',
  'directions_click', 'website_click', 'share', 'search',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BOT_PATTERN =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegram|preview|monitor|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|curl|wget|python-requests|axios|node-fetch|scrapy|semrush|ahrefs|mj12|dotbot|petal|bytespider/i;

/** Rotates daily, so a hash cannot be used to follow anyone across days. */
function sessionHash(ip: string, userAgent: string): string {
  const salt = process.env.SESSION_SALT ?? 'pocket-perks-dev-salt';
  const day = new Date().toISOString().slice(0, 10);
  return createHash('sha256').update(`${salt}|${day}|${ip}|${userAgent}`).digest('hex').slice(0, 32);
}

function clientIp(request: Request): string {
  return (
    request.headers.get('x-nf-client-connection-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

/**
 * Fixed-window counter in Postgres. 240 events per IP per minute is far
 * above real browsing and far below what a script needs to distort a report.
 */
async function overRateLimit(db: ReturnType<typeof getAdminDb>, ip: string): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const key = `track:${ip}`;

  const { data } = await db
    .from('rate_limits')
    .select('hit_count')
    .eq('bucket_key', key)
    .eq('window_start', windowStart)
    .maybeSingle();

  const count = (data?.hit_count ?? 0) + 1;
  if (count > 240) return true;

  await db.from('rate_limits').upsert(
    { bucket_key: key, window_start: windowStart, hit_count: count },
    { onConflict: 'bucket_key,window_start' }
  );
  return false;
}

// Always 204. A tracking endpoint that reports its internal state gives an
// attacker a probe and gives an honest visitor nothing.
const noContent = () => new Response(null, { status: 204 });

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return noContent();

    const eventType = String(body.event_type ?? '');
    if (!ALLOWED_EVENTS.has(eventType)) return noContent();

    const merchantId = typeof body.merchant_id === 'string' && UUID.test(body.merchant_id)
      ? body.merchant_id : null;
    const dealId = typeof body.deal_id === 'string' && UUID.test(body.deal_id)
      ? body.deal_id : null;

    // Every event that appears in a merchant's report must be attributable
    // to that merchant. Search is the one event that is deliberately not —
    // it tells us what people looked for, which is a signal about who to
    // sign next, and it belongs to nobody's performance figures.
    if (!merchantId && eventType !== 'search') return noContent();

    const userAgent = request.headers.get('user-agent') ?? '';
    const ip = clientIp(request);

    const db = getAdminDb();
    if (await overRateLimit(db, ip)) return noContent();

    await db.from('events').insert({
      event_type: eventType,
      merchant_id: merchantId,
      deal_id: dealId,
      session_hash: sessionHash(ip, userAgent),
      source: request.headers.get('referer') ? 'referral' : 'direct',
      path: typeof body.path === 'string' ? body.path.slice(0, 300) : null,
      // Flagged rather than dropped, so a bot rule can be corrected later
      // and rollup_events re-run for the affected days.
      is_bot: BOT_PATTERN.test(userAgent) || userAgent === '',
    });

    return noContent();
  } catch {
    // Analytics must never break a page. Swallow and move on.
    return noContent();
  }
};
