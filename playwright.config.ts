import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests: the real production build, served the way Netlify
 * serves it, against the real migrations and RLS policies in a local
 * Postgres. See tests/README.md for how to run them.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1, // one shared database; tests that change it run in order
  retries: 0,
  timeout: 45_000,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:4321',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions: executablePath ? { executablePath } : {} } },
  ],
});
