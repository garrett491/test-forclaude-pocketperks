import type { APIRoute } from 'astro';
import { searchEverything } from '../../lib/queries';
import { imageUrl, expiryLabel, initials, truncate, formatAddress, openStatus } from '../../lib/format';

export const prerender = false;

/**
 * Search-as-you-type, for every search box on the site.
 *
 * Returns businesses and deals together, because someone typing a phone
 * number wants the business and someone typing "pizza" wants the offer, and
 * neither of them knows which list they are supposed to be looking at.
 *
 * Read-only, anon-scoped, bounded by the same Row Level Security as
 * everything else.
 */
export const GET: APIRoute = async ({ url, cookies }) => {
  const query = (url.searchParams.get('q') ?? '').trim().slice(0, 80);

  // Live results obey the same town rule as the page they replace, otherwise
  // typing a letter silently widens the search to every town.
  const townParam = url.searchParams.get('town');
  const townSlug = townParam === 'all'
    ? undefined
    : townParam ?? cookies.get('pp_town')?.value ?? undefined;

  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store',
    Vary: 'Cookie',
  };

  if (query.length < 2) {
    return new Response(JSON.stringify({ deals: [], merchants: [], total: 0 }), { headers });
  }

  try {
    const results = await searchEverything(query, townSlug);

    const deals = results.deals.map((deal) => {
      const merchant = deal.merchant!;
      const art = deal.image ?? merchant.cover ?? merchant.logo;
      return {
        kind: 'deal' as const,
        headline: deal.headline,
        description: truncate(deal.description, 110),
        href: `/b/${merchant.slug}/${deal.slug}`,
        merchantName: merchant.name,
        merchantHref: `/b/${merchant.slug}`,
        categoryName: merchant.category?.name ?? '',
        townName: merchant.town?.name ?? '',
        image: imageUrl(art),
        isLogoArt: !deal.image && !merchant.cover && !!merchant.logo,
        initials: initials(merchant.name),
        expiry: expiryLabel(deal),
        couponCode: deal.coupon_code,
        siblingCount: deal.sibling_count ?? 0,
        dealId: deal.id,
        merchantId: merchant.id,
      };
    });

    const merchants = results.merchants.map((merchant) => ({
      kind: 'merchant' as const,
      name: merchant.name,
      href: `/b/${merchant.slug}`,
      tagline: truncate(merchant.tagline, 90),
      categoryName: merchant.category?.name ?? '',
      townName: merchant.town?.name ?? '',
      address: formatAddress(merchant),
      phone: merchant.phone_display,
      image: imageUrl(merchant.logo ?? merchant.cover),
      initials: initials(merchant.name),
      status: openStatus(merchant.hours)?.label ?? null,
      dealCount: merchant.deals?.length ?? 0,
      merchantId: merchant.id,
    }));

    return new Response(
      JSON.stringify({ deals, merchants, total: results.total, query }),
      { headers }
    );
  } catch {
    return new Response(
      JSON.stringify({ deals: [], merchants: [], total: 0, error: true }),
      { status: 500, headers }
    );
  }
};
