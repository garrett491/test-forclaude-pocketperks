import type { MediaAsset, MerchantHours, Deal, Merchant } from './types';

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL;

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

/**
 * Public URL for a stored image.
 *
 * Deliberately the plain object endpoint, not /storage/v1/render/image/.
 * Supabase's on-the-fly resizing is a Pro-plan feature; on the Free plan
 * every transform URL fails, which would break every logo and photo on the
 * site. Nothing is lost by avoiding it: the admin uploader already resizes
 * and re-encodes to WebP in the browser before the file is stored, so what
 * sits in the bucket is the size we want to serve.
 *
 * `width` is kept in the signature so callers still declare their intent and
 * so switching back to transforms later is a one-function change.
 */
export function imageUrl(
  asset: MediaAsset | null | undefined,
  _width?: number,
  _quality?: number
): string | null {
  if (!asset) return null;
  return `${SUPABASE_URL}/storage/v1/object/public/${asset.bucket_id}/${asset.storage_path}`;
}

/**
 * No srcset: a single already-right-sized WebP is served to everyone, because
 * without server-side transforms there is no second size to offer. Returning
 * null keeps the attribute off the tag rather than emitting a duplicate URL.
 */
export function imageSrcSet(_asset: MediaAsset | null | undefined, _width: number): string | null {
  return null;
}

/**
 * Every <img> gets real width and height so the browser reserves the space
 * before the file arrives. Missing dimensions are why the old site shifted
 * as it loaded, which is a Cumulative Layout Shift failure.
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

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / DAY_MS);
}

/**
 * Urgency copy, but only where it is true.
 *
 * Loss aversion is real and a genuine deadline is legitimate to state. A
 * manufactured one is a dark pattern, so nothing here fires unless the deal
 * actually carries an end date inside the window.
 */
export function expiryLabel(deal: Pick<Deal, 'ends_at'>): string | null {
  const days = daysUntil(deal.ends_at);
  if (days === null) return null;
  if (days < 0) return null;
  if (days === 0) return 'Ends today';
  if (days === 1) return 'Ends tomorrow';
  if (days <= 7) return `${days} days left`;
  return `Through ${new Date(deal.ends_at!).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })}`;
}

/** True only inside the last week of a dated deal. */
export function isEndingSoon(deal: Pick<Deal, 'ends_at'>): boolean {
  const days = daysUntil(deal.ends_at);
  return days !== null && days >= 0 && days <= 7;
}

/** "New" means added in the last 14 days. One definition, used everywhere. */
export function isNew(record: { created_at: string }): boolean {
  return Date.now() - new Date(record.created_at).getTime() < 14 * DAY_MS;
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
