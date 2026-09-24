import { publicDb } from './supabase';
import type { MediaAsset, SiteSettings } from './types';
import { imageUrl } from './format';

/**
 * Logos and share images come from the database, with the bundled SVGs as a
 * fallback. Before anything is uploaded the site looks exactly as it does
 * today; after, changing the logo never means touching a file.
 */
export interface Branding {
  logo: string;
  logoAsset: MediaAsset | null;
  footerMark: string;
  favicon: string;
  faviconType: string;
  ogImage: string | null;
}

const FALLBACK = {
  logo: '/logo.svg',
  footerMark: '/logo-mark-light.svg',
  favicon: '/favicon.svg',
};

export async function getBranding(settings: SiteSettings): Promise<Branding> {
  const ids = ['branding.logo_media_id', 'branding.footer_mark_media_id',
               'branding.favicon_media_id', 'branding.og_image_media_id']
    .map((key) => (typeof settings[key] === 'string' ? (settings[key] as string) : ''))
    .filter(Boolean);

  let assets: MediaAsset[] = [];
  if (ids.length) {
    const { data } = await publicDb
      .from('media')
      .select('id, bucket_id, storage_path, alt_text, width, height')
      .in('id', ids);
    assets = (data ?? []) as MediaAsset[];
  }

  const find = (key: string) => assets.find((a) => a.id === settings[key]) ?? null;

  const logoAsset = find('branding.logo_media_id');
  const footerAsset = find('branding.footer_mark_media_id');
  const faviconAsset = find('branding.favicon_media_id');
  const ogAsset = find('branding.og_image_media_id');

  return {
    logo: imageUrl(logoAsset) ?? FALLBACK.logo,
    logoAsset,
    footerMark: imageUrl(footerAsset) ?? FALLBACK.footerMark,
    favicon: imageUrl(faviconAsset) ?? FALLBACK.favicon,
    // An uploaded favicon is always WebP; the bundled fallback is an SVG.
    faviconType: faviconAsset ? 'image/webp' : 'image/svg+xml',
    ogImage: imageUrl(ogAsset),
  };
}
