import type { Deal, Merchant } from './types';

/**
 * Pure listing rules — no database, no framework — so they can be unit
 * tested and so the server-rendered cards and the live search results can
 * never disagree about what a card shows.
 */

/** How many coupons a business card shows before "+N more deals". */
export const CARD_DEAL_LIMIT = 3;

const TIER_RANK: Record<string, number> = { premium: 3, pro: 2, standard: 1 };

/**
 * The best deals first: featured, then admin priority, then newest. This is
 * also the order the "first three" on a card are chosen by.
 */
export function compareDeals(a: Deal, b: Deal): number {
  return (
    Number(b.is_featured) - Number(a.is_featured) ||
    (b.display_priority ?? 0) - (a.display_priority ?? 0) ||
    +new Date(b.created_at) - +new Date(a.created_at)
  );
}

/**
 * Business order in every list: featured businesses, then plan, then the
 * admin's sort priority, then name. The plan decides position, never how
 * much space a business takes up — each business is exactly one card.
 */
export function compareMerchants(a: Merchant, b: Merchant): number {
  return (
    Number(b.is_featured) - Number(a.is_featured) ||
    (TIER_RANK[b.tier] ?? 1) - (TIER_RANK[a.tier] ?? 1) ||
    (b.display_priority ?? 0) - (a.display_priority ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

/** The coupons a card shows, and how many more wait on the business page. */
export function cardDeals(deals: Deal[] | undefined, limit = CARD_DEAL_LIMIT): { shown: Deal[]; more: number } {
  const all = [...(deals ?? [])].sort(compareDeals);
  const shown = all.slice(0, limit);
  return { shown, more: Math.max(0, all.length - shown.length) };
}

export function moreDealsLabel(more: number): string {
  return more === 1 ? '+1 more deal' : `+${more} more deals`;
}

/**
 * Turns a flat list of live deals (each carrying its merchant) into one
 * business per entry, each holding all of its live deals in best-first
 * order. Merchants arrive in business order.
 */
export function groupDealsByMerchant(deals: Deal[]): Merchant[] {
  const byId = new Map<string, Merchant>();
  for (const deal of deals) {
    const merchant = deal.merchant;
    if (!merchant?.id) continue;
    let entry = byId.get(merchant.id);
    if (!entry) {
      entry = { ...merchant, deals: [] };
      byId.set(merchant.id, entry);
    }
    const { merchant: _omit, ...plain } = deal;
    entry.deals!.push(plain as Deal);
  }
  const merchants = [...byId.values()];
  for (const m of merchants) m.deals!.sort(compareDeals);
  return merchants.sort(compareMerchants);
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export function paginate<T>(all: T[], page: number, pageSize: number): Page<T> {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
  const from = (Math.min(safePage, pageCount) - 1) * pageSize;
  return {
    items: all.slice(from, from + pageSize),
    total: all.length,
    page: Math.min(safePage, pageCount),
    pageSize,
    pageCount,
  };
}

/** Strips characters PostgREST treats as filter syntax from a search term. */
export function safeTerm(input: string): string {
  return input.trim().replace(/[,()%*\\"]/g, ' ').replace(/\s+/g, ' ').slice(0, 80).trim();
}
