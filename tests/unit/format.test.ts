import { describe, expect, it } from 'vitest';
import {
  expiryLabel, daysUntil, isEndingSoon, zonedInputToIso, isoToZonedInput,
  imageUrl, imageSrcSet, aspectRatio, initials, telHref, groupedHours,
} from '../../src/lib/format';
import type { MediaAsset } from '../../src/lib/types';

// 10:00 in Ohio on Wed 24 Sep 2026 (EDT, UTC-4).
const NOW = new Date('2026-09-24T14:00:00Z');

describe('deal expiry wording, in Ohio time', () => {
  it('says "Ends today" for a deal ending tonight — not "tomorrow"', () => {
    expect(expiryLabel({ ends_at: '2026-09-25T03:59:00Z' }, NOW)).toBe('Ends today'); // 23:59 EDT
  });
  it('says "Ends tomorrow" only for tomorrow', () => {
    expect(expiryLabel({ ends_at: '2026-09-25T15:00:00Z' }, NOW)).toBe('Ends tomorrow');
  });
  it('counts calendar days within a week', () => {
    expect(expiryLabel({ ends_at: '2026-09-28T20:00:00Z' }, NOW)).toBe('Ends in 4 days');
  });
  it('gives the Ohio calendar date beyond a week', () => {
    // 01:00 UTC on Oct 14 is still Oct 13 in Ohio.
    expect(expiryLabel({ ends_at: '2026-10-14T01:00:00Z' }, NOW)).toBe('Ends Oct 13');
  });
  it('says nothing for no end date or a past one — no invented urgency', () => {
    expect(expiryLabel({ ends_at: null }, NOW)).toBeNull();
    expect(expiryLabel({ ends_at: '2026-09-24T13:00:00Z' }, NOW)).toBeNull();
    expect(daysUntil('not a date', NOW)).toBeNull();
  });
  it('treats only the last week as ending soon', () => {
    expect(isEndingSoon({ ends_at: '2026-09-30T12:00:00Z' }, NOW)).toBe(true);
    expect(isEndingSoon({ ends_at: '2026-10-30T12:00:00Z' }, NOW)).toBe(false);
  });
});

describe('admin date fields are Ohio time, not server time', () => {
  it('reads 23:59 typed in summer as 03:59 UTC the next day', () => {
    expect(zonedInputToIso('2026-09-30T23:59')).toBe('2026-10-01T03:59:00.000Z');
  });
  it('handles winter time (UTC-5)', () => {
    expect(zonedInputToIso('2026-12-31T23:59')).toBe('2027-01-01T04:59:00.000Z');
  });
  it('handles the day the clocks change', () => {
    expect(zonedInputToIso('2026-11-01T12:00')).toBe('2026-11-01T17:00:00.000Z');
    expect(zonedInputToIso('2026-03-08T12:00')).toBe('2026-03-08T16:00:00.000Z');
  });
  it('round-trips back into the field unchanged', () => {
    for (const value of ['2026-09-30T23:59', '2026-12-31T00:00', '2027-06-15T08:30']) {
      expect(isoToZonedInput(zonedInputToIso(value))).toBe(value);
    }
  });
  it('rejects anything that is not a date-time', () => {
    expect(zonedInputToIso('')).toBeNull();
    expect(zonedInputToIso('tomorrow')).toBeNull();
    expect(isoToZonedInput(null)).toBe('');
  });
});

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  id: 'x', bucket_id: 'merchant-media', storage_path: 'uploads/2026/a.webp',
  alt_text: '', width: 1600, height: 900, ...over,
});

describe('images', () => {
  it('uses the plain public object URL, never the paid-plan transform endpoint', () => {
    expect(imageUrl(asset())).toBe('https://example.supabase.co/storage/v1/object/public/merchant-media/uploads/2026/a.webp');
    expect(imageUrl(asset())).not.toContain('/render/image/');
  });
  it('picks the small copy for small slots, and the original for big ones', () => {
    const withSmall = asset({ variants: [{ w: 640, h: 360, path: 'uploads/2026/a-640.webp' }] });
    expect(imageUrl(withSmall, 400)).toContain('a-640.webp');
    expect(imageUrl(withSmall, 1200)).toContain('a.webp');
    expect(imageSrcSet(withSmall)).toBe(
      'https://example.supabase.co/storage/v1/object/public/merchant-media/uploads/2026/a-640.webp 640w, '
      + 'https://example.supabase.co/storage/v1/object/public/merchant-media/uploads/2026/a.webp 1600w');
  });
  it('offers no srcset when there is only one file', () => {
    expect(imageSrcSet(asset())).toBeNull();
    expect(imageSrcSet(null)).toBeNull();
  });
  it('knows the shape, or admits it does not', () => {
    expect(aspectRatio(asset())).toBeCloseTo(16 / 9);
    expect(aspectRatio(asset({ width: null }))).toBeNull();
  });
  it('makes initials for the fallback tile', () => {
    expect(initials('Crossroads Pizza')).toBe('CP');
    expect(initials("Mary's & Sons Bakery")).toBe('MS');
  });
});

describe('contact links', () => {
  it('builds a dialable tel: link from the stored number', () => {
    expect(telHref({ phone_e164: '+13305550142' })).toBe('tel:+13305550142');
    expect(telHref({ phone_e164: null })).toBeNull();
  });
  it('collapses matching days of hours', () => {
    const hours = [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, is_closed: false, opens_at: '09:00:00', closes_at: '17:00:00' }));
    expect(groupedHours([...hours, { day_of_week: 0, is_closed: true, opens_at: null, closes_at: null }]))
      .toEqual(['Mon–Fri · 9 AM – 5 PM', 'Sun · Closed']);
  });
});
