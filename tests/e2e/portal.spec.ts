import { test, expect, type Page, type Browser } from '@playwright/test';
import { createRequire } from 'node:module';
import pg from 'pg';
import { resetDatabase, SUPABASE } from './helpers';

test.beforeAll(async () => { await resetDatabase(); });

/**
 * The business portal, end to end, against the real migrations and RLS:
 * a business proposes, signs with its special word, and nothing reaches the
 * public site until an administrator approves it.
 */
const db = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5433/pp_e2e' });
test.afterAll(async () => { await db.end(); });
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

const PASSWORD = 'correct-horse-battery';

async function portalSignIn(page: Page, email = 'books@example.com', password = PASSWORD) {
  await page.goto('/portal/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function adminPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/admin/login');
  await page.getByLabel('Email address').fill('owner@example.com');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  return page;
}

async function emails(): Promise<{ to: string[]; subject: string; text: string }[]> {
  return (await fetch(`${SUPABASE}/__control/emails`)).json();
}

async function sign(page: Page, word: string, scope?: string) {
  const root = scope ? page.locator(scope) : page;
  await root.getByLabel('Your special word').fill(word);
}

test('the portal is closed to visitors and to the admin area', async ({ page, request }) => {
  await page.goto('/portal/tall-tales-books');
  await expect(page).toHaveURL(/\/portal\/login\?next=/);
  const upload = await request.post('/api/portal/upload', {
    multipart: { merchant_id: 'b0000000-0000-0000-0000-000000000002' },
    headers: { origin: 'http://127.0.0.1:4321' },
  });
  expect(upload.status()).toBe(401);

  await portalSignIn(page);
  await expect(page).toHaveURL(/\/portal\/tall-tales-books$/);
  // A business login is not an administrator.
  await page.goto('/admin/merchants');
  await expect(page).toHaveURL(/\/admin\/login/);
  // And cannot open another business's portal.
  await page.goto('/portal/crossroads-pizza');
  await expect(page).toHaveURL(/\/portal\/tall-tales-books$/);
});

test('a new coupon is signed, waits for approval, then goes live', async ({ page, browser }) => {
  await fetch(`${SUPABASE}/__control/emails?clear=1`);
  await portalSignIn(page);
  await page.getByRole('link', { name: 'Add a coupon' }).click();
  await page.getByLabel('Headline').fill('Buy two paperbacks, get one free');
  await page.getByLabel(/^Limits/).fill('Used books only');
  await page.getByLabel(/^Coupon code/).fill('READ3');

  // A wrong special word sends nothing and keeps what was typed.
  await sign(page, 'not my word');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('alert')).toContainText('special word is not right');
  await expect(page.getByLabel('Headline')).toHaveValue('Buy two paperbacks, get one free');

  await sign(page, 'Blue Heron');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page).toHaveURL(/\?sent=1/);
  await expect(page.getByRole('status')).toContainText('Sent for approval');

  // Not on the site yet.
  const before = await (await page.request.get('/b/tall-tales-books')).text();
  expect(before).not.toContain('Buy two paperbacks');

  const admin = await adminPage(browser);
  await expect(admin.getByRole('heading', { name: /Waiting for approval \(1\)/ })).toBeVisible();
  await admin.goto('/admin/approvals');
  const change = admin.locator('[data-change]').first();
  await expect(change).toContainText('Tall Tales Books');
  await expect(change).toContainText('Signed by Sam Reader (books@example.com)');
  await expect(change).toContainText('special word checked');
  await change.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByRole('status')).toContainText('Approved');

  const after = await (await page.request.get('/b/tall-tales-books')).text();
  expect(after).toContain('Buy two paperbacks');
  const row = await one(`select status, coupon_code, restrictions from deals where headline = 'Buy two paperbacks, get one free'`);
  expect(row).toEqual({ status: 'active', coupon_code: 'READ3', restrictions: 'Used books only' });

  // You were told something was waiting; they were told it was approved.
  const sent = await emails();
  expect(sent.map((e) => e.to[0])).toEqual(['owner@example.com', 'books@example.com']);
  expect(sent[1].subject).toContain('Approved');

  await page.goto('/portal/tall-tales-books');
  await expect(page.getByRole('heading', { name: 'Recently reviewed' })).toBeVisible();
  await admin.context().close();
});

