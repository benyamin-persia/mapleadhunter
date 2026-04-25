import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  testMatch: '**/*.test.ts',
  use: {
    headless: true,
    locale: 'en-US',
  },
  timeout: 60_000,
});
