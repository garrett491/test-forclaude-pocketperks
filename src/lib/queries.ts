import { publicDb, isConfigured } from './supabase';
import { must, logDataError, DataUnavailableError } from './errors';
import { memo } from './memo';
import {
  groupDealsByMerchant, compareDeals, compareMerchants, paginate, safeTerm, type Page,
} from './listing';
import type {
  Merchant, Deal, Town, Category, NavItem, ContentBlock, SiteSettings, GalleryItem, MerchantHours,
} from './types';

/**
 * Every query here runs through the anon client and is therefore bounded by
 * Row Level Security. Draft merchants, paused deals and expired offers are
 * filtered by the database, not by conditions written here — so a query
 * someone forgets to guard still cannot leak unpublished content.
 *
 * Every query also checks its error. A failed query throws
 * DataUnavailableError; it never pretends to be an empty result. Pages turn
 * that into a friendly "try again" notice rather than a false "not found".
 */

/* ------------------------------------------------------------------ */
/* Field lists, with a fallback for databases missing migration 0009   */
/* ------------------------------------------------------------------ */

/**
 * If this code is deployed before migration 0009 has been run, selecting the
 * new columns would fail every query and take the whole site down. Instead
 * the first query checks once which columns exist and uses the older field
 * list until the migration is applied. The check repeats every few minutes,
 * so running the migration takes effect without a redeploy.
 */
let schemaCheck: { current: boolean; checkedAt: number } | null = null;
let schemaCheckInFlight: Promise<boolean> | null = null;

async function hasCurrentSchema(): Promise<boolean> {
  const fresh = schemaCheck && (schemaCheck.current || Date.now() - schemaCheck.checkedAt < 5 * 60_000);
  if (fresh) return schemaCheck!.current;
  // Several queries start at once on a cold start; they share one check.
  schemaCheckInFlight ??= checkSchema().finally(() => { schemaCheckInFlight = null; });
  return schemaCheckInFlight;
}

async function checkSchema(): Promise<boolean> {
  const { error } = await publicDb.from('deals').select('restrictions').limit(1);
  if (error && error.code !== '42703' && error.code !== 'PGRST204') {
    // A genuine outage, not a schema question. Do not cache the answer.
    logDataError('schema check', error);
    throw new DataUnavailableError('schema check', error);
  }
  const current = !error;
  if (!current) {
    console.warn('[pocket-perks] Migration 0009 has not been run. Running with reduced features until it is.');
  }
  schemaCheck = { current, checkedAt: Date.now() };
  return current;
}

const MEDIA_BASE = 'id, bucket_id, storage_path, alt_text, width, height';

function fields(current: boolean) {
  const media = current ? `${MEDIA_BASE}, variants` : MEDIA_BASE;
  const merchant = `
    id, slug, name, tagline, description,
    address_line1, address_line2, city, state_code, postal_code, latitude, longitude,
    phone_display, phone_e164, website_url, facebook_url, instagram_url,
    tier, is_featured, display_priority, seo_title, seo_description,
    category_id, town_id, created_at, published_at,
    ${current ? 'show_in_carousel,' : ''}
    category:categories ( id, slug, name, icon_key, sort_order, seo_title, seo_description ),
    town:towns ( id, slug, name, state_code, latitude, longitude, seo_title, seo_description ),
    logo:media!merchants_logo_media_id_fkey ( ${media} ),
    cover:media!merchants_cover_media_id_fkey ( ${media} )`;
  const deal = `
    id, slug, headline, description, terms, deal_type, coupon_code, merchant_id,
    starts_at, ends_at, is_featured, display_priority, created_at,
    ${current ? 'restrictions,' : ''}
    badge:badges ( id, slug, label, style_key ),
    image:media!deals_image_media_id_fkey ( ${media} )`;
  return { media, merchant, deal };
}

async function F() {
  if (!isConfigured) throw new DataUnavailableError('configuration', { message: 'Supabase is not configured' });
  return fields(await hasCurrentSchema());
}

export const PAGE_SIZE = 24;

/* ------------------------------------------------------------------ */
/* Slug resolution                                                     */
/*                                                                     */
/* Filters resolve a slug to an id first, then filter on the foreign    */
/* key column. Filtering on a nested embedded column silently does      */
/* nothing unless every level of the embed is !inner; a plain column    */
/* filter cannot fail that way, and it uses the indexes.                */
/* ------------------------------------------------------------------ */

