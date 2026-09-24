import { publicDb } from './supabase';
import type {
  Merchant, Deal, Town, Category, NavItem, ContentBlock, SiteSettings,
} from './types';

/**
 * Every query here runs through the anon client and is therefore bounded by
 * Row Level Security. Draft merchants, paused deals and expired offers are
 * filtered by the database, not by conditions written here — so a query
 * someone forgets to guard still cannot leak unpublished content.
 */

const MERCHANT_FIELDS = `
  id, slug, name, tagline, description,
  address_line1, address_line2, city, state_code, postal_code, latitude, longitude,
  phone_display, phone_e164, website_url, facebook_url, instagram_url,
  tier, is_featured, display_priority, seo_title, seo_description,
  category_id, town_id,
  created_at, published_at,
  category:categories ( id, slug, name, icon_key, sort_order, seo_title, seo_description ),
  town:towns ( id, slug, name, state_code, latitude, longitude, seo_title, seo_description ),
  logo:media!merchants_logo_media_id_fkey ( id, bucket_id, storage_path, alt_text, width, height ),
  cover:media!merchants_cover_media_id_fkey ( id, bucket_id, storage_path, alt_text, width, height )
`;

const DEAL_FIELDS = `
  id, slug, headline, description, terms, deal_type, coupon_code,
  starts_at, ends_at, is_featured, display_priority, created_at,
  badge:badges ( id, slug, label, style_key ),
  image:media!deals_image_media_id_fkey ( id, bucket_id, storage_path, alt_text, width, height )
`;

export const PAGE_SIZE = 24;

