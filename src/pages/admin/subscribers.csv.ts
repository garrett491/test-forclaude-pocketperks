import type { APIRoute } from 'astro';
import { requireAdmin } from '../../lib/admin';

export const prerender = false;

/**
 * CSV export, shaped for a direct ActiveCampaign import.
 *
 * Values are quoted and internal quotes doubled. Anything starting with
 * =, +, - or @ is prefixed with an apostrophe: without that, a crafted
 * signup address becomes a live formula the moment the file opens in Excel,
 * which is a real and frequently overlooked injection path.
 */
function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export const GET: APIRoute = async ({ cookies, request }) => {
  const session = await requireAdmin(cookies, request);
  if (!session) return new Response('Not authorised', { status: 401 });

  // Consent columns arrive with migration 0009; export without them before that.
  let result: { data: any[] | null; error: { code?: string } | null } = await session.db
    .from('subscribers')
    .select('email, status, source, created_at, confirmed_at, unsubscribe_token, consent_text, consent_at')
    .order('created_at', { ascending: false });
  if (result.error?.code === '42703' || result.error?.code === 'PGRST204') {
    result = await session.db
      .from('subscribers')
      .select('email, status, source, created_at, confirmed_at, unsubscribe_token')
      .order('created_at', { ascending: false });
  }
  const { data, error } = result;

  if (error) return new Response('Export failed', { status: 500 });

  // Each person's own unsubscribe link, ready to merge into the footer of
  // any email sent from another tool. Every commercial email needs one.
  const site = (import.meta.env.PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  const header = ['Email', 'Status', 'Source', 'Signed up', 'Confirmed', 'Unsubscribe link', 'Consent wording', 'Consent given'];
  const rows = (data ?? []).map((s: any) =>
    [
      s.email, s.status, s.source ?? '', s.created_at ?? '', s.confirmed_at ?? '',
      s.unsubscribe_token ? `${site}/unsubscribe?t=${s.unsubscribe_token}` : '',
      s.consent_text ?? '', s.consent_at ?? '',
    ].map(csvCell).join(',')
  );

  const csv = [header.map(csvCell).join(','), ...rows].join('\r\n');
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pocket-perks-subscribers-${stamp}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
};
