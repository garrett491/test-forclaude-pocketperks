export type MerchantTier = 'standard' | 'pro' | 'premium';
export type PublishStatus = 'draft' | 'active' | 'paused' | 'archived';
export type DealType =
  | 'percent_off' | 'dollar_off' | 'bogo' | 'freebie' | 'bundle' | 'special' | 'other';

export type EventType =
  | 'merchant_view' | 'deal_view' | 'deal_open' | 'code_copy' | 'call_click'
  | 'directions_click' | 'website_click' | 'share' | 'subscribe' | 'search';

export interface Town {
  id: string;
  slug: string;
  name: string;
  state_code: string;
  latitude: number | null;
  longitude: number | null;
  seo_title: string | null;
  seo_description: string | null;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  icon_key: string;
  sort_order: number;
  seo_title: string | null;
  seo_description: string | null;
}

export interface Badge {
  id: string;
  slug: string;
  label: string;
  style_key: 'neutral' | 'lime' | 'deep' | 'outline';
}

export interface MediaAsset {
  id: string;
  bucket_id: string;
  storage_path: string;
  alt_text: string;
  width: number | null;
  height: number | null;
}

export interface MerchantHours {
  day_of_week: number;
  is_closed: boolean;
  opens_at: string | null;
  closes_at: string | null;
}

export interface Merchant {
  id: string;
  slug: string;
  name: string;
  tagline: string | null;
  description: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state_code: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  phone_display: string | null;
  phone_e164: string | null;
  website_url: string | null;
  facebook_url: string | null;
  instagram_url: string | null;
  tier: MerchantTier;
  category_id: string;
  town_id: string;
  is_featured: boolean;
  display_priority: number;
  seo_title: string | null;
  seo_description: string | null;
  created_at: string;
  published_at: string | null;
  category: Category | null;
  town: Town | null;
  logo: MediaAsset | null;
  cover: MediaAsset | null;
  hours?: MerchantHours[];
  deals?: Deal[];
  gallery?: GalleryItem[];
}

export interface GalleryItem {
  id: string;
  caption: string | null;
  sort_order: number;
  media: MediaAsset | null;
}

export interface Deal {
  id: string;
  slug: string;
  headline: string;
  description: string | null;
  terms: string | null;
  deal_type: DealType;
  coupon_code: string | null;
  starts_at: string | null;
  ends_at: string | null;
  is_featured: boolean;
  display_priority: number;
  created_at: string;
  badge: Badge | null;
  image: MediaAsset | null;
  merchant?: Merchant | null;
  /** How many other live deals the same business has. Set by listDealsByMerchant. */
  sibling_count?: number;
}

export interface ContentBlock {
  block_key: string;
  block_type: string;
  title: string | null;
  payload: Record<string, unknown>;
  sort_order: number;
}

export interface NavItem {
  location: 'header' | 'footer';
  section: string | null;
  label: string;
  href: string;
  opens_new_tab: boolean;
  sort_order: number;
}

export type SiteSettings = Record<string, unknown>;
