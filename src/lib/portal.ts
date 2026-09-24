import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getAuthClient } from './admin';

/**
 * Business portal sessions.
 *
 * A business login is an ordinary Supabase Auth account with a row in
 * portal_users (migration 0010) and no row in profiles, so it has no
 * administrator rights anywhere. What it can see and propose is decided by
 * the database functions in 0010, which check membership of each business
 * themselves. The checks here only decide which page to show.
 */

export interface PortalMerchant {
  id: string;
  name: string;
  slug: string;
}

export interface PortalMe {
  user_id: string;
  display_name: string;
  email: string;
  has_secret: boolean;
  is_active: boolean;
  merchants: PortalMerchant[];
}

export interface PortalSession {
  db: SupabaseClient;
  me: PortalMe;
}

/** True when the database has migration 0010. */
export function portalMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01' ||
    /portal_me|Could not find the function/i.test(error.message ?? '');
}

/**
 * The signed-in portal user, or null. `missing` is set when the database
 * has not had migration 0010 yet, so pages can say so plainly.
 */
export async function getPortalSession(
  cookies: AstroCookies,
  request: Request
): Promise<{ session: PortalSession | null; missing: boolean }> {
  const db = getAuthClient(cookies, request);
  const { data: userData, error: userError } = await db.auth.getUser();
  if (userError || !userData?.user) return { session: null, missing: false };

  const { data, error } = await db.rpc('portal_me');
  if (error) return { session: null, missing: portalMissing(error) };
  const me = data as PortalMe | null;
  if (!me || !me.is_active) return { session: null, missing: false };
  return { session: { db, me }, missing: false };
}

/** Only ever send people back inside the portal or the admin. */
export function safeNext(value: string | null | undefined, fallback = '/portal'): string {
  if (!value) return fallback;
  if (value === '/portal' || value.startsWith('/portal/')) return value;
  if (value === '/admin' || value.startsWith('/admin/')) return value;
  return fallback;
}

export const KIND_LABELS: Record<string, string> = {
  deal_create: 'New coupon',
  deal_update: 'Coupon change',
  business_update: 'Business details',
  hours_update: 'Opening hours',
  gallery_add: 'Add a photo',
  gallery_remove: 'Remove a photo',
};

export const FIELD_LABELS: Record<string, string> = {
  headline: 'Headline',
  description: 'Description',
  terms: 'Terms',
  restrictions: 'Limits',
  coupon_code: 'Coupon code',
  starts_at: 'Starts',
  ends_at: 'Ends',
  status: 'On the site',
  tagline: 'Tagline',
  phone_display: 'Phone',
  website_url: 'Website',
  facebook_url: 'Facebook',
  instagram_url: 'Instagram',
  address_line1: 'Address',
  address_line2: 'Address line 2',
  city: 'City',
  postal_code: 'ZIP code',
  logo_media_id: 'Logo',
  cover_media_id: 'Cover photo',
  media_id: 'Photo',
  caption: 'Caption',
  gallery_id: 'Photo',
  days: 'Opening hours',
};

export const STATUS_LABELS: Record<string, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Not approved',
  withdrawn: 'Withdrawn',
};

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ------------------------------------------------------------------ */
/* One business, as the portal sees it                                */
/* ------------------------------------------------------------------ */

export interface PortalRequest {
  id: string;
  kind: string;
  summary: string;
  deal_id: string | null;
  payload: Record<string, unknown>;
  before_data: Record<string, unknown> | null;
  signed_name: string;
  signed_email: string;
  submitted_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  reviewed_at: string | null;
  reviewer_name: string | null;
  review_note: string | null;
  mine: boolean;
}

export interface PortalSnapshot {
  merchant: Record<string, any> & { id: string; name: string; slug: string; tier: string; status: string };
  logo: import('./types').MediaAsset | null;
  cover: import('./types').MediaAsset | null;
  deal_limit: number;
  gallery_limit: number;
  deals: Record<string, any>[];
  hours: { day_of_week: number; is_closed: boolean; opens_at: string | null; closes_at: string | null }[];
  gallery: { id: string; caption: string | null; media: import('./types').MediaAsset }[];
  requests: PortalRequest[];
}

/** The business named in the URL, if this login belongs to it. */
export async function loadBusiness(
  portal: PortalSession,
  slug: string | undefined
): Promise<{ merchant: PortalMerchant; snapshot: PortalSnapshot } | null> {
  const merchant = portal.me.merchants.find((m) => m.slug === slug);
  if (!merchant) return null;
  const { data, error } = await portal.db.rpc('portal_snapshot', { p_merchant_id: merchant.id });
  if (error || !data) {
    console.error('[pocket-perks portal] snapshot failed', error?.code ?? '');
    return null;
  }
  return { merchant, snapshot: data as PortalSnapshot };
}

/** Pending changes for one coupon, or for one kind of change. */
export function pendingFor(snapshot: PortalSnapshot, match: (r: PortalRequest) => boolean): PortalRequest[] {
  return snapshot.requests.filter((r) => r.status === 'pending' && match(r));
}

/** The photos referred to by a list of changes, keyed by id, for ChangeView. */
export async function mediaForRequests(
  db: SupabaseClient,
  requests: { payload: Record<string, unknown> | null; before_data: Record<string, unknown> | null }[]
): Promise<Record<string, import('./types').MediaAsset>> {
  const keys = ['logo_media_id', 'cover_media_id', 'media_id'];
  const ids = new Set<string>();
  for (const r of requests) {
    for (const source of [r.payload, r.before_data]) {
      for (const key of keys) {
        const value = source?.[key];
        if (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)) ids.add(value);
      }
    }
  }
  if (!ids.size) return {};
  const { data } = await db
    .from('media')
    .select('id, bucket_id, storage_path, alt_text, width, height')
    .in('id', [...ids]);
  return Object.fromEntries(((data ?? []) as import('./types').MediaAsset[]).map((m) => [m.id, m]));
}
