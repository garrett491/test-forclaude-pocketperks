import { defineConfig } from 'vitest/config';

// Unit tests for the pure logic in src/lib. The browser suite lives in
// tests/e2e and runs through Playwright instead.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    env: {
      PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      PUBLIC_SITE_URL: 'https://yourpocketperks.com',
    },
  },
});
