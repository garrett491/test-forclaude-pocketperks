import type { MediaAsset, MerchantHours, Deal, Merchant } from './types';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL;

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

function publicObjectUrl(bucket: string, path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * Public URL for a stored image.
 *
 * Deliberately the plain object endpoint, not /storage/v1/render/image/:
 * Supabase's on-the-fly resizing is a paid-plan feature and every transform
 * URL fails on the Free plan. Instead the admin uploader stores a small copy
 * alongside the original (see `variants`), and pages choose between them
 * with srcset.
 *
 * With a `width`, returns the smallest stored copy at least that wide, so a
 * thumbnail never downloads a 1600px original.
 */
export function imageUrl(
  asset: MediaAsset | null | undefined,
  width?: number,
  _quality?: number
): string | null {
  if (!asset) return null;
  if (width && asset.variants?.length) {
    const fit = [...asset.variants]
      .sort((a, b) => a.w - b.w)
      .find((v) => v.w >= width || v.h >= width);
    if (fit) return publicObjectUrl(asset.bucket_id, fit.path);
  }
  return publicObjectUrl(asset.bucket_id, asset.storage_path);
}

/**
 * srcset across the stored copies and the original. Null when there is only
 * one file, which keeps a pointless attribute off the tag.
 */
export function imageSrcSet(asset: MediaAsset | null | undefined, _width?: number): string | null {
  if (!asset?.variants?.length || !asset.width) return null;
  const entries = asset.variants
    .filter((v) => v.w > 0 && v.w < asset.width!)
    .sort((a, b) => a.w - b.w)
    .map((v) => `${publicObjectUrl(asset.bucket_id, v.path)} ${v.w}w`);
  if (!entries.length) return null;
  entries.push(`${publicObjectUrl(asset.bucket_id, asset.storage_path)} ${asset.width}w`);
  return entries.join(', ');
}

/** Width divided by height, or null when the upload has no recorded size. */
export function aspectRatio(asset: MediaAsset | null | undefined): number | null {
  if (!asset?.width || !asset?.height) return null;
  return asset.width / asset.height;
}

/**
 * Every <img> gets real width and height so the browser reserves the space
 * before the file arrives, which is what stops the page jumping as it loads.
 */
export function imageDimensions(
  asset: MediaAsset | null | undefined,
  renderWidth: number
): { width: number; height: number } {
  if (!asset?.width || !asset?.height) {
    return { width: renderWidth, height: Math.round(renderWidth * 0.66) };
  }
  return {
    width: renderWidth,
    height: Math.round((asset.height / asset.width) * renderWidth),
  };
}

/* ------------------------------------------------------------------ */
/* Text                                                                */
/* ------------------------------------------------------------------ */

/** Initials fallback when a merchant has no logo yet. */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, clean.lastIndexOf(' ', max - 1)).trimEnd() + '…';
}

/* ------------------------------------------------------------------ */
/* Deals                                                               */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/**
 * Every business on Pocket Perks is in Ohio, and "ends today" means today
 * where the business is — not wherever the server or the phone happens to
 * be. All calendar arithmetic runs in this zone.
 */
export const SITE_TIME_ZONE = 'America/New_York';

/** The calendar date in the site's zone, as a day count usable for subtraction. */
function localDayNumber(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Math.floor(Date.UTC(get('year'), get('month') - 1, get('day')) / DAY_MS);
}

/**
 * Whole calendar days until a moment: 0 means later today, 1 tomorrow.
 * Null for no date, negative once it has passed.
 */
export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const end = new Date(iso);
  if (Number.isNaN(end.getTime())) return null;
  if (end.getTime() <= now.getTime()) return -1;
  return localDayNumber(end) - localDayNumber(now);
}

/**
 * Urgency copy, but only where it is true.
 *
 * A genuine deadline is legitimate to state. A manufactured one is a dark
 * pattern, so nothing here fires unless the deal actually carries an end
 * date.
 */
export function expiryLabel(deal: Pick<Deal, 'ends_at'>, now: Date = new Date()): string | null {
  const days = daysUntil(deal.ends_at, now);
  if (days === null || days < 0) return null;
  if (days === 0) return 'Ends today';
  if (days === 1) return 'Ends tomorrow';
  if (days <= 7) return `Ends in ${days} days`;
  return `Ends ${new Date(deal.ends_at!).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: SITE_TIME_ZONE,
  })}`;
}

/** True only inside the last week of a dated deal. */
export function isEndingSoon(deal: Pick<Deal, 'ends_at'>, now: Date = new Date()): boolean {
  const days = daysUntil(deal.ends_at, now);
  return days !== null && days >= 0 && days <= 7;
}

/** "New" means added in the last 14 days. One definition, used everywhere. */
export function isNew(record: { created_at: string }, now: Date = new Date()): boolean {
  return now.getTime() - new Date(record.created_at).getTime() < 14 * DAY_MS;
}

/** Offset of the site zone from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * "2026-10-14T23:59" typed into an admin date field, read as Ohio time.
 *
 * A bare date-time has no zone. Parsed with `new Date()` on a server running
 * in UTC it became 23:59 UTC — 7:59 PM in Ohio — so a deal set to end at
 * midnight came off the site four hours early.
 */
