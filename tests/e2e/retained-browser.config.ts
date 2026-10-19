// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'retained-browser.e2e.spec.ts',
  timeout: 240_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  outputDir: '../../test-results/retained-browser',
  reporter: [['list']],
  use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
