/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { defineConfig } from '@playwright/test';

// Manual hosted functional evidence only. Private source server is owned by
// the spec; never borrow another checkout's preview or run the default suite.
export default defineConfig({
  testDir: '.', testMatch: 'reporter-6729.e2e.spec.ts',
  timeout: 300_000, workers: 1, fullyParallel: false, retries: 0,
  outputDir: '../../test-results/reporter-6729',
  reporter: [['list'], ['json', { outputFile: '../../test-results/reporter-6729-results.json' }]],
  use: {
    channel: 'chrome', headless: true, viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1, locale: 'en-US', actionTimeout: 30_000,
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: { args: [
      '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
      '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
    ] },
  },
});
