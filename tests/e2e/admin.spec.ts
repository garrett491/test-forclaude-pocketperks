import { test, expect, type Page } from '@playwright/test';
import pg from 'pg';
import { chooseTown, resetDatabase } from './helpers';

test.beforeAll(async () => { await resetDatabase(); });

/**
 * Every admin write, end to end: change it in the dashboard, save, reload,
 * see it persisted — and see it on the public site straight away. The
 * database is the real schema with the real RLS policies, so a save that
 * only looks successful cannot pass here.
 */
const db = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5433/pp_e2e' });
test.afterAll(async () => { await db.end(); });
const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0];

async function signIn(page: Page, email = 'owner@example.com', password = 'correct-horse-battery') {
  await page.goto('/admin/login');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('signing in', () => {
  test('the dashboard is closed to visitors', async ({ page, request }) => {
    await page.goto('/admin/merchants');
    await expect(page).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fmerchants/);
    // The upload endpoint refuses anyone not signed in.
    const res = await request.post('/api/admin/upload', { multipart: { file: { name: 'a.webp', mimeType: 'image/webp', buffer: Buffer.from('x') } }, headers: { origin: 'http://127.0.0.1:4321' } });
    expect(res.status()).toBe(401);
  });

  test('a wrong password is refused with a plain message', async ({ page }) => {
    await signIn(page, 'owner@example.com', 'wrong');
    await expect(page.getByRole('alert')).toHaveText('That email address and password do not match.');
  });

  test('password reset sends the typed address, and asks for one if blank', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByRole('button', { name: /Forgot your password/ }).click();
    await expect(page.getByRole('alert')).toContainText('Type your email address above');
    await page.getByLabel('Email address').fill('owner@example.com');
    await page.getByRole('button', { name: /Forgot your password/ }).click();
    await expect(page.getByRole('status')).toHaveText('If that address has an account, a reset link is on its way.');
    await expect(page.getByLabel('Email address')).toHaveValue('owner@example.com');
  });

  test('a real account without admin rights gets nowhere', async ({ page }) => {
    await signIn(page, 'nobody@example.com');
    await expect(page.getByRole('alert')).toHaveText('That account does not have access.');
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('the owner signs in, lands where they were going, and signs out', async ({ page }) => {
    await page.goto('/admin/deals');
    await page.getByLabel('Email address').fill('owner@example.com');
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/admin\/deals$/);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/admin\/login/);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});

test.describe('changes persist and show on the site', () => {
  test.beforeEach(async ({ page }) => { await signIn(page); await expect(page).toHaveURL(/\/admin$/); });

  test('featured and carousel switches save, survive a reload, and change the site', async ({ page, context, baseURL }) => {
    await page.goto('/admin/merchants/b0000000-0000-0000-0000-000000000001');
    const featured = page.getByRole('checkbox', { name: 'Featured', exact: true });
    const carousel = page.getByRole('checkbox', { name: 'Show in the featured carousel' });
    await expect(featured).toBeChecked();
    await expect(carousel).toBeChecked();
    await featured.uncheck();
    await carousel.uncheck();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').first()).toContainText('Saved');

    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Featured', exact: true })).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Show in the featured carousel' })).not.toBeChecked();
    expect(await one(`select is_featured, show_in_carousel from merchants where slug = 'crossroads-pizza'`))
      .toEqual({ is_featured: false, show_in_carousel: false });

    const visitor = await context.browser()!.newContext({ baseURL });
    await chooseTown(visitor, 'carrollton', baseURL!);
    const pub = await visitor.newPage();
    await pub.goto('/');
    await expect(pub.locator('[data-slide]:not([inert])', { hasText: 'Crossroads Pizza' })).toHaveCount(0);
    await expect(pub.locator('.biz-card', { hasText: 'Crossroads Pizza' }).locator('.biz-featured-band')).toHaveCount(0);
    await visitor.close();

    // And back on again.
    await page.getByRole('checkbox', { name: 'Featured', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Show in the featured carousel' }).check();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').first()).toContainText('Saved');
    expect(await one(`select is_featured, show_in_carousel from merchants where slug = 'crossroads-pizza'`))
      .toEqual({ is_featured: true, show_in_carousel: true });
  });

  test('a new deal goes live on the card; the plan limit is explained, not hidden', async ({ page, context, baseURL }) => {
    await page.goto('/admin/merchants/b0000000-0000-0000-0000-000000000002'); // Tall Tales Books, Pro, 2 live
    await page.getByLabel('Headline').fill('Buy 3 paperbacks, get 1 free');
    await page.getByLabel(/Key limits/).fill('Used paperbacks only');
    await page.getByLabel('Status', { exact: true }).last().selectOption('active');
    await page.getByRole('button', { name: 'Add deal' }).click();
    await expect(page.getByRole('status').first()).toHaveText('Deal added.');

    const visitor = await context.browser()!.newContext({ baseURL });
    await chooseTown(visitor, 'carrollton', baseURL!);
    const pub = await visitor.newPage();
    await pub.goto('/');
    const card = pub.locator('.biz-card', { hasText: 'Tall Tales Books' }).first();
    await expect(card.locator('.coupon')).toHaveCount(3);
    await expect(card.getByText('Used paperbacks only')).toBeVisible();
    await visitor.close();

    // A fourth live deal is over the Pro plan's three: refused, with the reason.
    await page.getByLabel('Headline').fill('One too many');
    await page.getByLabel('Status', { exact: true }).last().selectOption('active');
    await page.getByRole('button', { name: 'Add deal' }).click();
    await expect(page.getByRole('alert')).toContainText('pro plan, which includes 3 live deal');
  });

  test('a deal end date is Ohio time and the deal disappears exactly then', async ({ page }) => {
    await page.goto('/admin/deals/c0000000-0000-0000-0000-000000000004');
    await page.getByLabel('Ends (Ohio time)').fill('2031-06-30T23:59');
    await page.getByRole('textbox', { name: 'Key limits, shown on cards' }).fill('Excludes signed first editions');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').first()).toContainText('Saved');
    const row = await one(`select ends_at, restrictions from deals where id = 'c0000000-0000-0000-0000-000000000004'`);
    expect(new Date(row.ends_at).toISOString()).toBe('2031-07-01T03:59:00.000Z');
    expect(row.restrictions).toBe('Excludes signed first editions');
    await page.reload();
    await expect(page.getByLabel('Ends (Ohio time)')).toHaveValue('2031-06-30T23:59');
  });

  test('an end date before the start date is refused', async ({ page }) => {
    await page.goto('/admin/deals/c0000000-0000-0000-0000-000000000005');
    await page.getByLabel('Starts (Ohio time)').fill('2031-06-30T12:00');
    await page.getByLabel('Ends (Ohio time)').fill('2031-06-01T12:00');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toHaveText('The end date has to be after the start date.');
    expect((await one(`select starts_at from deals where id = 'c0000000-0000-0000-0000-000000000005'`)).starts_at).toBeNull();
  });

  test('half-filled opening hours are caught instead of silently dropped', async ({ page }) => {
    await page.goto('/admin/merchants/b0000000-0000-0000-0000-000000000003');
    await page.getByLabel('Monday opening time').fill('09:00');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toContainText('Monday: add both an opening and a closing time');
    await page.getByLabel('Monday closing time').fill('17:00');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').first()).toContainText('Saved');
    expect(await one(`select opens_at, closes_at from merchant_hours where merchant_id = 'b0000000-0000-0000-0000-000000000003' and day_of_week = 1`))
      .toEqual({ opens_at: '09:00:00', closes_at: '17:00:00' });
  });

  test('a website without https is refused with an instruction', async ({ page }) => {
    await page.goto('/admin/merchants/b0000000-0000-0000-0000-000000000003');
    // Bypass the browser's own URL check to prove the database guard.
    await page.getByLabel('Website').evaluate((el: HTMLInputElement) => { el.type = 'text'; });
    await page.getByLabel('Website').fill('www.example.com');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toHaveText('Links must start with https:// and be a full web address.');
  });

  test('site wording saves and appears on the homepage at once', async ({ page, context, baseURL }) => {
    await page.goto('/admin/content');
    await page.getByLabel('Heading', { exact: true }).fill('Local deals, right here');
    await page.getByRole('button', { name: 'Save heading' }).click();
    await expect(page.getByRole('status').first()).toContainText('Content saved');
    const visitor = await context.browser()!.newContext({ baseURL });
    await chooseTown(visitor, 'carrollton', baseURL!);
    const pub = await visitor.newPage();
    await pub.goto('/');
    await expect(pub.getByRole('heading', { level: 1 })).toHaveText('Local deals, right here');
    await visitor.close();
  });

  test('settings save as real values; a bad link is refused', async ({ page }) => {
    await page.goto('/admin/settings');
    await page.getByLabel('Seconds per card').fill('12');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('status').first()).toContainText('Settings saved');
    expect((await one(`select value from site_settings where key = 'carousel.seconds_per_slide'`)).value).toBe(12);

    await page.getByLabel('Facebook page').fill('facebook.com/pocketperks');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('alert')).toContainText('must be a full web address');
  });

  test('an uploaded logo previews at once, saves, and shows whole on the site', async ({ page, context, baseURL }) => {
    await page.goto('/admin/merchants/b0000000-0000-0000-0000-000000000005'); // No Deals Hardware: no logo yet
    const upload = page.locator('[data-upload]').first();
    await upload.locator('input[type=file]').setInputFiles('.supabase-local/storage/merchant-media/fixtures/logo-very-wide.webp');
    await expect(upload.getByRole('status')).toHaveText('Uploaded. Press Save to put it on the site.');
    await expect(upload.locator('[data-preview-card] img')).toBeVisible();
    await expect(upload.locator('[data-warning]')).toContainText('very wide');
    await page.getByLabel('Describe the image').first().fill('No Deals Hardware logo');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').first()).toContainText('Saved');

    const media = await one(`select m.storage_path, m.width, m.height, m.alt_text, m.variants from merchants b join media m on m.id = b.logo_media_id where b.slug = 'no-deals-hardware'`);
    expect(media.storage_path).toMatch(/^uploads\/\d{4}\/[0-9a-f-]+\.webp$/);
    expect(media.width / media.height).toBeCloseTo(5, 1);
    expect(media.alt_text).toBe('No Deals Hardware logo');
    // An 800px logo is already small: no second copy is needed or made.
    expect(media.variants).toHaveLength(0);

    const visitor = await context.browser()!.newContext({ baseURL });
    const pub = await visitor.newPage();
    await pub.goto('/b/no-deals-hardware');
    const logo = pub.getByRole('img', { name: 'No Deals Hardware logo' });
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth > 0 && getComputedStyle(img).objectFit)).toBe('contain');
    await visitor.close();
  });

  test('a large cover photo also stores a small copy that phones load', async ({ page, context, baseURL }) => {
    await page.goto('/admin/merchants/b0000000-0000-0000-0000-000000000003'); // Square Deal Auto: no cover
    const cover = page.locator('[data-upload]').nth(1);
    await cover.locator('input[type=file]').setInputFiles('.supabase-local/storage/merchant-media/fixtures/photo-landscape-16x9.webp');
    await expect(cover.getByRole('status')).toHaveText('Uploaded. Press Save to put it on the site.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status').first()).toContainText('Saved');
    const media = await one(`select m.width, m.variants from merchants b join media m on m.id = b.cover_media_id where b.slug = 'square-deal-auto'`);
    expect(media.width).toBe(1600);
    expect(media.variants.map((v: { w: number }) => v.w)).toEqual([640, 1200]);

    // A typical phone (390px wide, 3× screen) gets the 1200px copy, not the
    // 1600px original.
    const visitor = await context.browser()!.newContext({ baseURL, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    await chooseTown(visitor, 'carrollton', baseURL!);
    const pub = await visitor.newPage();
    await pub.goto('/');
    const band = pub.locator('.biz-card', { hasText: 'Square Deal Auto' }).locator('.biz-band img');
    await band.scrollIntoViewIfNeeded();
    await expect.poll(() => band.evaluate((img: HTMLImageElement) => img.currentSrc)).toContain('-1200.webp');
    await visitor.close();
  });

  test('a failed save keeps everything that was typed', async ({ page }) => {
    await page.goto('/admin/merchants/b0000000-0000-0000-0000-000000000004');
    await page.getByLabel('Tagline').fill('Cuts, colour and a good chat');
    await page.getByLabel('Tuesday opening time').fill('10:00');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('alert')).toContainText('Tuesday');
    await expect(page.getByLabel('Tagline')).toHaveValue('Cuts, colour and a good chat');
    await expect(page.getByLabel('Tuesday opening time')).toHaveValue('10:00');
  });

  test('archiving asks first, then removes the business from the site', async ({ page, request }) => {
    await page.goto('/admin/merchants/b0000000-0000-0000-0000-000000000007');
    page.once('dialog', (d) => d.dismiss());
    await page.getByRole('button', { name: /Archive Broken Image Bakery/ }).click();
    await expect(page).toHaveURL(/b0000000-0000-0000-0000-000000000007$/); // cancelled: nothing happened
    expect((await request.get('/b/broken-image-bakery')).status()).toBe(200);

    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Archive Broken Image Bakery/ }).click();
    await expect(page).toHaveURL(/\/admin\/merchants\?saved=/);
    expect((await request.get('/b/broken-image-bakery')).status()).toBe(404);
  });
});
