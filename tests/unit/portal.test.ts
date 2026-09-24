import { describe, it, expect } from 'vitest';
import { safeNext, portalMissing } from '../../src/lib/portal';
import { changeReviewedEmail, changeSubmittedEmail } from '../../src/lib/notify';

describe('safeNext', () => {
  it('only ever sends people back inside the portal or the admin', () => {
    expect(safeNext('/portal/tall-tales-books')).toBe('/portal/tall-tales-books');
    expect(safeNext('/admin')).toBe('/admin');
    expect(safeNext('https://evil.example/portal')).toBe('/portal');
    expect(safeNext('//evil.example')).toBe('/portal');
    expect(safeNext('/portalx')).toBe('/portal');
    expect(safeNext(null, '/admin')).toBe('/admin');
  });
});

describe('portalMissing', () => {
  it('recognises a database without migration 0010', () => {
    expect(portalMissing({ code: 'PGRST202', message: 'Could not find the function public.portal_me' })).toBe(true);
    expect(portalMissing({ code: '42P01', message: 'relation "public.portal_users" does not exist' })).toBe(true);
    expect(portalMissing({ code: '42501', message: 'permission denied' })).toBe(false);
    expect(portalMissing(null)).toBe(false);
  });
});

describe('notification emails', () => {
  it('keep what a business typed on one line, so it cannot forge extra lines', () => {
    const mail = changeSubmittedEmail('me@example.com', {
      signedName: 'Pat\nApproved by admin', signedEmail: 'pat@example.com', merchantName: 'Cafe',
      summary: 'New coupon: Free\r\ncoffee', when: 'Sep 24, 2026, 3:05 PM',
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain('Pat Approved by admin (pat@example.com)');
  });

  it('say plainly whether a change was approved, with the note', () => {
    const no = changeReviewedEmail('pat@example.com', {
      signedName: 'Pat', merchantName: 'Cafe', summary: 'Opening hours', approved: false, note: 'Add Sunday too.', slug: 'cafe',
    });
    expect(no.subject).toBe('Not approved: Opening hours');
    expect(no.text).toContain('Note from Pocket Perks: Add Sunday too.');
    expect(no.text).not.toContain('/b/cafe');
  });
});
