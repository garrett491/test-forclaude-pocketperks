import type { Page, BrowserContext } from '@playwright/test';
import { execSync } from 'node:child_process';

export const SUPABASE = 'http://127.0.0.1:54321';

/** Simulate a paused or unreachable Supabase project. */
export async function outage(on: boolean) {
  await fetch(`${SUPABASE}/__control/outage?on=${on ? 1 : 0}`);
}

export async function chooseTown(context: BrowserContext, slug: string, baseURL: string) {
  await context.addCookies([{ name: 'pp_town', value: slug, url: baseURL }]);
}

/** Scrolls the whole page so every lazy image loads. */
export async function loadEverything(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle');
}

/** Collects script errors and CSP violations for the lifetime of a page. */
export function watchConsole(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(m.text());
  });
  return problems;
}

/**
 * Rebuilds the test database from the migrations and fixtures. Each spec
 * file starts from the same known state, so the admin tests (which change
 * data on purpose) can never make another file's results depend on order.
 */
export async function resetDatabase() {
  execSync('bash tests/support/reset-db.sh', { stdio: 'ignore' });
  await fetch(`${SUPABASE}/__control/outage?on=0`);
  await fetch(`${SUPABASE}/__control/reload`);
}