/**
 * Slug → id lookups are shared for a minute. One page view used to repeat
 * the same town lookup four times; a slug's id never changes, and a town or
 * category that is renamed or switched off drops out within a minute.
 */
const idCache = new Map<string, { at: number; value: Promise<string | null> }>();
// Overridable for the test suite, which rebuilds the database (and so every
// id) between runs. In production a slug's id never changes.
const ID_TTL_MS = Number(process.env.PP_ID_CACHE_TTL_MS ?? 60_000);

function cachedId(table: 'towns' | 'categories', slug: string): Promise<string | null> {
  const key = `${table}:${slug}`;
  const hit = idCache.get(key);
  if (hit && Date.now() - hit.at < ID_TTL_MS) return hit.value;
  const value = (async () => {
    const data = must(`${table} lookup`, await publicDb.from(table).select('id').eq('slug', slug).maybeSingle());
    return (data as { id: string } | null)?.id ?? null;
  })();
  value.catch(() => idCache.delete(key)); // never remember a failure
  idCache.set(key, { at: Date.now(), value });
  return value;
}

async function categoryIdForSlug(slug?: string): Promise<string | null> {
  return slug ? cachedId('categories', slug) : null;
}

async function townIdForSlug(slug?: string): Promise<string | null> {
  return slug ? cachedId('towns', slug) : null;
}

/* ------------------------------------------------------------------ */
/* Site chrome                                                         */
/* ------------------------------------------------------------------ */

export interface SiteChrome {
  settings: SiteSettings;
  nav: NavItem[];
  blocks: Record<string, ContentBlock>;
  /** False when the database could not be reached and defaults are showing. */
  ok: boolean;
}

/**
 * Settings, navigation and editable copy.
 *
 * Never throws. If the database is down the header, footer and error notice
 * still render from built-in defaults, so a visitor always gets a working
 * page with a way forward instead of a blank screen.
 */
export function getSiteChrome(locals?: App.Locals): Promise<SiteChrome> {
  return memo(locals, 'chrome', async () => {
    try {
      if (!isConfigured) throw new Error('not configured');
      const [settingsRes, navRes, blocksRes] = await Promise.all([
        publicDb.from('site_settings').select('key, value'),
        publicDb.from('nav_items').select('location, section, label, href, opens_new_tab, sort_order').order('sort_order'),
        publicDb.from('content_blocks').select('block_key, block_type, title, payload, sort_order').order('sort_order'),
      ]);
      const settingsRows = must('site settings', settingsRes) as { key: string; value: unknown }[];
      const navRows = must('navigation', navRes) as NavItem[];
      const blockRows = must('content blocks', blocksRes) as ContentBlock[];

      const settings: SiteSettings = {};
      for (const row of settingsRows ?? []) settings[row.key] = row.value;
      const blocks: Record<string, ContentBlock> = {};
      for (const b of blockRows ?? []) blocks[b.block_key] = b;
      return { settings, nav: navRows ?? [], blocks, ok: true };
    } catch {
      return { settings: {}, nav: DEFAULT_NAV, blocks: {}, ok: false };
    }
  });
}

/** What the header and footer show when the database cannot be reached. */
const DEFAULT_NAV: NavItem[] = [
  { location: 'header', section: null, label: 'Deals', href: '/deals', opens_new_tab: false, sort_order: 10 },
  { location: 'header', section: null, label: 'Businesses', href: '/businesses', opens_new_tab: false, sort_order: 20 },
  { location: 'footer', section: 'About', label: 'Privacy', href: '/privacy', opens_new_tab: false, sort_order: 10 },
  { location: 'footer', section: 'About', label: 'Terms of use', href: '/terms', opens_new_tab: false, sort_order: 15 },
  { location: 'footer', section: 'About', label: 'Accessibility', href: '/accessibility', opens_new_tab: false, sort_order: 18 },
];

const TOWN_FIELDS = 'id, slug, name, state_code, latitude, longitude, seo_title, seo_description';

export function getTowns(locals?: App.Locals): Promise<Town[]> {
  return memo(locals, 'towns', async () => {
    if (!isConfigured) throw new DataUnavailableError('configuration', { message: 'not configured' });
    return (must('towns', await publicDb.from('towns').select(TOWN_FIELDS).order('sort_order')) ?? []) as Town[];
  });
}