test('ending a coupon waits for approval too; a rejection comes with its note', async ({ page, browser }) => {
  await portalSignIn(page);
  await page.getByRole('link', { name: /Edit or end: 20% off used books/ }).click();
  const endForm = page.locator('form', { has: page.getByRole('button', { name: 'Send: end this coupon' }) });
  await sign(page, 'blue heron', `form:has(button:has-text("Send: end this coupon"))`);
  await endForm.getByRole('button', { name: 'Send: end this coupon' }).click();
  await expect(page).toHaveURL(/\?sent=1/);

  // Still live until approved.
  expect(await (await page.request.get('/b/tall-tales-books')).text()).toContain('20% off used books');

  // Business details: a bad link is refused on the form, nothing is queued.
  await page.goto('/portal/tall-tales-books/details');
  await page.getByLabel(/^Tagline/).fill('Rare finds and old favourites');
  await page.getByLabel(/^Website/).fill('http://no-https.example');
  await sign(page, 'blue heron');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('alert')).toContainText('https://');
  await page.getByLabel(/^Website/).fill('');
  await sign(page, 'blue heron');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page).toHaveURL(/\?sent=1/);

  const admin = await adminPage(browser);
  await admin.goto('/admin/approvals');
  const ending = admin.locator('[data-change]', { hasText: 'End coupon: 20% off used books' });
  await ending.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByRole('status')).toContainText('Approved');
  expect(await (await page.request.get('/b/tall-tales-books')).text()).not.toContain('20% off used books');

  const details = admin.locator('[data-change]', { hasText: 'Business details' });
  await expect(details).toContainText('Rare finds and old favourites');
  await details.getByText('Don’t approve…').click();
  await details.getByLabel(/Note to Sam Reader/).fill('Please add your opening hours as well.');
  await details.getByRole('button', { name: 'Don’t approve' }).click();
  await expect(admin.getByRole('status')).toContainText('not approved');
  expect((await one(`select tagline from merchants where slug = 'tall-tales-books'`)).tagline).not.toBe('Rare finds and old favourites');

  await page.goto('/portal/tall-tales-books');
  await expect(page.locator('[data-change]', { hasText: 'Business details' })).toContainText('Please add your opening hours as well.');
  const sent = await emails();
  expect(sent.at(-1)!.subject).toContain('Not approved');
  expect(sent.at(-1)!.text).toContain('Please add your opening hours as well.');
  await admin.context().close();
});

test('photos and opening hours are proposed the same way', async ({ page, browser, baseURL }) => {
  await portalSignIn(page);
  await page.goto('/portal/tall-tales-books/photos');
  const upload = page.locator('[data-upload]');
  await upload.locator('input[type=file]').setInputFiles('.supabase-local/storage/merchant-media/fixtures/photo-4x3.webp');
  await expect(upload.getByRole('status')).toContainText('Uploaded. Sign and send');
  await page.getByLabel(/^Caption/).fill('The reading nook');
  await sign(page, 'blue heron', 'form:has(input[value=add])');
  await page.locator('form:has(input[value=add])').getByRole('button', { name: 'Send for approval' }).click();
  await expect(page).toHaveURL(/\?sent=1/);
  // The photo waits in the business's own pending folder.
  const media = await one(`select m.storage_path from change_requests c join media m on m.id = (c.payload->>'media_id')::uuid where c.kind = 'gallery_add'`);
  expect(media.storage_path).toMatch(/^pending\/b0000000-0000-0000-0000-000000000002\//);

  await page.goto('/portal/tall-tales-books/hours');
  const monday = page.locator('.hours-row', { hasText: 'Monday' });
  await monday.getByLabel('Monday opening time').fill('09:00');
  await sign(page, 'blue heron');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByRole('alert')).toContainText('Monday: add both');
  await monday.getByLabel('Monday closing time').fill('17:30');
  await sign(page, 'blue heron');
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page).toHaveURL(/\?sent=1/);

  const admin = await adminPage(browser);
  await admin.goto('/admin/approvals');
  const waitingList = admin.locator('section[aria-labelledby=waiting-title]');
  const photo = waitingList.locator('[data-change]', { hasText: 'Add a photo' });
  await expect(photo.locator('img')).toBeVisible();
  await photo.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByRole('status')).toContainText('Approved');
  const hours = waitingList.locator('[data-change]', { hasText: 'Opening hours' });
  await expect(hours).toContainText('09:00 – 17:30');
  await hours.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.getByRole('status')).toContainText('Approved');

  const visitor = await browser.newPage({ baseURL });
  await visitor.goto('/b/tall-tales-books');
  await expect(visitor.getByText('The reading nook')).toBeVisible();
  expect((await one(`select opens_at::text, closes_at::text from merchant_hours h join merchants m on m.id = h.merchant_id where m.slug = 'tall-tales-books' and day_of_week = 1`)))
    .toEqual({ opens_at: '09:00:00', closes_at: '17:30:00' });
  await visitor.close();
  await admin.context().close();
});

