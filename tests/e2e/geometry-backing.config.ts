/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { defineConfig } from '@playwright/test';

// Live-geometry backing browser proof. The spec owns a private Vite dev
// server, so this config starts no preview build and borrows no port.
const executablePath = process.env.IFCLITE_TEST_CHROME_EXECUTABLE || undefined;
export default defineConfig({
  testDir: '.', testMatch: 'geometry-backing-idb.e2e.spec.ts',
  workers: 1, fullyParallel: false, retries: 0, timeout: 300_000,
  outputDir: '../../test-results/geometry-backing',
  reporter: [['list'], ['json', { outputFile: '../../test-results/geometry-backing-results.json' }]],
  use: {
    headless: true, viewport: { width: 1280, height: 800 },
    ...(executablePath ? {} : { channel: 'chrome' }),
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
        '--use-angle=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu'],
    },
  },
});
