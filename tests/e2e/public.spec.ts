import { test, expect } from '@playwright/test';
import { chooseTown, outage, watchConsole, resetDatabase } from './helpers';

test.beforeAll(async () => { await resetDatabase(); });

test.afterEach(async () => { await outage(false); });

test.describe('business pages load — the /b/crossroads-pizza regression', () => {
  test('a direct link loads the full page, and refreshing keeps it', async ({ page }) => {
    const problems = watchConsole(page);
    const response = await page.goto('/b/crossroads-pizza');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: 'Crossroads Pizza' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Call \(330\) 555-0142/ })).toHaveAttribute('href', 'tel:+13305550142');
    await expect(page.locator('footer.site-footer')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Crossroads Pizza' })).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('a business with no photos renders to the end, not cut off mid-page', async ({ page, request }) => {
    // The original fault: the gallery aborted the streamed page for any
    // business without photos, so everything after the deals was missing.
    const html = await (await request.get('/b/no-deals-hardware')).text();
    expect(html).toContain('</html>');
    expect(html).toContain('site-footer');
    await page.goto('/b/no-deals-hardware');
    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
    await expect(page.getByText('No deal running right now')).toBeVisible();
  });

  test('every business card opens its page; Back and Forward behave', async ({ page, context, baseURL }) => {
    await chooseTown(context, 'carrollton', baseURL!);
    await page.goto('/');
    const card = page.locator('.biz-card', { hasText: 'Crossroads Pizza' }).first();
    // Tap where the coupon text is, like a thumb would — not the name.
    // Anywhere on the card must open the business.
    const coupon = card.getByText('Free garlic bread with any pizza');
    await coupon.scrollIntoViewIfNeeded();
    const box = await coupon.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page).toHaveURL(/\/b\/crossroads-pizza$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Crossroads Pizza');
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/b\/crossroads-pizza$/);
  });

  test('every business in the feed has a working page', async ({ page, context, baseURL, request }) => {
    await chooseTown(context, 'all', baseURL!);
    await page.goto('/');
    const hrefs = await page.locator('.biz-card a.stretch').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs.length).toBeGreaterThan(4);
    for (const href of new Set(hrefs)) {
      const res = await request.get(href!);
      expect(res.status(), href!).toBe(200);
      expect(await res.text(), href!).toContain('</html>');
    }
  });

  test('an unknown or unpublished business is a real 404 page, cached only briefly', async ({ page }) => {
    for (const path of ['/b/does-not-exist', '/b/draft-diner', '/b/crossroads-pizza/no-such-deal', '/not-a-town']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(page.getByRole('heading', { name: 'That page isn’t here' })).toBeVisible();
      expect(response?.headers()['cache-control']).toContain('s-maxage=60');
    }
  });

  test('when Supabase is down: a friendly notice, a 503, and nothing cached', async ({ page }) => {
    await outage(true);
    for (const path of ['/b/crossroads-pizza', '/', '/carrollton', '/deals', '/b/crossroads-pizza/ten-off-large']) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(503);
      expect(response?.headers()['cache-control'], path).toContain('no-store');
      await expect(page.getByRole('heading', { name: 'We can’t load deals right now' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
      // The header and footer still work: never a blank screen.
      await expect(page.locator('footer.site-footer')).toBeVisible();
    }
    await outage(false);
    // The site waits five seconds after a failure before trying Supabase
    // again, then recovers on its own with no redeploy.
    await page.waitForTimeout(5500);
    const recovered = await page.goto('/b/crossroads-pizza');
    expect(recovered?.status()).toBe(200);
  });

  test('a deal page shares its own URL and shows its limits', async ({ page }) => {
    await page.goto('/b/crossroads-pizza/ten-off-large');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('$10 off any large pizza');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', /\/b\/crossroads-pizza\/ten-off-large$/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/b\/crossroads-pizza\/ten-off-large$/);
    await expect(page.getByText('PERKS10').first()).toBeVisible();
    await page.getByText('Terms and conditions').click();
    await expect(page.getByText('One per visit. Not valid with other offers.')).toBeVisible();
  });

  test('expired, scheduled and draft deals never appear', async ({ page, context, baseURL }) => {
    await chooseTown(context, 'all', baseURL!);
    await page.goto('/');
    for (const hidden of ['Expired clearance sale', 'Scheduled holiday promo', 'Draft offer nobody should see', 'Deal on a draft business', 'Draft Diner']) {
      await expect(page.getByText(hidden)).toHaveCount(0);
    }
  });
});

