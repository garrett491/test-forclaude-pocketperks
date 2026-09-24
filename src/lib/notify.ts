/**
 * Email notifications for the business portal, sent through Resend
 * (resend.com). Optional: with no RESEND_API_KEY set, nothing is sent and
 * everything still works — the admin dashboard and the portal both show
 * what is waiting and what was decided.
 *
 *   RESEND_API_KEY      server only, from resend.com → API Keys
 *   NOTIFY_FROM_EMAIL   e.g. "Pocket Perks <hello@yourpocketperks.com>";
 *                       the domain must be verified in Resend
 *   ADMIN_NOTIFY_EMAIL  where "something is waiting" alerts go. Falls back
 *                       to the contact email in admin Settings.
 *
 * Sending never blocks or fails the action that triggered it: a change is
 * saved first, and a failed email is logged, not shown as an error.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain text. Every email is plain text, so nothing a business typed can become markup. */
  text: string;
}

export function emailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM_EMAIL);
}

export async function sendEmail(message: EmailMessage): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM_EMAIL;
  if (!key || !from || !message.to) return false;

  // Test runs point this at a local catcher instead of the real service.
  const endpoint = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [message.to], subject: message.subject.slice(0, 200), text: message.text }),
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn('[pocket-perks] email not sent', response.status);
      return false;
    }
    return true;
  } catch (error) {
    console.warn('[pocket-perks] email not sent', error instanceof Error ? error.message : error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function adminRecipient(settings: Record<string, unknown>): string {
  return process.env.ADMIN_NOTIFY_EMAIL || (typeof settings['contact.email'] === 'string' ? settings['contact.email'] as string : '');
}

export function siteUrl(): string {
  return (import.meta.env.PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
}

const clean = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

export function changeSubmittedEmail(to: string, info: {
  signedName: string; signedEmail: string; merchantName: string; summary: string; when: string;
}): EmailMessage {
  return {
    to,
    subject: `Waiting for approval: ${clean(info.merchantName)} — ${clean(info.summary)}`,
    text: [
      `${clean(info.signedName)} (${info.signedEmail}) sent a change for ${clean(info.merchantName)}:`,
      '',
      `  ${clean(info.summary)}`,
      '',
      `Signed with their special word on ${info.when}.`,
      '',
      `Review it: ${siteUrl()}/admin/approvals`,
    ].join('\n'),
  };
}

export function changeReviewedEmail(to: string, info: {
  signedName: string; merchantName: string; summary: string; approved: boolean; note: string | null; slug: string | null;
}): EmailMessage {
  const lines = [
    `Hi ${clean(info.signedName)},`,
    '',
    info.approved
      ? `Your change for ${clean(info.merchantName)} was approved and is now on Pocket Perks:`
      : `Your change for ${clean(info.merchantName)} was not approved:`,
    '',
    `  ${clean(info.summary)}`,
  ];
  if (info.note) lines.push('', `Note from Pocket Perks: ${info.note.trim()}`);
  if (info.approved && info.slug) lines.push('', `See it: ${siteUrl()}/b/${info.slug}`);
  lines.push('', `Your business portal: ${siteUrl()}/portal`);
  return {
    to,
    subject: info.approved ? `Approved: ${clean(info.summary)}` : `Not approved: ${clean(info.summary)}`,
    text: lines.join('\n'),
  };
}

export function inviteEmail(to: string, info: { merchantNames: string[]; link: string }): EmailMessage {
  return {
    to,
    subject: 'Your Pocket Perks business login',
    text: [
      'Hello,',
      '',
      `You now have a Pocket Perks business login for ${info.merchantNames.join(', ')}.`,
      'Use the link below to choose your password. It works once and expires after an hour;',
      'if it has expired, ask Pocket Perks for a new one.',
      '',
      info.link,
      '',
      'After that, sign in any time at ' + siteUrl() + '/portal/login',
    ].join('\n'),
  };
}