export interface DealFilters {
  townSlug?: string;
  categorySlug?: string;
  merchantSlug?: string;
  query?: string;
  featuredOnly?: boolean;
  endingSoon?: boolean;
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** Strips characters PostgREST treats as filter syntax. */
function safeTerm(input: string): string {
  return input.trim().replace(/[,()%*\\]/g, ' ').slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* Slug resolution                                                     */
/*                                                                     */
/* Filters resolve a slug to an id first, then filter on the foreign    */
/* key column. Filtering on a nested embedded column                    */
/* (merchant.category.slug) silently does nothing unless every level of */
/* the embed is marked !inner — which is exactly why the category and   */
/* town filters were returning every record regardless of what was      */
/* selected. A plain column filter cannot fail that way, and it uses    */
/* the indexes created in migration 0002.                               */
/* ------------------------------------------------------------------ */

async function categoryIdForSlug(slug?: string): Promise<string | null> {
  if (!slug) return null;
  const { data } = await publicDb.from('categories').select('id').eq('slug', slug).maybeSingle();
  return data?.id ?? null;
}

async function townIdForSlug(slug?: string): Promise<string | null> {
  if (!slug) return null;
  const { data } = await publicDb.from('towns').select('id').eq('slug', slug).maybeSingle();
  return data?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Site chrome                                                         */
/* ------------------------------------------------------------------ */

export async function getSiteChrome(): Promise<{
  settings: SiteSettings;
  nav: NavItem[];
  blocks: Record<string, ContentBlock>;
}> {
  const [settingsRes, navRes, blocksRes] = await Promise.all([
    publicDb.from('site_settings').select('key, value'),
    publicDb.from('nav_items').select('location, section, label, href, opens_new_tab, sort_order')
      .order('sort_order'),
    publicDb.from('content_blocks').select('block_key, block_type, title, payload, sort_order')
      .order('sort_order'),
  ]);

  const settings: SiteSettings = {};
  for (const row of settingsRes.data ?? []) settings[row.key] = row.value;

  const blocks: Record<string, ContentBlock> = {};
  for (const b of (blocksRes.data ?? []) as ContentBlock[]) blocks[b.block_key] = b;

  return { settings, nav: (navRes.data ?? []) as NavItem[], blocks };
}

export async function getTowns(): Promise<Town[]> {
  const { data } = await publicDb
    .from('towns')
    .select('id, slug, name, state_code, latitude, longitude, seo_title, seo_description')
    .order('sort_order');
  return (data ?? []) as Town[];
}

export async function getTown(slug: string): Promise<Town | null> {
  const { data } = await publicDb
    .from('towns')
    .select('id, slug, name, state_code, latitude, longitude, seo_title, seo_description')
    .eq('slug', slug)
    .maybeSingle();
  return (data as Town) ?? null;
}

/**
 * Categories with a live deal count.
 *
 * The count matters: a category chip that leads to an empty page is a
 * broken promise, and with five merchants most categories are empty. The
 * UI hides zero-count categories rather than letting someone tap into
 * nothing.
 */
export async function getCategoriesWithCounts(
  townSlug?: string
): Promise<Array<Category & { deal_count: number; merchant_count: number }>> {
  const [catsRes, dealsRes, merchantsRes] = await Promise.all([
    publicDb.from('categories')
      .select('id, slug, name, icon_key, sort_order, seo_title, seo_description')
      .order('sort_order'),
    publicDb.from('deals')
      .select('id, merchant:merchants!inner ( category_id, town:towns ( slug ) )'),
    publicDb.from('merchants')
      .select('id, category_id, town:towns ( slug )'),
  ]);

  const dealCounts = new Map<string, number>();
  for (const row of (dealsRes.data ?? []) as any[]) {
    const merchant = row.merchant;
    if (!merchant) continue;
    if (townSlug && merchant.town?.slug !== townSlug) continue;
    dealCounts.set(merchant.category_id, (dealCounts.get(merchant.category_id) ?? 0) + 1);
  }

  const merchantCounts = new Map<string, number>();
  for (const row of (merchantsRes.data ?? []) as any[]) {
    if (townSlug && row.town?.slug !== townSlug) continue;
    merchantCounts.set(row.category_id, (merchantCounts.get(row.category_id) ?? 0) + 1);
  }

  return ((catsRes.data ?? []) as Category[]).map((c) => ({
    ...c,
    deal_count: dealCounts.get(c.id) ?? 0,
    merchant_count: merchantCounts.get(c.id) ?? 0,
  }));
}

/* ------------------------------------------------------------------ */
/* Deals                                                               */
/* ------------------------------------------------------------------ */

export async function listDeals(filters: DealFilters = {}): Promise<Paged<Deal>> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;
  const from = (page - 1) * pageSize;

  const [categoryId, townId] = await Promise.all([
    categoryIdForSlug(filters.categorySlug),
    townIdForSlug(filters.townSlug),
  ]);

  // A slug that matches nothing must return nothing, not everything.
  if ((filters.categorySlug && !categoryId) || (filters.townSlug && !townId)) {
    return { items: [], total: 0, page, pageSize, pageCount: 1 };
  }

  let q = publicDb
    .from('deals')
    .select(`${DEAL_FIELDS}, merchant:merchants!inner ( ${MERCHANT_FIELDS} )`, { count: 'exact' });

  if (townId) q = q.eq('merchant.town_id', townId);
  if (categoryId) q = q.eq('merchant.category_id', categoryId);
  if (filters.merchantSlug) q = q.eq('merchant.slug', filters.merchantSlug);
  if (filters.featuredOnly) q = q.eq('is_featured', true);

  if (filters.endingSoon) {
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
    q = q.not('ends_at', 'is', null).lte('ends_at', soon);
  }

  if (filters.query?.trim()) {
    const term = safeTerm(filters.query);
    if (term) q = q.or(`headline.ilike.%${term}%,description.ilike.%${term}%`);
  }

  const { data, count, error } = await q
    .order('is_featured', { ascending: false })
    .order('display_priority', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1);

  if (error) throw error;

  return {
    items: (data ?? []) as unknown as Deal[],
    total: count ?? 0,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
  };
}

/**
 * One deal per business, for the feed.
 *
 * A Premium merchant running three deals used to occupy three cards while a
 * Standard merchant with one occupied a single card — three times the feed
 * for a plan that does not sell three times the exposure. At ten businesses
 * that is thirty cards to scroll past, and at fifty it is unusable.
 *
 * Now everyone gets one slot showing their strongest offer, with a link to
 * the rest. Tier decides position rather than volume, which is what the
 * plans actually sell.
 */
const TIER_RANK: Record<string, number> = { premium: 3, pro: 2, standard: 1 };

export async function listDealsGrouped(filters: DealFilters = {}): Promise<Paged<Deal>> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;

  // Fetch wide, then collapse. The alternative is a lateral join PostgREST
  // cannot express, and at this scale one query is cheaper than the round
  // trips a per-merchant query would cost.
  const all = await listDeals({ ...filters, page: 1, pageSize: 500 });

  const best = new Map<string, Deal>();
  const counts = new Map<string, number>();

  for (const deal of all.items) {
    const id = deal.merchant?.id;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!best.has(id)) best.set(id, deal);
  }

