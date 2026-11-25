import { defineConfig } from '@playwright/test';

const url = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 45_000 },
  use: { baseURL: url, channel: process.env.HIYORI_TEST_BROWSER, trace: 'retain-on-failure' },
  globalSetup: './tests/e2e/start-release.ts',
  outputDir: '.cache/playwright',
});