/** For the layout: an empty list rather than an error, so chrome always renders. */
export async function getTownsSafe(locals?: App.Locals): Promise<Town[]> {
  try { return await getTowns(locals); } catch { return []; }
}

export async function getTown(slug: string, locals?: App.Locals): Promise<Town | null> {
  const towns = await getTowns(locals);
  return towns.find((t) => t.slug === slug) ?? null;
}

/** Live deals per town id, for the first-visit town chooser. */
export async function getTownDealCounts(): Promise<Map<string, number>> {
  const data = must('town deal counts',
    await publicDb.from('deals').select('id, merchant:merchants!inner ( town_id )'));
  const counts = new Map<string, number>();
  for (const row of (data ?? []) as any[]) {
    const id = row.merchant?.town_id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Categories with a live deal count, for the filter chips.
 *
 * A chip that leads to an empty page is a broken promise, so pages hide
 * zero-count categories.
 */
export async function getCategoriesWithCounts(
  townSlug?: string
): Promise<Array<Category & { deal_count: number; merchant_count: number }>> {
  const townId = await townIdForSlug(townSlug);
  if (townSlug && !townId) return [];

  let dealsQuery = publicDb.from('deals').select('id, merchant:merchants!inner ( category_id, town_id )');
  if (townId) dealsQuery = dealsQuery.eq('merchant.town_id', townId);
  let merchantsQuery = publicDb.from('merchants').select('id, category_id');
  if (townId) merchantsQuery = merchantsQuery.eq('town_id', townId);

  const [catsRes, dealsRes, merchantsRes] = await Promise.all([
    publicDb.from('categories').select('id, slug, name, icon_key, sort_order, seo_title, seo_description').order('sort_order'),
    dealsQuery,
    merchantsQuery,
  ]);
  const cats = (must('categories', catsRes) ?? []) as Category[];
  const deals = (must('category deal counts', dealsRes) ?? []) as any[];
  const merchants = (must('category merchant counts', merchantsRes) ?? []) as any[];

  const dealCounts = new Map<string, number>();
  for (const row of deals) {
    const id = row.merchant?.category_id;
    if (id) dealCounts.set(id, (dealCounts.get(id) ?? 0) + 1);
  }
  const merchantCounts = new Map<string, number>();
  for (const row of merchants) merchantCounts.set(row.category_id, (merchantCounts.get(row.category_id) ?? 0) + 1);

  return cats.map((c) => ({
    ...c,
    deal_count: dealCounts.get(c.id) ?? 0,
    merchant_count: merchantCounts.get(c.id) ?? 0,
  }));
}

/* ------------------------------------------------------------------ */
/* Deals and business cards                                            */
/* ------------------------------------------------------------------ */

export interface ListingFilters {
  townSlug?: string;
  categorySlug?: string;
  query?: string;
  featuredOnly?: boolean;
  endingSoon?: boolean;
  page?: number;
  pageSize?: number;
}

/** Every live deal matching the filters, each carrying its merchant. */
export async function listLiveDeals(filters: ListingFilters = {}, limit = 500): Promise<Deal[]> {
  const f = await F();
  const [categoryId, townId] = await Promise.all([
    categoryIdForSlug(filters.categorySlug),
    townIdForSlug(filters.townSlug),
  ]);

  // A slug that matches nothing must return nothing, not everything.
  if ((filters.categorySlug && !categoryId) || (filters.townSlug && !townId)) return [];

  let q = publicDb.from('deals').select(`${f.deal}, merchant:merchants!inner ( ${f.merchant} )`);
  if (townId) q = q.eq('merchant.town_id', townId);
  if (categoryId) q = q.eq('merchant.category_id', categoryId);
  if (filters.featuredOnly) q = q.eq('is_featured', true);
  if (filters.endingSoon) {
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
    q = q.not('ends_at', 'is', null).lte('ends_at', soon);
  }
  if (filters.query?.trim()) {
    const term = safeTerm(filters.query);
    if (term) q = q.or(`headline.ilike.%${term}%,description.ilike.%${term}%`);
  }

  const data = must('deal list', await q
    .order('is_featured', { ascending: false })
    .order('display_priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit));
  return (data ?? []) as unknown as Deal[];
}

/**
 * One card per business, each holding all of its live deals.
 *
 * The card shows the best three and says how many more there are, so a
 * business's offers are one tap away without taking over the feed.
 */
export async function listBusinessCards(filters: ListingFilters = {}): Promise<Page<Merchant>> {
  const deals = await listLiveDeals(filters);
  return paginate(groupDealsByMerchant(deals), filters.page ?? 1, filters.pageSize ?? PAGE_SIZE);
}

export async function getDeal(merchantSlug: string, dealSlug: string): Promise<Deal | null> {
  const f = await F();
  const data = must('deal', await publicDb
    .from('deals')
    .select(`${f.deal}, merchant:merchants!inner ( ${f.merchant} )`)
    .eq('merchant.slug', merchantSlug)
    .eq('slug', dealSlug)
    .maybeSingle());
  return (data as unknown as Deal) ?? null;
}

/* ------------------------------------------------------------------ */
/* Merchants                                                           */
/* ------------------------------------------------------------------ */

/** Attaches each merchant's live deals, best first, in one query. */
export async function attachLiveDeals(merchants: Merchant[]): Promise<Merchant[]> {
  if (!merchants.length) return merchants;
  const f = await F();
  const data = must('live deals for businesses', await publicDb
    .from('deals')
    .select(f.deal)
    .in('merchant_id', merchants.map((m) => m.id)));
  const byMerchant = new Map<string, Deal[]>();
  for (const deal of (data ?? []) as unknown as Deal[]) {
    const key = deal.merchant_id!;
    if (!byMerchant.has(key)) byMerchant.set(key, []);
    byMerchant.get(key)!.push(deal);
  }
  for (const m of merchants) m.deals = (byMerchant.get(m.id) ?? []).sort(compareDeals);
  return merchants;
}

export async function listMerchants(filters: ListingFilters = {}): Promise<Page<Merchant>> {
  const f = await F();
  const [categoryId, townId] = await Promise.all([
    categoryIdForSlug(filters.categorySlug),
    townIdForSlug(filters.townSlug),
  ]);
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = filters.pageSize ?? PAGE_SIZE;
  if ((filters.categorySlug && !categoryId) || (filters.townSlug && !townId)) {
    return { items: [], total: 0, page, pageSize, pageCount: 1 };
  }

  let q = publicDb.from('merchants').select(f.merchant, { count: 'exact' });
  if (townId) q = q.eq('town_id', townId);
  if (categoryId) q = q.eq('category_id', categoryId);
  if (filters.query?.trim()) {
    const term = safeTerm(filters.query);
    if (term) q = q.or(`name.ilike.%${term}%,tagline.ilike.%${term}%`);
  }
  const from = (page - 1) * pageSize;
  const result = await q
    .order('is_featured', { ascending: false })
    .order('display_priority', { ascending: false })
    .order('name')
    .range(from, from + pageSize - 1);
  const items = (must('business list', result) ?? []) as unknown as Merchant[];
  await attachLiveDeals(items);
  const total = result.count ?? items.length;
  return { items, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

/**
 * One business, for its page.
 *
 * The business row is fetched on its own and is the only part that decides
 * whether the page exists. Hours, photos and deals load alongside it, and
 * the optional parts — hours and photos — can fail without taking the page
 * down with them. Previously everything was one embedded query whose error
 * was ignored, so any problem in any part (such as the photo gallery table
 * not existing yet) made every business page look like it did not exist.
 */
export async function getMerchant(slug: string): Promise<Merchant | null> {
  const f = await F();
  const data = must('business', await publicDb.from('merchants').select(f.merchant).eq('slug', slug).maybeSingle());
  if (!data) return null;
  const merchant = data as unknown as Merchant;

  const [hoursRes, galleryRes, dealsRes] = await Promise.all([
    publicDb.from('merchant_hours').select('day_of_week, is_closed, opens_at, closes_at').eq('merchant_id', merchant.id),
    publicDb.from('merchant_gallery')
      .select(`id, caption, sort_order, media:media ( ${f.media} )`)
      .eq('merchant_id', merchant.id)
      .order('sort_order'),
    publicDb.from('deals').select(f.deal).eq('merchant_id', merchant.id),
  ]);

  if (hoursRes.error) logDataError('business hours', hoursRes.error);
  if (galleryRes.error) logDataError('business gallery', galleryRes.error);

  merchant.hours = (hoursRes.data ?? []) as MerchantHours[];
  merchant.gallery = ((galleryRes.data ?? []) as unknown as GalleryItem[]).filter((g) => !!g.media);
  merchant.deals = ((must('business deals', dealsRes) ?? []) as unknown as Deal[]).sort(compareDeals);
  return merchant;
}

/* ------------------------------------------------------------------ */
/* Featured carousel                                                   */
/* ------------------------------------------------------------------ */

/**
 * Businesses in the featured carousel for one town (or every town).
 *
 * Chosen per business in admin with "Show in featured carousel". On a
 * database without migration 0009 it falls back to the old rule: every
 * Premium business. Each slide is a business, never a single deal, and it
 * links to the business page.
 */
export async function getCarouselMerchants(townSlug?: string, limit = 12): Promise<Merchant[]> {
  const f = await F();
  const current = f.merchant.includes('show_in_carousel');
  const townId = await townIdForSlug(townSlug);
  if (townSlug && !townId) return [];

  let q = publicDb.from('merchants').select(f.merchant);
  q = current ? q.eq('show_in_carousel', true) : q.eq('tier', 'premium');
  if (townId) q = q.eq('town_id', townId);
  const data = must('carousel', await q
    .order('display_priority', { ascending: false })
    .order('name')
    .limit(limit));
  const merchants = ((data ?? []) as unknown as Merchant[]).sort(compareMerchants);
  return attachLiveDeals(merchants);
}

/** Businesses with nothing live right now, shown after those with deals. */
export async function listMerchantsWithoutLiveDeals(filters: {
  townSlug?: string;
  categorySlug?: string;
  limit?: number;
} = {}): Promise<Merchant[]> {
  const f = await F();
  const [categoryId, townId] = await Promise.all([
    categoryIdForSlug(filters.categorySlug),
    townIdForSlug(filters.townSlug),
  ]);
  if ((filters.categorySlug && !categoryId) || (filters.townSlug && !townId)) return [];

  let q = publicDb.from('merchants').select(`${f.merchant}, deals ( id )`);
  if (townId) q = q.eq('town_id', townId);
  if (categoryId) q = q.eq('category_id', categoryId);
  const data = must('businesses without deals', await q.order('name'));
  return ((data ?? []) as unknown as Merchant[])
    .filter((m) => (m.deals?.length ?? 0) === 0)
    .map((m) => ({ ...m, deals: [] }))
    .slice(0, filters.limit ?? 12);
}

/**
 * Other businesses to show on a merchant page. Pro and Premium only (a
 * plan entitlement); same category first, then anything else in town.
 */
export async function getRelatedMerchants(merchant: Merchant, limit = 3): Promise<Merchant[]> {
  const f = await F();
  let q = publicDb.from('merchants').select(f.merchant).in('tier', ['pro', 'premium']).neq('id', merchant.id);
  if (merchant.town_id) q = q.eq('town_id', merchant.town_id);
  const data = must('related businesses', await q
    .order('is_featured', { ascending: false })
    .order('display_priority', { ascending: false })
    .limit(limit * 3));
  const all = (data ?? []) as unknown as Merchant[];
  const sameCategory = all.filter((m) => m.category_id === merchant.category_id);
  const rest = all.filter((m) => m.category_id !== merchant.category_id);
  return attachLiveDeals([...sameCategory, ...rest].slice(0, limit));
}

/* ------------------------------------------------------------------ */
/* A town's front page                                                 */
/* ------------------------------------------------------------------ */

export interface TownPageData {
  carousel: Merchant[];
  cards: Merchant[];
  quiet: Merchant[];
  categories: Array<Category & { deal_count: number }>;
  dealCount: number;
}

/**
 * Everything the town view needs, in one round of parallel queries.
 * `townSlug` undefined means every town.
 */
export async function getTownPageData(townSlug?: string): Promise<TownPageData> {
  const [carousel, deals, quiet] = await Promise.all([
    getCarouselMerchants(townSlug),
    listLiveDeals({ townSlug }),
    listMerchantsWithoutLiveDeals({ townSlug }),
  ]);

  // The category chips come from the deals already loaded — every deal
  // carries its business's category — rather than a second round of queries.
  const byCategory = new Map<string, Category & { deal_count: number }>();
  for (const deal of deals) {
    const category = deal.merchant?.category;
    if (!category) continue;
    const entry = byCategory.get(category.id) ?? { ...category, deal_count: 0 };
    entry.deal_count += 1;
    byCategory.set(category.id, entry);
  }

  return {
    carousel,
    cards: groupDealsByMerchant(deals),
    quiet,
    categories: [...byCategory.values()].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    dealCount: deals.length,
  };
}

/* ------------------------------------------------------------------ */
/* Caching                                                             */
/* ------------------------------------------------------------------ */

/**
 * Sixty seconds at the CDN, and admin saves purge it immediately (see
 * lib/purge.ts). Browsers always revalidate.
 */
export const CACHE_PUBLIC = 'public, max-age=0, s-maxage=60, stale-while-revalidate=600';
export const CACHE_STATIC = 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
/** Not-found pages are cached briefly, so a business published later appears quickly. */
export const CACHE_NOT_FOUND = 'public, max-age=0, s-maxage=60';
/** Error pages are never cached: the next request should try again. */
export const CACHE_NONE = 'private, no-store, max-age=0';

/** Tag on every cached public page, so an admin save can purge them all. */
export const CACHE_TAG = 'pp-public';

/* ------------------------------------------------------------------ */
/* Universal search                                                    */
/* ------------------------------------------------------------------ */

export interface SearchResults {
  /** Businesses with at least one matching or live deal, deals attached. */
  cards: Merchant[];
  /** Matching businesses with nothing live. */
  quiet: Merchant[];
  total: number;
}

/**
 * One search that covers everything a person might type: business name,
 * tagline, description, street, city, ZIP, phone (with or without
 * punctuation), category, town, and deal headline, description and terms.
 * A match on a business surfaces all of its live deals.
 */
export async function searchEverything(rawTerm: string, townSlug?: string, limit = 24): Promise<SearchResults> {
  const term = safeTerm(rawTerm);
  if (!term || term.length < 2) return { cards: [], quiet: [], total: 0 };
  const f = await F();

  const townId = await townIdForSlug(townSlug);
  if (townSlug && !townId) return { cards: [], quiet: [], total: 0 };

  const digits = rawTerm.replace(/\D/g, '');
  const [catRes, townRes] = await Promise.all([
    publicDb.from('categories').select('id').ilike('name', `%${term}%`),
    publicDb.from('towns').select('id').ilike('name', `%${term}%`),
  ]);
  const categoryIds = ((must('search categories', catRes) ?? []) as any[]).map((c) => c.id);
  const townIds = ((must('search towns', townRes) ?? []) as any[]).map((t) => t.id);

  const orFields = [
    `name.ilike.%${term}%`, `tagline.ilike.%${term}%`, `description.ilike.%${term}%`,
    `address_line1.ilike.%${term}%`, `city.ilike.%${term}%`, `postal_code.ilike.%${term}%`,
  ];
  if (digits.length >= 3) orFields.push(`phone_e164.ilike.%${digits}%`);
  if (categoryIds.length) orFields.push(`category_id.in.(${categoryIds.join(',')})`);
  if (townIds.length) orFields.push(`town_id.in.(${townIds.join(',')})`);

  let merchantQuery = publicDb.from('merchants').select(f.merchant).or(orFields.join(','));
  if (townId) merchantQuery = merchantQuery.eq('town_id', townId);

  let dealQuery = publicDb
    .from('deals')
    .select(`${f.deal}, merchant:merchants!inner ( ${f.merchant} )`)
    .or(`headline.ilike.%${term}%,description.ilike.%${term}%,terms.ilike.%${term}%`);
  if (townId) dealQuery = dealQuery.eq('merchant.town_id', townId);

  const [merchantRes, dealRes] = await Promise.all([merchantQuery.limit(limit * 2), dealQuery.limit(limit * 3)]);
  const matchedMerchants = (must('search businesses', merchantRes) ?? []) as unknown as Merchant[];
  const matchedDeals = (must('search deals', dealRes) ?? []) as unknown as Deal[];

  // Every business that matched, directly or through a deal, with all of
  // its live deals attached — not just the ones whose text matched.
  const byId = new Map<string, Merchant>();
  for (const m of matchedMerchants) byId.set(m.id, { ...m });
  for (const d of matchedDeals) if (d.merchant && !byId.has(d.merchant.id)) byId.set(d.merchant.id, { ...d.merchant });
  const merchants = await attachLiveDeals([...byId.values()]);

  const cards = merchants.filter((m) => (m.deals?.length ?? 0) > 0).sort(compareMerchants);
  const quiet = merchants.filter((m) => (m.deals?.length ?? 0) === 0).sort(compareMerchants);
  return { cards: cards.slice(0, limit), quiet: quiet.slice(0, limit), total: cards.length + quiet.length };
}