export function zonedInputToIso(value: string | null | undefined): string | null {
  const m = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  const wall = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  let guess = wall - zoneOffsetMs(wall);
  // Once more, in case the first guess landed on the other side of a DST change.
  guess = wall - zoneOffsetMs(guess);
  return new Date(guess).toISOString();
}

/** The reverse: an ISO timestamp as an Ohio-time value for a date field. */
export function isoToZonedInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SITE_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** "Oct 14, 2026" in the site's zone, for admin tables. */
export function formatDate(iso: string | null | undefined, withYear = true): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: SITE_TIME_ZONE,
  });
}

/* ------------------------------------------------------------------ */
/* Contact                                                             */
/* ------------------------------------------------------------------ */

export function telHref(merchant: Pick<Merchant, 'phone_e164'>): string | null {
  return merchant.phone_e164 ? `tel:${merchant.phone_e164}` : null;
}

export function directionsHref(m: Merchant): string | null {
  if (m.latitude != null && m.longitude != null) {
    return `https://www.google.com/maps/search/?api=1&query=${m.latitude},${m.longitude}`;
  }
  const parts = [m.name, m.address_line1, m.city, m.state_code, m.postal_code].filter(Boolean);
  if (parts.length < 2) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(', '))}`;
}

export function formatAddress(m: Merchant): string | null {
  const street = [m.address_line1, m.address_line2].filter(Boolean).join(', ');
  const region = [m.city, m.state_code].filter(Boolean).join(', ');
  const full = [street, region, m.postal_code].filter(Boolean).join(' · ');
  return full || null;
}

/** Strip the scheme and any trailing slash so links read as a domain. */
export function displayUrl(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/* ------------------------------------------------------------------ */
/* Hours                                                               */
/* ------------------------------------------------------------------ */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayName(dow: number, short = false): string {
  return (short ? DAY_SHORT : DAY_NAMES)[dow] ?? '';
}

/** "9:00 AM". Accepts Postgres time values like "09:00:00". */
export function formatTime(time: string | null): string {
  if (!time) return '';
  const [h = '0', m = '0'] = time.split(':');
  const hour = parseInt(h, 10);
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return m === '00' ? `${display} ${suffix}` : `${display}:${m} ${suffix}`;
}

/**
 * Open-now status.
 *
 * Computed in America/New_York rather than the visitor's clock, because a
 * merchant is open on their local time no matter where the phone is. Closing
 * times past midnight are handled by treating them as belonging to the
 * previous day.
 */
export function openStatus(hours: MerchantHours[] | undefined): {
  isOpen: boolean;
  label: string;
} | null {
  if (!hours?.length) return null;

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const dow = DAY_SHORT.indexOf(parts.weekday ?? '');
  if (dow < 0) return null;
  const nowMin = parseInt(parts.hour ?? '0', 10) * 60 + parseInt(parts.minute ?? '0', 10);

  const toMin = (t: string) => {
    const [h = '0', m = '0'] = t.split(':');
    return parseInt(h, 10) * 60 + parseInt(m, 10);
  };

  const today = hours.find((h) => h.day_of_week === dow);
  if (today && !today.is_closed && today.opens_at && today.closes_at) {
    const open = toMin(today.opens_at);
    let close = toMin(today.closes_at);
    if (close <= open) close += 1440;
    if (nowMin >= open && nowMin < close) {
      const until = close - nowMin;
      return {
        isOpen: true,
        label: until <= 60 ? `Open · closes in ${until} min` : `Open until ${formatTime(today.closes_at)}`,
      };
    }
    if (nowMin < open) {
      return { isOpen: false, label: `Opens at ${formatTime(today.opens_at)}` };
    }
  }

  for (let i = 1; i <= 7; i++) {
    const next = hours.find((h) => h.day_of_week === (dow + i) % 7);
    if (next && !next.is_closed && next.opens_at) {
      const when = i === 1 ? 'tomorrow' : dayName((dow + i) % 7);
      return { isOpen: false, label: `Opens ${when} at ${formatTime(next.opens_at)}` };
    }
  }
  return { isOpen: false, label: 'Closed' };
}

/** Collapses consecutive identical days: "Mon–Fri 9 AM – 5 PM". */
export function groupedHours(hours: MerchantHours[] | undefined): string[] {
  if (!hours?.length) return [];
  const ordered = [1, 2, 3, 4, 5, 6, 0]
    .map((d) => hours.find((h) => h.day_of_week === d))
    .filter(Boolean) as MerchantHours[];

  const key = (h: MerchantHours) => (h.is_closed ? 'closed' : `${h.opens_at}-${h.closes_at}`);
  const out: string[] = [];
  let runStart = 0;

  for (let i = 1; i <= ordered.length; i++) {
    if (i === ordered.length || key(ordered[i]!) !== key(ordered[runStart]!)) {
      const first = ordered[runStart]!;
      const last = ordered[i - 1]!;
      const days =
        runStart === i - 1
          ? dayName(first.day_of_week, true)
          : `${dayName(first.day_of_week, true)}–${dayName(last.day_of_week, true)}`;
      const time = first.is_closed
        ? 'Closed'
        : `${formatTime(first.opens_at)} – ${formatTime(first.closes_at)}`;
      out.push(`${days} · ${time}`);
      runStart = i;
    }
  }
  return out;
}