  const collapsed = [...best.values()]
    .map((deal) => ({ ...deal, sibling_count: (counts.get(deal.merchant!.id) ?? 1) - 1 }))
    .sort((a, b) => {
      const tier = (TIER_RANK[b.merchant?.tier ?? 'standard'] ?? 1)
                 - (TIER_RANK[a.merchant?.tier ?? 'standard'] ?? 1);
      if (tier !== 0) return tier;
      return Number(b.is_featured) - Number(a.is_featured)
        || b.display_priority - a.display_priority
        || +new Date(b.created_at) - +new Date(a.created_at);
    });

  const from = (page - 1) * pageSize;
  return {
    items: collapsed.slice(from, from + pageSize),
    total: collapsed.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(collapsed.length / pageSize)),
  };
}

export async function getDeal(merchantSlug: string, dealSlug: string): Promise<Deal | null> {
  const { data } = await publicDb
    .from('deals')
    .select(`${DEAL_FIELDS}, merchant:merchants!inner ( ${MERCHANT_FIELDS} )`)
    .eq('merchant.slug', merchantSlug)
    .eq('slug', dealSlug)
    .maybeSingle();
  return (data as unknown as Deal) ?? null;
}

/* ------------------------------------------------------------------ */
/* Merchants                                                           */
/* ------------------------------------------------------------------ */

/** Live deal counts for a set of merchants, for the "see all N deals" band. */
export async function liveDealCounts(merchantIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!merchantIds.length) return counts;
  const { data } = await publicDb.from('deals').select('merchant_id').in('merchant_id', merchantIds);
  for (const row of (data ?? []) as any[]) {
    counts.set(row.merchant_id, (counts.get(row.merchant_id) ?? 0) + 1);
  }
  return counts;
}

