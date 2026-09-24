import { humanError } from './admin';
import { getSiteChrome } from './queries';
import { formatDateTime } from './format';
import { sendEmail, adminRecipient, changeSubmittedEmail } from './notify';
import type { PortalSession } from './portal';

export type SubmitResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Sends one signed change for approval.
 *
 * The signature is the name typed in the form, the account's email, the
 * time, and the special word, which the database checks. Everything about
 * whether this person may change this business is decided in the database
 * (submit_change in 0010), not here.
 */
export async function submitChange(
  locals: App.Locals,
  merchant: { id: string; name: string },
  kind: string,
  dealId: string | null,
  payload: Record<string, unknown>,
  form: FormData
): Promise<SubmitResult> {
  const portal = locals.portal as PortalSession;
  const signedName = String(form.get('signed_name') ?? '').trim();
  const secret = String(form.get('secret') ?? '');

  if (signedName.length < 2) return { ok: false, message: 'Type your name to sign this change.' };
  if (!secret) return { ok: false, message: 'Type your special word to sign this change.' };

  const { data, error } = await portal.db.rpc('submit_change', {
    p_merchant_id: merchant.id,
    p_kind: kind,
    p_deal_id: dealId,
    p_payload: payload,
    p_signed_name: signedName,
    p_secret: secret,
  });

  if (error) {
    console.error('[pocket-perks portal] submit failed', error.code ?? '');
    return { ok: false, message: humanError(error) };
  }
  const result = data as { ok: boolean; message?: string; code?: string; summary?: string };
  if (!result?.ok) {
    // Constraint messages from the dry run are translated like admin ones.
    const message = result?.code ? humanError({ code: result.code, message: result.message }) : result?.message;
    return { ok: false, message: message || 'That could not be sent. Try again.' };
  }

  const { settings } = await getSiteChrome(locals);
  const to = adminRecipient(settings);
  if (to) {
    await sendEmail(changeSubmittedEmail(to, {
      signedName,
      signedEmail: portal.me.email,
      merchantName: merchant.name,
      summary: result.summary ?? 'A change',
      when: formatDateTime(new Date().toISOString()),
    }));
  }

  return { ok: true, message: 'Sent for approval. It will appear on the site once Pocket Perks approves it.' };
}
