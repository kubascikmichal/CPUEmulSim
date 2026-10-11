import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:8080',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
  },
  outputDir: 'e2e/.results',
});
