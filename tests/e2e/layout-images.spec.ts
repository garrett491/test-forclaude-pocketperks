import { test, expect } from '@playwright/test';
import { chooseTown, loadEverything, resetDatabase } from './helpers';

test.beforeAll(async () => { await resetDatabase(); });

/**
 * The image rule, checked across every width that matters: no business
 * image is ever cropped, stretched or allowed past its frame, and no page
 * ever scrolls sideways.
 *
 * The fixture images are deliberately awkward — 5:1 wordmarks, 1:3 logos,
 * 9:16 flyers, a 40px logo, a missing file — and each has a coloured frame
 * drawn at its very edge, so a screenshot shows at a glance if anything
 * was cut.
 */
const WIDTHS = [320, 360, 375, 390, 414, 430, 768, 1024, 1440, 1920];
const PAGES = [
  '/?town=all', '/carrollton', '/malvern', '/deals?town=all', '/businesses?town=all',
  '/b/crossroads-pizza', '/b/tall-tales-books', '/b/tiny-logo-salon', '/b/square-deal-auto/five-off-oil',
];

for (const width of WIDTHS) {
  test(`at ${width}px: no sideways scroll, and every image whole`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, baseURL });
    await chooseTown(context, 'all', baseURL!);
    const page = await context.newPage();

    for (const path of PAGES) {
      await page.goto(path);
      await loadEverything(page);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} scrolls sideways at ${width}px`).toBeLessThanOrEqual(0);

      const problems = await page.evaluate(() => {
        const issues: string[] = [];
        for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('main img:not(dialog img)'))) {
          const style = getComputedStyle(img);
          const name = img.currentSrc.split('/').pop();
          if (style.objectFit === 'cover' || style.objectFit === 'fill' && img.naturalWidth) {
            // fill is only acceptable when the box already has the image's shape
            const r = img.getBoundingClientRect();
            const boxRatio = r.width / r.height;
            const natural = img.naturalWidth / img.naturalHeight;
            if (style.objectFit === 'cover' || Math.abs(boxRatio - natural) / natural > 0.02) {
              issues.push(`${name}: object-fit ${style.objectFit} distorts or crops`);
            }
          }
          const frame = img.closest('.mf');
          if (!frame) { issues.push(`${name}: not inside an image frame`); continue; }
          if (frame.classList.contains('is-broken')) continue;
          const r = img.getBoundingClientRect();
          const f = frame.getBoundingClientRect();
          if (r.left < f.left - 1 || r.right > f.right + 1 || r.top < f.top - 1 || r.bottom > f.bottom + 1) {
            issues.push(`${name}: image box spills outside its frame (clipped)`);
          }
          if (img.complete && img.naturalWidth === 0) issues.push(`${name}: failed to load with no fallback`);
        }
        return issues;
      });
      expect(problems, `${path} at ${width}px`).toEqual([]);
    }
    await context.close();
  });
}

test('a missing image shows the initials tile, never a broken-image icon', async ({ page }) => {
  await page.goto('/b/broken-image-bakery');
  await loadEverything(page);
  const frame = page.locator('.profile-logo');
  await expect(frame).toHaveClass(/is-broken/);
  await expect(frame.locator('.mf-fallback')).toBeVisible();
  await expect(frame.locator('.mf-fallback')).toHaveText('BI');
  await expect(frame.locator('img')).toBeHidden();
});

test('a tall flyer on a deal page shows its fine print at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/b/square-deal-auto/five-off-oil');
  const img = page.locator('.deal-art img');
  await expect(img).toBeVisible();
  // The picture actually drawn inside the <img> box by object-fit: contain.
  const drawn = await img.evaluate((el: HTMLImageElement) => {
    const box = el.getBoundingClientRect();
    const scale = Math.min(box.width / el.naturalWidth, box.height / el.naturalHeight);
    return { fit: getComputedStyle(el).objectFit, w: el.naturalWidth * scale, h: el.naturalHeight * scale, boxH: box.height };
  });
  const frame = await page.locator('.deal-art .mf').boundingBox();
  // Height limited so the page is not a wall of flyer, but the whole flyer
  // (9:16, fine print at the very bottom) is drawn inside the frame, unstretched.
  expect(drawn.fit).toBe('contain');
  expect(drawn.h).toBeLessThanOrEqual(frame!.height + 1);
  expect(drawn.w / drawn.h).toBeCloseTo(9 / 16, 2);
});

test('cards keep their shape: every card image band is the same height in a row', async ({ page, context, baseURL }) => {
  await chooseTown(context, 'all', baseURL!);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const heights = await page.locator('.biz-band').evaluateAll((bands) =>
    [...new Set(bands.map((b) => Math.round(b.getBoundingClientRect().height)))]);
  expect(heights).toHaveLength(1);
});

test('controls are big enough to tap', async ({ page, context, baseURL }) => {
  await chooseTown(context, 'carrollton', baseURL!);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/', '/b/crossroads-pizza', '/b/crossroads-pizza/ten-off-large', '/deals']) {
    await page.goto(path);
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('button, .btn, .chip, .nav-list a, .town-choice, input:not([type=hidden]), select'))
        .filter((el) => el.offsetParent !== null && !el.closest('.hp-field'))
        .map((el) => ({ el: el.textContent?.trim().slice(0, 30) || el.getAttribute('aria-label') || el.tagName, r: el.getBoundingClientRect() }))
        // WCAG 2.2 AA asks for 24px; these aim higher and are checked at 36.
        .filter(({ r }) => r.height < 36 || r.width < 36)
        .map(({ el, r }) => `${el} ${Math.round(r.width)}×${Math.round(r.height)}`));
    expect(small, path).toEqual([]);
  }
});