export async function listMerchants(filters: {
  townSlug?: string;
  categorySlug?: string;
  query?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<Paged<Merchant>> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;
  const from = (page - 1) * pageSize;

  const [categoryId, townId] = await Promise.all([
    categoryIdForSlug(filters.categorySlug),
    townIdForSlug(filters.townSlug),
  ]);

  if ((filters.categorySlug && !categoryId) || (filters.townSlug && !townId)) {
    return { items: [], total: 0, page, pageSize, pageCount: 1 };
  }

  let q = publicDb.from('merchants').select(MERCHANT_FIELDS, { count: 'exact' });

  if (townId) q = q.eq('town_id', townId);
  if (categoryId) q = q.eq('category_id', categoryId);
  if (filters.query?.trim()) {
    const term = safeTerm(filters.query);
    if (term) q = q.or(`name.ilike.%${term}%,tagline.ilike.%${term}%`);
  }

  const { data, count, error } = await q
    .order('is_featured', { ascending: false })
    .order('display_priority', { ascending: false })
    .order('name')
    .range(from, from + pageSize - 1);

  if (error) throw error;

  // Attach live deal counts so every business card can say how much is
  // waiting behind it.
  const items = (data ?? []) as unknown as Merchant[];
  const counts = await liveDealCounts(items.map((m) => m.id));
  for (const merchant of items) {
    merchant.deals = Array.from({ length: counts.get(merchant.id) ?? 0 }, () => ({} as any));
  }

  return {
    items,
    total: count ?? 0,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
  };
}

export async function getMerchant(slug: string): Promise<Merchant | null> {
  const { data } = await publicDb
    .from('merchants')
    .select(`${MERCHANT_FIELDS},
      hours:merchant_hours ( day_of_week, is_closed, opens_at, closes_at ),
      gallery:merchant_gallery ( id, caption, sort_order,
        media:media ( id, bucket_id, storage_path, alt_text, width, height ) ),
      deals ( ${DEAL_FIELDS} )`)
    .eq('slug', slug)
    .maybeSingle();

  if (!data) return null;
  const merchant = data as unknown as Merchant;
  merchant.gallery = (merchant.gallery ?? [])
    .filter((g) => !!g.media)
    .sort((a, b) => a.sort_order - b.sort_order);
  merchant.deals = (merchant.deals ?? []).sort(
    (a, b) =>
      Number(b.is_featured) - Number(a.is_featured) ||
      b.display_priority - a.display_priority ||
      +new Date(b.created_at) - +new Date(a.created_at)
  );
  return merchant;
}

/* ------------------------------------------------------------------ */
/* Carousel — a Premium entitlement                                    */
/* ------------------------------------------------------------------ */

/**
 * Deals shown in the rotating carousel.
 *
 * Premium merchants only, and scoped to one town: the carousel is a
 * placement sold per market, so a Premium business in Carrollton does not
 * appear on another town's page.
 *
 * One slide per merchant, so a Premium business running three deals cannot
 * crowd out another Premium business paying exactly the same amount. And a
 * merchant with no live deal is skipped — a slide with nothing to claim
 * wastes the most valuable strip on the page, for the visitor and for the
 * merchant who bought it.
 */
export async function getCarouselDeals(townSlug?: string, limit = 8): Promise<Deal[]> {
  const townId = await townIdForSlug(townSlug);
  if (townSlug && !townId) return [];

  let q = publicDb
    .from('deals')
    .select(`${DEAL_FIELDS}, merchant:merchants!inner ( ${MERCHANT_FIELDS} )`)
    .eq('merchant.tier', 'premium');

  if (townId) q = q.eq('merchant.town_id', townId);

  const { data, error } = await q
    .order('is_featured', { ascending: false })
    .order('display_priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit * 3);

  if (error) return [];

  const rows = (data ?? []) as unknown as Deal[];

  // How many other live offers each business has, so the slide can say so.
  // A carousel showing one deal per business without mentioning the rest
  // hides most of what a Premium merchant is paying to display.
  const counts = new Map<string, number>();
  for (const deal of rows) {
    const id = deal.merchant?.id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const slides: Deal[] = [];
  for (const deal of rows) {
    const merchantId = deal.merchant?.id;
    if (!merchantId || seen.has(merchantId)) continue;
    seen.add(merchantId);
    slides.push({ ...deal, sibling_count: (counts.get(merchantId) ?? 1) - 1 });
    if (slides.length >= limit) break;
  }
  return slides;
}

/**
 * Businesses on Pocket Perks with nothing running right now.
 *
 * Shown at the bottom of the deals page, clearly marked, so someone looking
 * for a particular business still finds them and can call or get directions.
 * They never mix in with live offers — a "nothing right now" card outranking
 * a real deal would be the wrong trade for everyone.
 */
export async function listMerchantsWithoutLiveDeals(filters: {
  townSlug?: string;
  categorySlug?: string;
  limit?: number;
} = {}): Promise<Merchant[]> {
  const [categoryId, townId] = await Promise.all([
    categoryIdForSlug(filters.categorySlug),
    townIdForSlug(filters.townSlug),
  ]);

  if ((filters.categorySlug && !categoryId) || (filters.townSlug && !townId)) return [];

  let q = publicDb.from('merchants').select(`${MERCHANT_FIELDS}, deals ( id )`);
  if (townId) q = q.eq('town_id', townId);
  if (categoryId) q = q.eq('category_id', categoryId);

  const { data, error } = await q.order('name');
  if (error) return [];

  return ((data ?? []) as unknown as Merchant[])
    .filter((m) => (m.deals?.length ?? 0) === 0)
    .slice(0, filters.limit ?? 12);
}

/**
 * Other businesses to show on a merchant page.
 *
 * Placement here is a Pro and Premium entitlement, so only Pro and Premium
 * merchants are eligible to appear. Same category first, then anything else
 * in town, so the suggestion is at least plausibly relevant.
 */
export async function getRelatedMerchants(
  merchant: Merchant,
  limit = 3
): Promise<Merchant[]> {
  let q = publicDb
    .from('merchants')
    .select(MERCHANT_FIELDS)
    .in('tier', ['pro', 'premium'])
    .neq('id', merchant.id);

  if (merchant.town_id) q = q.eq('town_id', merchant.town_id);

  const { data } = await q
    .order('is_featured', { ascending: false })
    .order('display_priority', { ascending: false })
    .limit(limit * 3);

  const all = (data ?? []) as unknown as Merchant[];
  const sameCategory = all.filter((m) => m.category?.id === merchant.category?.id);
  const rest = all.filter((m) => m.category?.id !== merchant.category?.id);
  return [...sameCategory, ...rest].slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Homepage composition                                                */
/* ------------------------------------------------------------------ */

export async function getHomepageData(townSlug?: string) {
  /**
   * The carousel is always scoped to exactly one town, even on the homepage
   * where no town is in the URL. A Premium merchant buys placement in their
   * own market; a carousel that mixed Carrollton and Malvern businesses
   * would be selling something nobody agreed to. With no town chosen it
   * falls back to the first active town rather than showing all of them.
   *
   * The deal feed below is different: cards there name their business and
   * town, so a mixed feed is informative rather than misleading.
   */
  const towns = await getTowns();
  const carouselTown = townSlug ?? towns[0]?.slug;

  const [carousel, featured, latest, categories, merchantCount] = await Promise.all([
    getCarouselDeals(carouselTown),
    listDeals({ townSlug, featuredOnly: true, pageSize: 6 }),
    listDealsGrouped({ townSlug, pageSize: 12 }),
    getCategoriesWithCounts(townSlug),
    publicDb.from('merchants').select('id', { count: 'exact', head: true }),
  ]);

  const carouselIds = new Set(carousel.map((d) => d.id));

  return {
    carousel,
    carouselTown: towns.find((t) => t.slug === carouselTown) ?? null,
    // A deal already in the carousel is not repeated in the featured row.
    // The same offer twice on one screen reads as a bug, not as emphasis.
    featuredDeals: featured.items.filter((d) => !carouselIds.has(d.id)),
    latestDeals: latest.items,
    totalDeals: latest.total,
    categories: categories.filter((c) => c.deal_count > 0),
    merchantCount: merchantCount.count ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Caching                                                             */
/* ------------------------------------------------------------------ */

/**
 * Sixty seconds, not five minutes.
 *
 * The CDN caches by URL. At five minutes, publishing a deal and refreshing
 * showed the old page — while clicking a category filter produced a different
 * URL and therefore a fresh render. That made the site look intermittently
 * broken in a way that is very hard to reason about. A minute keeps nearly
 * all of the speed benefit and makes "publish, refresh, see it" behave the
 * way anyone would expect.
 */
export const CACHE_PUBLIC = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';
export const CACHE_STATIC = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';

/* ------------------------------------------------------------------ */
/* Universal search                                                    */
/* ------------------------------------------------------------------ */

export interface SearchResults {
  merchants: Merchant[];
  deals: Deal[];
  total: number;
}

/**
 * One search that covers everything a person might type.
 *
 * The old search looked at deal headlines on /deals and business names on
 * /businesses, and nothing at all on the homepage. Typing a town, a category,
 * an address or a phone number found nothing anywhere — which reads as "this
 * site has nothing" rather than "this box only searches two fields".
 *
 * This looks at: business name, tagline, description, street, city, phone
 * (typed with or without punctuation), category name, town name, deal
 * headline and deal description. A match on any of them surfaces both the
 * business and its live deals.
 */
export async function searchEverything(
  rawTerm: string,
  townSlug?: string,
  limit = 12
): Promise<SearchResults> {
  const term = safeTerm(rawTerm);
  if (!term || term.length < 2) return { merchants: [], deals: [], total: 0 };

  const townId = await townIdForSlug(townSlug);
  if (townSlug && !townId) return { merchants: [], deals: [], total: 0 };

  // "330-555-0142", "(330) 555 0142" and "3305550142" must all find the same
  // business, so phone matching runs on digits only.
  const digits = rawTerm.replace(/\D/g, '');

  const [catRes, townRes] = await Promise.all([
    publicDb.from('categories').select('id').ilike('name', `%${term}%`),
    publicDb.from('towns').select('id').ilike('name', `%${term}%`),
  ]);
  const categoryIds = (catRes.data ?? []).map((c: any) => c.id);
  const townIds = (townRes.data ?? []).map((t: any) => t.id);

  const fields = [
    `name.ilike.%${term}%`,
    `tagline.ilike.%${term}%`,
    `description.ilike.%${term}%`,
    `address_line1.ilike.%${term}%`,
    `city.ilike.%${term}%`,
    `postal_code.ilike.%${term}%`,
  ];
  if (digits.length >= 3) fields.push(`phone_e164.ilike.%${digits}%`);
  if (categoryIds.length) fields.push(`category_id.in.(${categoryIds.join(',')})`);
  if (townIds.length) fields.push(`town_id.in.(${townIds.join(',')})`);

  let merchantQuery = publicDb.from('merchants').select(MERCHANT_FIELDS).or(fields.join(','));
  if (townId) merchantQuery = merchantQuery.eq('town_id', townId);

  let dealQuery = publicDb
    .from('deals')
    .select(`${DEAL_FIELDS}, merchant:merchants!inner ( ${MERCHANT_FIELDS} )`)
    .or(`headline.ilike.%${term}%,description.ilike.%${term}%,terms.ilike.%${term}%`);
  if (townId) dealQuery = dealQuery.eq('merchant.town_id', townId);

  const [merchantRes, dealRes] = await Promise.all([
    merchantQuery.order('is_featured', { ascending: false }).order('name').limit(limit * 2),
    dealQuery.order('is_featured', { ascending: false }).limit(limit * 2),
  ]);

  const merchants = (merchantRes.data ?? []) as unknown as Merchant[];
  const deals = (dealRes.data ?? []) as unknown as Deal[];

  // A business matching by phone or address should surface its offers too,
  // even when the offer text says nothing about the search term.
  const dealIds = new Set(deals.map((d) => d.id));
  if (merchants.length) {
    const ids = merchants.map((m) => m.id);
    let extra = publicDb
      .from('deals')
      .select(`${DEAL_FIELDS}, merchant:merchants!inner ( ${MERCHANT_FIELDS} )`)
      .in('merchant_id', ids)
      .limit(limit * 2);
    const { data } = await extra;
    for (const deal of (data ?? []) as unknown as Deal[]) {
      if (!dealIds.has(deal.id)) { deals.push(deal); dealIds.add(deal.id); }
    }
  }

  // One card per business in the results, same as the main feed.
  const seen = new Set<string>();
  const grouped: Deal[] = [];
  for (const deal of deals) {
    const id = deal.merchant?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    grouped.push({ ...deal, sibling_count: deals.filter((d) => d.merchant?.id === id).length - 1 });
  }

  // Businesses with no live deal still deserve to be findable — someone
  // searching a phone number wants the business, not an offer.
  const withoutDeals = merchants.filter((m) => !seen.has(m.id));

  return {
    merchants: withoutDeals.slice(0, limit),
    deals: grouped.slice(0, limit),
    total: grouped.length + withoutDeals.length,
  };
}
