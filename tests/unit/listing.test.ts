import { describe, expect, it } from 'vitest';
import {
  cardDeals, moreDealsLabel, groupDealsByMerchant, compareMerchants, paginate, safeTerm, CARD_DEAL_LIMIT,
} from '../../src/lib/listing';
import type { Deal, Merchant } from '../../src/lib/types';

const merchant = (over: Partial<Merchant> = {}): Merchant => ({
  id: 'm1', slug: 'crossroads-pizza', name: 'Crossroads Pizza', tagline: null, description: null,
  address_line1: null, address_line2: null, city: null, state_code: 'OH', postal_code: null,
  latitude: null, longitude: null, phone_display: null, phone_e164: null, website_url: null,
  facebook_url: null, instagram_url: null, tier: 'standard', category_id: 'c', town_id: 't',
  is_featured: false, display_priority: 0, seo_title: null, seo_description: null,
  created_at: '2026-01-01T00:00:00Z', published_at: null, category: null, town: null, logo: null, cover: null,
  ...over,
});

let n = 0;
const deal = (over: Partial<Deal> = {}): Deal => ({
  id: `d${++n}`, slug: `deal-${n}`, headline: `Deal ${n}`, description: null, terms: null,
  deal_type: 'special', coupon_code: null, starts_at: null, ends_at: null, is_featured: false,
  display_priority: 0, created_at: `2026-09-0${(n % 9) + 1}T00:00:00Z`, badge: null, image: null,
  ...over,
});

describe('business card coupons', () => {
  it('shows every deal when there are three or fewer, with nothing "more"', () => {
    for (const count of [0, 1, 2, 3]) {
      const deals = Array.from({ length: count }, () => deal());
      const { shown, more } = cardDeals(deals);
      expect(shown).toHaveLength(count);
      expect(more).toBe(0);
    }
  });

  it('shows three and counts the rest, whatever the total', () => {
    for (const count of [4, 5, 9]) {
      const { shown, more } = cardDeals(Array.from({ length: count }, () => deal()));
      expect(shown).toHaveLength(CARD_DEAL_LIMIT);
      expect(more).toBe(count - 3);
    }
  });

  it('picks the best three: featured first, then priority, then newest', () => {
    const plain = deal({ created_at: '2026-01-01T00:00:00Z' });
    const newest = deal({ created_at: '2026-09-20T00:00:00Z' });
    const priority = deal({ display_priority: 5, created_at: '2026-01-01T00:00:00Z' });
    const featured = deal({ is_featured: true, created_at: '2026-01-01T00:00:00Z' });
    const { shown, more } = cardDeals([plain, newest, priority, featured]);
    expect(shown.map((d) => d.id)).toEqual([featured.id, priority.id, newest.id]);
    expect(more).toBe(1);
  });

  it('labels the remainder in plain words', () => {
    expect(moreDealsLabel(1)).toBe('+1 more deal');
    expect(moreDealsLabel(2)).toBe('+2 more deals');
  });

  it('never mutates the list it was given', () => {
    const deals = [deal({ display_priority: 1 }), deal({ display_priority: 9 })];
    const before = deals.map((d) => d.id);
    cardDeals(deals);
    expect(deals.map((d) => d.id)).toEqual(before);
  });
});

describe('grouping live deals into business cards', () => {
  it('makes one card per business, holding all of its deals', () => {
    const a = merchant({ id: 'a', name: 'Alpha' });
    const b = merchant({ id: 'b', name: 'Bravo' });
    const cards = groupDealsByMerchant([
      deal({ merchant: a }), deal({ merchant: b }), deal({ merchant: a }), deal({ merchant: a }),
    ]);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b']);
    expect(cards[0]!.deals).toHaveLength(3);
    expect(cards[1]!.deals).toHaveLength(1);
    // The merchant is not repeated inside every deal.
    expect((cards[0]!.deals![0] as Deal).merchant).toBeUndefined();
  });

  it('orders businesses featured first, then by plan, then priority, then name', () => {
    const list = [
      merchant({ id: '1', name: 'Zed', tier: 'standard' }),
      merchant({ id: '2', name: 'Amy', tier: 'premium' }),
      merchant({ id: '3', name: 'Bob', tier: 'standard', is_featured: true }),
      merchant({ id: '4', name: 'Cal', tier: 'premium', display_priority: 3 }),
      merchant({ id: '5', name: 'Abe', tier: 'standard' }),
    ].sort(compareMerchants);
    expect(list.map((m) => m.name)).toEqual(['Bob', 'Cal', 'Amy', 'Abe', 'Zed']);
  });

  it('skips deals that arrived without a business', () => {
    expect(groupDealsByMerchant([deal({ merchant: null })])).toEqual([]);
  });
});

describe('pagination', () => {
  it('clamps a page past the end to the last page', () => {
    const page = paginate([1, 2, 3, 4, 5], 9, 2);
    expect(page.page).toBe(3);
    expect(page.items).toEqual([5]);
    expect(page.pageCount).toBe(3);
  });
  it('treats nonsense as page one', () => {
    expect(paginate([1, 2], Number.NaN, 10).page).toBe(1);
  });
});

describe('search term sanitising', () => {
  it('removes PostgREST filter syntax so a search cannot become a filter', () => {
    expect(safeTerm('pizza),name.eq.x')).toBe('pizza name.eq.x');
    expect(safeTerm('100%* "off"')).toBe('100 off');
  });
  it('caps the length', () => {
    expect(safeTerm('a'.repeat(200))).toHaveLength(80);
  });
});
