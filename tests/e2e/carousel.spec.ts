import { test, expect, type Page } from '@playwright/test';
import { chooseTown, resetDatabase } from './helpers';

test.beforeAll(async () => { await resetDatabase(); });

/** How far the strip has moved, in pixels. */
const offset = (page: Page) =>
  page.locator('[data-carousel-track]').evaluate((el) => {
    const m = getComputedStyle(el).transform;
    return m === 'none' ? 0 : -new DOMMatrixReadOnly(m).m41;
  });

test.beforeEach(async ({ context, baseURL }) => {
  // Carrollton has two featured businesses; a phone screen shows one and a
  // bit, so the strip has something to move through.
  await chooseTown(context, 'carrollton', baseURL!);
});

test('drifts on its own, smoothly and continuously', async ({ page }) => {
  await page.goto('/');
  const carousel = page.locator('[data-carousel]');
  await carousel.scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: 'Pause slideshow' })).toBeVisible();

  // Sample the position over two seconds: it must keep moving forward.
  const samples: number[] = [];
  for (let i = 0; i < 8; i++) {
    samples.push(await offset(page));
    await page.waitForTimeout(250);
  }
  const steps = samples.slice(1).map((v, i) => v - samples[i]!);
  // Every step moves forward — no stalls, and no jump back to the start.
  // (A wrap subtracts a whole loop, which would show as a large negative.)
  for (const step of steps) expect(step).toBeGreaterThan(-5);
  expect(samples.at(-1)! - samples[0]!).toBeGreaterThan(10);
});

test('pause stops it, shows arrows, and resume carries on', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-carousel]').scrollIntoViewIfNeeded();
  const pause = page.getByRole('button', { name: 'Pause slideshow' });
  await expect(page.getByRole('button', { name: 'Next business' })).toBeHidden();

  await pause.click();
  await expect(page.getByRole('button', { name: 'Resume slideshow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next business' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Previous business' })).toBeVisible();

  await page.waitForTimeout(500); // let the settle animation finish
  const stopped = await offset(page);
  await page.waitForTimeout(800);
  expect(Math.abs((await offset(page)) - stopped)).toBeLessThan(1);

  // Next moves exactly one business along; Previous comes back.
  await page.getByRole('button', { name: 'Next business' }).click();
  await page.waitForTimeout(600);
  const afterNext = await offset(page);
  expect(afterNext).not.toBeCloseTo(stopped, 0);
  await page.getByRole('button', { name: 'Previous business' }).click();
  await page.waitForTimeout(600);
  expect(Math.abs((await offset(page)) - stopped)).toBeLessThan(2);

  await page.getByRole('button', { name: 'Resume slideshow' }).click();
  await expect(page.getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next business' })).toBeHidden();
  const resumed = await offset(page);
  await page.waitForTimeout(800);
  expect(await offset(page)).toBeGreaterThan(resumed);
});

test('Previous from the very first business wraps smoothly to the last', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-carousel]').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Pause slideshow' }).click();
  await page.waitForTimeout(600);
  // Walk back past the start several times: it must never get stuck or
  // show an empty strip.
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Previous business' }).click();
    await page.waitForTimeout(500);
    const box = await page.locator('[data-carousel-viewport]').boundingBox();
    const visible = await page.locator('[data-slide]').evaluateAll((slides, vb) =>
      slides.filter((s) => {
        const r = s.getBoundingClientRect();
        return r.right > vb!.x && r.left < vb!.x + vb!.width;
      }).length, box);
    expect(visible).toBeGreaterThan(0);
  }
});

test('every slide is a working link while it moves', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-carousel]').scrollIntoViewIfNeeded();
  // Tap by position, the way a finger does: the slide is moving, so it is
  // never "still" long enough for a synthetic click to wait on it.
  const viewport = (await page.locator('[data-carousel-viewport]').boundingBox())!;
  const x = viewport.x + viewport.width * 0.3;
  const y = viewport.y + viewport.height * 0.4;
  const href = await page.evaluate(([px, py]) =>
    document.elementFromPoint(px!, py!)?.closest('a')?.getAttribute('href'), [x, y]);
  expect(href).toMatch(/^\/b\//);
  await page.mouse.click(x, y);
  await expect(page).toHaveURL(new RegExp(`${href}$`));
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('a sideways swipe moves the strip and never opens a business', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-carousel]').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Pause slideshow' }).click();
  await page.waitForTimeout(500);
  const before = await offset(page);
  const box = (await page.locator('[data-carousel-viewport]').boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.8, y);
  await page.mouse.down();
  for (let x = 0.8; x >= 0.2; x -= 0.05) await page.mouse.move(box.x + box.width * x, y);
  await page.mouse.up();
  await page.waitForTimeout(600);
  await expect(page).toHaveURL(/\/$/);
  expect(await offset(page)).not.toBeCloseTo(before, 0);
});

test('copies used for looping are hidden from keyboards and screen readers', async ({ page }) => {
  await page.goto('/');
  const originals = await page.locator('[data-slide]:not([inert])').count();
  const clones = await page.locator('[data-slide][inert][aria-hidden="true"]').count();
  expect(originals).toBe(2);
  expect(clones).toBeGreaterThan(0);
  // Only the original slides are in the tab order.
  const focusable = await page.locator('[data-slide]:not([inert]) a').count();
  expect(focusable).toBe(originals);
});

test.describe('with reduced motion requested', () => {
  test.use({ reducedMotion: 'reduce' });

  test('stays still, with arrows instead of a pause button', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-carousel]').scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: /slideshow/ })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Next business' })).toBeVisible();
    const start = await offset(page);
    await page.waitForTimeout(1200);
    expect(await offset(page)).toBe(start);
    await page.getByRole('button', { name: 'Next business' }).click();
    // On touch devices the click lands a tick after Playwright returns.
    await expect.poll(() => offset(page)).toBeGreaterThan(start);
  });
});

test('the slideshow keeps the same height whatever shape each image is', async ({ page }) => {
  await page.goto('/');
  const heights = await page.locator('[data-slide]').evaluateAll((slides) =>
    [...new Set(slides.map((s) => Math.round(s.getBoundingClientRect().height)))]);
  expect(heights).toHaveLength(1);
});
