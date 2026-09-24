import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { chooseTown, loadEverything, resetDatabase } from './helpers';

test.beforeAll(async () => { await resetDatabase(); });

/**
 * Automated WCAG 2.2 A/AA checks with axe-core, on phone and desktop.
 *
 * Automated checks find roughly a third to a half of real accessibility
 * problems. They are a floor, not a certificate: a manual pass with a
 * screen reader and keyboard is still worth doing before launch.
 */
const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');

async function audit(page: Page) {
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
    // @ts-expect-error injected
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      rules: { 'region': { enabled: true } },
    });
    // Every violation fails the test, including "moderate" best-practice
    // ones: they are cheap to fix and each one is a real annoyance to someone.
    return result.violations
      .map((v: any) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n: any) => n.target.join(' ')).join(' | ')}`);
  });
}

const PAGES = [
  '/', '/?town=all', '/carrollton', '/deals?town=all', '/businesses?town=all', '/b/crossroads-pizza',
  '/b/no-deals-hardware', '/b/crossroads-pizza/ten-off-large', '/for-business', '/privacy', '/terms',
  '/accessibility', '/unsubscribe', '/newsletter', '/does-not-exist', '/admin/login',
];

for (const width of [390, 1280]) {
  test(`no WCAG A/AA violations at ${width}px`, async ({ browser, baseURL }) => {
    // bypassCSP only so the test can inject axe; the site's policy is
    // otherwise exactly as deployed (and blocked the injection, correctly).
    const context = await browser.newContext({ viewport: { width, height: 900 }, baseURL, bypassCSP: true });
    const page = await context.newPage();
    const failures: string[] = [];
    for (const path of PAGES) {
      // The chooser on a first visit; a chosen town everywhere else.
      if (path !== '/') await chooseTown(context, 'carrollton', baseURL!);
      await page.goto(path);
      await loadEverything(page);
      for (const v of await audit(page)) failures.push(`${path}: ${v}`);
    }
    expect(failures).toEqual([]);
    await context.close();
  });
}

test('the whole homepage is usable with a keyboard alone', async ({ page, context, baseURL }) => {
  await chooseTown(context, 'carrollton', baseURL!);
  await page.goto('/');
  // Skip link first, and it moves focus to the content.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();

  // Tab until a business card link is reached, then open it with Enter.
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate(() => document.activeElement?.classList.contains('stretch') ?? false);
    // Every stop must show a visible focus indicator.
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return 'none';
      const s = getComputedStyle(el);
      const card = el.closest('.biz-card');
      return s.outlineStyle !== 'none' || (card && getComputedStyle(card).outlineStyle !== 'none') ? 'shown' : `none on ${el.tagName} ${el.textContent?.trim().slice(0, 20)}`;
    });
    expect(outline).toBe('shown');
  }
  expect(reached).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/b\//);
});

test('the site still works when text is enlarged to 200%', async ({ page, context, baseURL }) => {
  await chooseTown(context, 'carrollton', baseURL!);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/b/crossroads-pizza');
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.getByRole('link', { name: /Call/ }).first()).toBeVisible();
});
