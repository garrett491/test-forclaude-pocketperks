import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../lib/admin';
import { json, storeImage } from '../../../lib/upload';

export const prerender = false;

/** Administrator uploads. The checks and storage rules are in lib/upload.ts. */
export const POST: APIRoute = async ({ cookies, request }) => {
  const session = await requireAdmin(cookies, request);
  if (!session) return json(401, { message: 'Not authorised.' });
  return storeImage(session.db, request, 'uploads', session.profile.id);
};