test.describe('choosing a town', () => {
  test('a first visit asks which town, and the answer is remembered', async ({ page, context }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Where do you want to find deals?' })).toBeVisible();
    await page.getByRole('link', { name: /Malvern, OH/ }).click();
    await expect(page).toHaveURL(/\/malvern$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Deals in Malvern, OH' })).toBeVisible();

    const cookie = (await context.cookies()).find((c) => c.name === 'pp_town');
    expect(cookie?.value).toBe('malvern');

    // Coming back: straight to Malvern's deals, not asked again.
    await page.goto('/');
    await expect(page.getByText('Showing Malvern, OH')).toBeVisible();
    await expect(page.locator('.biz-card', { hasText: 'Wide Awake Coffee' })).toBeVisible();
    await expect(page.locator('.biz-card', { hasText: 'Crossroads Pizza' })).toHaveCount(0);
  });

  test('the town can be changed from the header at any time', async ({ page, context, baseURL }) => {
    await chooseTown(context, 'malvern', baseURL!);
    await page.goto('/');
    await page.getByRole('button', { name: /Change town/ }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Choose your town' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('link', { name: /Carrollton/ }).click();
    await expect(page).toHaveURL(/\/carrollton$/);
    await page.goto('/');
    await expect(page.getByText('Showing Carrollton, OH')).toBeVisible();
  });

  test('the dialog closes with Escape and returns focus', async ({ page, context, baseURL }) => {
    await chooseTown(context, 'carrollton', baseURL!);
    await page.goto('/');
    const opener = page.locator('.picker-btn');
    await opener.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(opener).toBeFocused();
  });
});

test.describe('business cards', () => {
  test('show up to three coupons, with a count of the rest and no invented extras', async ({ page, context, baseURL }) => {
    await chooseTown(context, 'carrollton', baseURL!);
    await page.goto('/');
    const crossroads = page.locator('.biz-card', { hasText: 'Crossroads Pizza' }).first();
    await expect(crossroads.locator('.coupon')).toHaveCount(3);
    await expect(crossroads.locator('.biz-more')).toHaveCount(0);
    const books = page.locator('.biz-card', { hasText: 'Tall Tales Books' }).first();
    await expect(books.locator('.coupon')).toHaveCount(2);
    const hardware = page.locator('.biz-card', { hasText: 'No Deals Hardware' }).first();
    await expect(hardware.locator('.coupon')).toHaveCount(0);
    await expect(hardware.getByText('No deals running right now')).toBeVisible();
  });

  test('coupons show expiry and code on the card itself', async ({ page, context, baseURL }) => {
    await chooseTown(context, 'carrollton', baseURL!);
    await page.goto('/');
    const salon = page.locator('.biz-card', { hasText: 'Tiny Logo Salon' }).first();
    await expect(salon.getByText('Ends tomorrow')).toBeVisible();
    await expect(salon.getByText('Code NEWCUT')).toBeVisible();
  });

  test('live search replaces the grid with the same cards', async ({ page }) => {
    await page.goto('/deals?town=all');
    await page.getByRole('searchbox', { name: 'Search deals' }).fill('pizza');
    await expect(page.locator('#deal-results .biz-card', { hasText: 'Crossroads Pizza' })).toBeVisible();
    await expect(page.locator('[data-result-count]')).toContainText('for “pizza”');
    await page.getByRole('searchbox', { name: 'Search deals' }).fill('zzzzqqq');
    await expect(page.getByText('Nothing matches “zzzzqqq”')).toBeVisible();
  });

  test('a phone number, address or name finds its business, typed or submitted', async ({ page }) => {
    for (const q of ['330-555-0142', '(330) 555 0142', 'Public Square', 'crossroads']) {
      await page.goto(`/deals?town=all&q=${encodeURIComponent(q)}`);
      await expect(page.locator('.biz-card', { hasText: 'Crossroads Pizza' }), q).toBeVisible();
    }
  });

  test('pressing Search on the homepage goes to the full results', async ({ page, context, baseURL }) => {
    await chooseTown(context, 'carrollton', baseURL!);
    await page.goto('/');
    await page.getByRole('combobox', { name: /Search businesses and deals/ }).fill('garlic');
    await expect(page.locator('#hero-suggestions')).toContainText('Free garlic bread');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL(/\/deals\?q=garlic&town=carrollton/);
    await expect(page.locator('.biz-card', { hasText: 'Crossroads Pizza' })).toBeVisible();
  });
});

test.describe('technical SEO', () => {
  test('pages carry unique titles, canonicals and valid structured data', async ({ page }) => {
    await page.goto('/b/crossroads-pizza');
    await expect(page).toHaveTitle('Crossroads Pizza — Deals & Info — Pocket Perks');
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    const parsed = blocks.map((b) => JSON.parse(b));
    const business = parsed.find((b) => b['@type'] === 'LocalBusiness');
    expect(business.telephone).toBe('+13305550142');
    expect(business.makesOffer).toHaveLength(3);
    expect(business.sameAs).toContain('https://www.facebook.com/crossroadspizza');
  });

  test('sitemap lists live pages only, and robots points to it', async ({ request }) => {
    const xml = await (await request.get('/sitemap.xml')).text();
    expect(xml).toContain('/b/crossroads-pizza</loc>');
    expect(xml).toContain('/carrollton</loc>');
    expect(xml).not.toContain('draft-diner');
    expect(xml).not.toContain('expired-sale');
    expect(await (await request.get('/robots.txt')).text()).toContain('Sitemap:');
  });

  test('the share image and logo referenced in markup exist', async ({ request }) => {
    for (const path of ['/og-default.png', '/logo.png', '/apple-touch-icon.png', '/favicon.svg']) {
      expect((await request.get(path)).status(), path).toBe(200);
    }
  });
});