test('you add a login; they choose a password and special word; it works', async ({ page, browser }) => {
  const admin = await adminPage(browser);
  await admin.goto('/admin/business-logins');
  await admin.getByLabel('Their email address').fill('Owner@CrossroadsPizza.example');
  await admin.getByLabel('Business', { exact: true }).selectOption({ label: 'Crossroads Pizza' });
  await admin.getByRole('button', { name: 'Create login and sign-in link' }).click();
  const link = await admin.getByRole('textbox', { name: 'Sign-in link' }).inputValue();
  expect(link).toContain('/auth/set-password?token_hash=');
  const invite = (await emails()).at(-1)!;
  expect(invite.to[0]).toBe('owner@crossroadspizza.example');
  expect(invite.text).toContain(link);

  // An admin's own address cannot be turned into a business login.
  await admin.getByLabel('Their email address').fill('owner@example.com');
  await admin.getByLabel('Business', { exact: true }).selectOption({ label: 'Crossroads Pizza' });
  await admin.getByRole('button', { name: 'Create login and sign-in link' }).click();
  await expect(admin.getByRole('alert')).toContainText('different kind of account');

  await page.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(page).toHaveURL(/\/auth\/set-password\?next=/); // the token is gone from the address bar
  await page.getByLabel('New password').fill('pizza-oven-2026');
  await page.getByLabel('Type it again').fill('pizza-oven-2026');
  await page.getByRole('button', { name: 'Save password' }).click();

  // First stop: name and special word. Nothing else opens until they are set.
  await expect(page).toHaveURL(/\/portal\/account\?welcome=1/);
  await page.goto('/portal/crossroads-pizza/hours');
  await expect(page).toHaveURL(/\/portal\/account\?welcome=1/);
  await page.getByLabel('Your name').fill('Rita Crossroads');
  await page.getByLabel('Choose a special word').fill('deep dish');
  await page.getByLabel('Type it again').fill('deep dish');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(/\/portal\/crossroads-pizza$/);

  // The link works once.
  const again = await browser.newPage();
  await again.goto(link.replace(/^https?:\/\/[^/]+/, ''));
  await expect(again.getByRole('alert')).toContainText('expired or was already used');
  await again.close();

  // Signing in later with the password they chose.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await portalSignIn(page, 'owner@crossroadspizza.example', 'pizza-oven-2026');
  await expect(page).toHaveURL(/\/portal\/crossroads-pizza$/);

  // Switched off: signed out of everything at the next page.
  await admin.goto('/admin/business-logins');
  const entry = admin.locator('li.login', { hasText: 'owner@crossroadspizza.example' });
  admin.once('dialog', (d) => d.accept());
  await entry.getByRole('button', { name: 'Switch off' }).click();
  await expect(admin.getByRole('status')).toContainText('switched off');
  await page.goto('/portal/crossroads-pizza');
  await expect(page).toHaveURL(/\/portal\/login/);
  await admin.context().close();
});

test('portal and approval pages pass the same accessibility checks', async ({ browser }) => {
  const require = createRequire(import.meta.url);
  const axePath = require.resolve('axe-core/axe.min.js');
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, bypassCSP: true });
    const page = await context.newPage();
    const checkPage = async (tab: Page, path: string) => {
      await tab.goto(path);
      expect(new URL(tab.url()).pathname, `${path} should not redirect`).toBe(path);
      await tab.addScriptTag({ path: axePath });
      const violations = await tab.evaluate(async () => {
        // @ts-expect-error injected
        const result = await window.axe.run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
        });
        return result.violations.map((v: any) => `${v.id}: ${v.nodes.slice(0, 2).map((n: any) => n.target.join(' ')).join(' | ')}`);
      });
      expect(violations, `${path} at ${width}px`).toEqual([]);
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);
    };
    // Signed out first, so the sign-in pages are the real ones.
    await checkPage(page, '/portal/login');
    await checkPage(page, '/auth/set-password');
    await portalSignIn(page);
    const admin = await context.browser()!.newContext({ viewport: { width, height: 900 }, bypassCSP: true });
    const adminTab = await admin.newPage();
    await adminTab.goto('/admin/login');
    await adminTab.getByLabel('Email address').fill('owner@example.com');
    await adminTab.getByLabel('Password').fill(PASSWORD);
    await adminTab.getByRole('button', { name: 'Sign in' }).click();
    await expect(adminTab).toHaveURL(/\/admin$/);

    const targets: [Page, string][] = [
      [page, '/portal/tall-tales-books'], [page, '/portal/tall-tales-books/coupon/new'],
      [page, '/portal/tall-tales-books/details'], [page, '/portal/tall-tales-books/hours'],
      [page, '/portal/tall-tales-books/photos'], [page, '/portal/tall-tales-books/report'], [page, '/portal/account'],
      [adminTab, '/admin/approvals'], [adminTab, '/admin/business-logins'],
    ];
    for (const [tab, path] of targets) await checkPage(tab, path);
    await admin.close();
    await context.close();
  }
});
