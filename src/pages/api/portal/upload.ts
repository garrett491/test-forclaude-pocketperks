import type { APIRoute } from 'astro';
import { json, storeImage } from '../../../lib/upload';

export const prerender = false;

/**
 * Photo uploads from the business portal. The middleware has already
 * checked there is a business login. The photo goes into
 * pending/<business id>/, the only place the storage policy lets a
 * business write, and appears nowhere until an approved change uses it.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const { db, me } = locals.portal;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { message: 'That upload could not be read.' });
  }
  const merchantId = String(form.get('merchant_id') ?? '');
  if (!me.merchants.some((m) => m.id === merchantId)) {
    return json(403, { message: 'This login cannot add photos for that business.' });
  }
  return storeImage(db, request, `pending/${merchantId}`, null, form);
};
