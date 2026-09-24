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

  const { data, error } = await session.db
    .from('subscribers')
    .select('email, status, source, created_at, confirmed_at')
    .order('created_at', { ascending: false });

  if (error) return new Response('Export failed', { status: 500 });

  const header = ['Email', 'Status', 'Source', 'Signed up', 'Confirmed'];
  const rows = (data ?? []).map((s: any) =>
    [s.email, s.status, s.source ?? '', s.created_at ?? '', s.confirmed_at ?? ''].map(csvCell).join(',')
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
