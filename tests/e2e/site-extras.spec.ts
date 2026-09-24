import { test, expect } from '@playwright/test';
import pg from 'pg';
import { chooseTown, resetDatabase } from './helpers';

/**
 * Footer towns, the phone town bar, Facebook links, the outlined email
 * signup box and the compact featured strip on Deals and Businesses.
 */
const db = new pg.Pool({ connectionString: 'postgres://postgres@127.0.0.1:5433/pp_e2e' });

test.beforeAll(async () => {
  await resetDatabase();
  await db.query(`update site_settings set value = '"https://www.facebook.com/pocketperks"' where key = 'social.facebook_url'`);
  await fetch('http://127.0.0.1:54321/__control/reload');
});
test.afterAll(async () => {
  await db.query(`update content_blocks set is_active = true where block_key = 'home.newsletter'`);
  await db.end();
});

test.beforeEach(async ({ context, baseURL }) => { await chooseTown(context, 'carrollton', baseURL!); });

test('the footer lists every town, then "All towns", with no town twice', async ({ page }) => {
  await page.goto('/privacy');
  const browse = page.locator('footer nav[aria-label="Browse"] a');
  await expect(browse).toHaveText(['All deals', 'All businesses', 'Carrollton', 'Malvern', 'All towns']);
});

test('on a phone, the town button follows you down the page', async ({ page }) => {
  await page.goto('/deals');
  const bar = page.locator('[data-town-bar]');
  await expect(bar).toBeHidden();
  await page.mouse.wheel(0, 1600);
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('link', { name: /Facebook/ })).toHaveAttribute('href', 'https://www.facebook.com/pocketperks');
  await bar.getByRole('button', { name: /Change town/ }).click();
  await expect(page.getByRole('dialog', { name: 'Choose your town' })).toBeVisible();
});

test('Facebook is linked in the header and under the homepage search', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.site-header').getByRole('link', { name: /Facebook/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /follow Pocket Perks/ })).toHaveAttribute('target', '_blank');
});

test('one outlined signup box on every page, and it can be switched off', async ({ page }) => {
  for (const path of ['/', '/b/crossroads-pizza', '/deals', '/privacy']) {
    await page.goto(path);
    await expect(page.locator('.signup-box'), path).toHaveCount(1);
    await expect(page.locator('form[data-newsletter]'), path).toHaveCount(1);
  }
  // On a business page it sits under the coupons, not at the very bottom.
  await page.goto('/b/crossroads-pizza');
  const box = await page.locator('.signup-box').boundingBox();
  const deals = await page.locator('#deals-title').boundingBox();
  const footer = await page.locator('footer').boundingBox();
  expect(box!.y).toBeGreaterThan(deals!.y);
  expect(footer!.y - (box!.y + box!.height)).toBeGreaterThan(200);

  await page.goto('/newsletter');
  await expect(page.locator('.signup-box')).toHaveCount(0);

  await db.query(`update content_blocks set is_active = false where block_key = 'home.newsletter'`);
  await page.goto('/privacy');
  await expect(page.locator('.signup-box')).toHaveCount(0);
  await expect(page.locator('footer').getByRole('link', { name: /Get deals by email/ })).toBeVisible();
  await db.query(`update content_blocks set is_active = true where block_key = 'home.newsletter'`);
});

test('Deals and Businesses show the slim featured strip; the homepage keeps the full one', async ({ page }) => {
  for (const path of ['/deals', '/businesses']) {
    await page.goto(path);
    const strip = page.locator('.carousel.is-compact');
    await expect(strip, path).toBeVisible();
    await expect(strip.locator('[data-slide]').first()).toContainText(/deals?\s*→|See what they offer/);
    const height = (await strip.boundingBox())!.height;
    expect(height, `${path} strip height`).toBeLessThan(220);
  }
  // Not on later pages or while searching or filtering.
  await page.goto('/deals?q=pizza');
  await expect(page.locator('.carousel')).toHaveCount(0);
  await page.goto('/deals?category=food-drink');
  await expect(page.locator('.carousel')).toHaveCount(0);

  await page.goto('/');
  await expect(page.locator('.carousel')).toHaveCount(1);
  await expect(page.locator('.carousel.is-compact')).toHaveCount(0);
  await expect(page.locator('.carousel .slide-headline').first()).toBeVisible();
});
