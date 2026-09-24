import { test, expect } from '@playwright/test';
import pg from 'pg';
import { chooseTown, resetDatabase } from './helpers';

test.beforeAll(async () => { await resetDatabase(); });

const db = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5433/pp_e2e' });
test.afterAll(async () => { await db.end(); });
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

test.describe('newsletter', () => {
  test('signing up says so plainly and records what was agreed to', async ({ page }) => {
    await page.goto('/newsletter');
    const form = page.locator('form[data-newsletter]').first();
    await form.getByLabel('Email address').fill('reader@example.com');
    await form.getByRole('button', { name: 'Send me deals' }).click();
    await expect(form.getByRole('status')).toHaveText("You're on the list. Watch your inbox.");
    const row = await one(`select status, consent_text, consent_at, source from subscribers where email = 'reader@example.com'`);
    expect(row.status).toBe('active');
    expect(row.consent_text).toContain('Unsubscribe any time');
    expect(row.consent_at).not.toBeNull();
  });

  test('a mistyped address is caught before anything is sent', async ({ page }) => {
    await page.goto('/newsletter');
    const form = page.locator('form[data-newsletter]').first();
    await form.getByLabel('Email address').fill('not-an-email');
    await form.getByRole('button', { name: 'Send me deals' }).click();
    await expect(form.getByRole('status')).toContainText('does not look right');
    await expect(form.getByLabel('Email address')).toHaveAttribute('aria-invalid', 'true');
  });

  test('works with JavaScript switched off, without putting the address in the URL', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    const page = await context.newPage();
    await page.goto('/newsletter');
    await page.getByLabel('Email address').first().fill('nojs@example.com');
    await page.getByRole('button', { name: 'Send me deals' }).first().click();
    await expect(page).toHaveURL(/\/newsletter\?status=ok$/);
    await expect(page.getByRole('status')).toHaveText('You’re on the list. Watch your inbox.');
    expect((await one(`select status from subscribers where email = 'nojs@example.com'`)).status).toBe('active');
    await context.close();
  });

  test('the unsubscribe link needs one press, works, and a later signup is honoured', async ({ page }) => {
    const { unsubscribe_token: token } = await one(`select unsubscribe_token from subscribers where email = 'reader@example.com'`);
    await page.goto(`/unsubscribe?t=${token}`);
    // Opening the link alone changes nothing: mail scanners open every link.
    expect((await one(`select status from subscribers where email = 'reader@example.com'`)).status).toBe('active');
    await page.getByRole('button', { name: 'Unsubscribe me' }).click();
    await expect(page.getByRole('status')).toContainText('You’re unsubscribed');
    expect((await one(`select status from subscribers where email = 'reader@example.com'`)).status).toBe('unsubscribed');

    // Deliberately signing up again puts them back on the list.
    await page.goto('/newsletter');
    const form = page.locator('form[data-newsletter]').first();
    await form.getByLabel('Email address').fill('Reader@Example.com');
    await form.getByRole('button', { name: 'Send me deals' }).click();
    await expect(form.getByRole('status')).toContainText('on the list');
    expect((await one(`select status from subscribers where email = 'reader@example.com'`)).status).toBe('active');
  });

  test('a made-up unsubscribe token is refused politely', async ({ page }) => {
    await page.goto('/unsubscribe?t=00000000-0000-0000-0000-000000000000');
    await page.getByRole('button', { name: 'Unsubscribe me' }).click();
    await expect(page.getByRole('alert')).toContainText('isn’t recognised');
  });
});

test.describe('business enquiry', () => {
  test('sends, and lands in the admin enquiries list', async ({ page }) => {
    await page.goto('/for-business');
    await page.getByLabel('Business name').fill('Hilltop Hardware');
    await page.getByLabel('Your name').fill('Sam Doe');
    await page.getByLabel('Phone').fill('330-555-0199');
    await page.getByLabel('Email', { exact: true }).fill('sam@example.com');
    await page.getByRole('button', { name: 'Send enquiry' }).click();
    await expect(page.locator('.lead-status')).toContainText('We will be in touch');
    expect((await one(`select status, contact_name from merchant_leads where business_name = 'Hilltop Hardware'`)))
      .toEqual({ status: 'new', contact_name: 'Sam Doe' });
  });
});

test.describe('measurement for businesses', () => {
  test('a tap on Call is recorded against that business, with no IP address stored', async ({ page, context, baseURL }) => {
    await chooseTown(context, 'carrollton', baseURL!);
    await page.goto('/b/tiny-logo-salon');
    const before = Number((await one(`select count(*) from events where event_type = 'call_click'`)).count);
    // Stop the tel: link from leaving the page in the test browser.
    await page.route('tel:*', (route) => route.abort());
    await page.getByRole('link', { name: /Call 330 555 0177/ }).first().dispatchEvent('click');
    await expect.poll(async () => Number((await one(`select count(*) from events where event_type = 'call_click'`)).count)).toBe(before + 1);
    const event = await one(`select e.*, m.slug from events e join merchants m on m.id = e.merchant_id where event_type = 'call_click' order by id desc limit 1`);
    expect(event.slug).toBe('tiny-logo-salon');
    expect(event.session_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(event)).not.toContain('127.0.0.1');
  });

  test('robots are recorded as robots, so they never inflate a report', async ({ request }) => {
    await request.post('/api/track', {
      headers: { 'user-agent': 'Googlebot/2.1', 'content-type': 'application/json', origin: 'http://127.0.0.1:4321' },
      data: { event_type: 'merchant_view', merchant_id: 'b0000000-0000-0000-0000-000000000001' },
    });
    const event = await one(`select is_bot from events where event_type = 'merchant_view' order by id desc limit 1`);
    expect(event.is_bot).toBe(true);
  });
});
