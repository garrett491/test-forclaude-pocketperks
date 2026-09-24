import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Image upload, shared by the admin (/api/admin/upload) and the business
 * portal (/api/portal/upload).
 *
 * Two things about the design worth knowing:
 *
 * 1. The browser re-encodes every image to WebP on a canvas before it is
 *    sent (see ImageUpload.astro). The bytes that arrive here were produced
 *    by the browser's own encoder, not by the original file, so EXIF and any
 *    payload hidden in a polyglot file are gone by construction rather than
 *    by us trying to strip them. It also means a 4000px phone photo is
 *    resized before it crosses the network instead of after.
 *
 * 2. It uploads with the signed-in person's own session, never the service
 *    role, so the storage and media policies decide where they may write:
 *    administrators anywhere, a business only into pending/<its id>/.
 *
 * The checks below are defence in depth against a client that skipped the
 * canvas step and posted raw bytes at this endpoint.
 */

const BUCKET = 'merchant-media';
const MAX_BYTES = 3_000_000;

/** Sniff the real format. A Content-Type header is whatever the client says. */
function sniff(bytes: Uint8Array): 'image/webp' | 'image/jpeg' | 'image/png' | 'image/avif' | null {
  if (bytes.length < 16) return null;
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';

  const tag = (start: number, text: string) =>
    [...text].every((ch, i) => b[start + i] === ch.charCodeAt(0));

  if (tag(0, 'RIFF') && tag(8, 'WEBP')) return 'image/webp';
  if (tag(4, 'ftyp') && (tag(8, 'avif') || tag(8, 'avis'))) return 'image/avif';
  return null;
}

export const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function storeImage(
  db: SupabaseClient,
  request: Request,
  folder: string,
  createdBy: string | null,
  preparsed?: FormData
): Promise<Response> {
  let form: FormData;
  try {
    form = preparsed ?? await request.formData();
  } catch {
    return json(400, { message: 'That upload could not be read.' });
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return json(400, { message: 'Choose an image first.' });
  }
  if (file.size > MAX_BYTES) {
    return json(413, { message: 'That image is too large. Keep it under 3 MB.' });
  }

  const buffer = new Uint8Array(await file.arrayBuffer());
  const mime = sniff(buffer);
  if (!mime) {
    return json(415, { message: 'That file is not a JPEG, PNG, WebP or AVIF image.' });
  }

  const width = parseInt(String(form.get('width') ?? ''), 10) || null;
  const height = parseInt(String(form.get('height') ?? ''), 10) || null;
  const altText = String(form.get('alt_text') ?? '').trim().slice(0, 200);

  // Server-generated names. A client-supplied filename is a path-traversal
  // and overwrite vector, and nothing useful is lost by discarding it.
  const ext = mime.split('/')[1];
  const base = `${folder}/${new Date().getFullYear()}/${crypto.randomUUID()}`;
  const path = `${base}.${ext}`;
  const written: string[] = [];

  const { error: uploadError } = await db.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mime, cacheControl: '31536000', upsert: false });

  if (uploadError) {
    console.error('storage upload failed', uploadError.message);
    return json(500, { message: 'The image did not upload. Try again.' });
  }
  written.push(path);

  /**
   * Smaller copies, for cards on phones. Optional: if one is missing or
   * anything about it is wrong it is skipped, and the original alone is
   * still a working image.
   */
  const variants: { w: number; h: number; path: string }[] = [];
  for (let index = 0; index < 3; index++) {
    const file = form.get(`variant_${index}`);
    const w = parseInt(String(form.get(`variant_${index}_width`) ?? ''), 10) || 0;
    const h = parseInt(String(form.get(`variant_${index}_height`) ?? ''), 10) || 0;
    if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES || w <= 0 || h <= 0) continue;
    if (width && w >= width) continue;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniff(bytes);
    if (!kind) continue;
    const variantPath = `${base}-${w}.${kind.split('/')[1]}`;
    const { error } = await db.storage
      .from(BUCKET)
      .upload(variantPath, bytes, { contentType: kind, cacheControl: '31536000', upsert: false });
    if (!error) { variants.push({ w, h, path: variantPath }); written.push(variantPath); }
  }

  const row = {
    bucket_id: BUCKET,
    storage_path: path,
    alt_text: altText,
    width,
    height,
    byte_size: buffer.byteLength,
    mime_type: mime,
    created_by: createdBy,
  };
  let result = await db
    .from('media')
    .insert({ ...row, variants })
    .select('id, bucket_id, storage_path, alt_text, width, height')
    .maybeSingle();
  // A database without migration 0009 has no variants column. Keep working.
  if (result.error?.code === 'PGRST204' || result.error?.code === '42703') {
    result = await db.from('media').insert(row)
      .select('id, bucket_id, storage_path, alt_text, width, height').maybeSingle();
  }
  const { data: media, error: mediaError } = result;

  if (mediaError || !media) {
    // Do not leave orphan files in the bucket if the row failed.
    await db.storage.from(BUCKET).remove(written);
    console.error('media row failed', mediaError?.code);
    return json(500, { message: 'The image did not save. Try again.' });
  }

  // The plain object URL. The /render/image/ transform URL used before is a
  // paid-plan feature and fails on the Free plan, which broke every preview.
  const publicUrl = `${import.meta.env.PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;

  return json(200, { media, preview_url: publicUrl, message: 'Image uploaded.' });
}
