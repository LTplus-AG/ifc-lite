/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { defineConfig } from '@playwright/test';

// Isolated shader witness: no shared preview, IFC fixture, WASM build or GPU
// acceptance waiver. Use a full Chrome/Chromium binary, not headless-shell.
export default defineConfig({
  testDir: '.',
  testMatch: process.env.DEPTH_WITNESS_VIEWER === '1'
    ? /(?:ortho-depth-nudge|reporter-6729)\.e2e\.spec\.ts/
    : /(?:projection-depth|projection-texture|selection-mask-depth)\.e2e\.spec\.ts/,
  timeout: 180_000, workers: 1, fullyParallel: false, retries: 0,
  outputDir: '../../test-results/projection-depth',
  reporter: [['list'], ['json', { outputFile: '../../test-results/projection-depth-results.json' }]],
  use: {
    channel: process.env.DEPTH_WITNESS_CHROME ? undefined : 'chrome', headless: true,
    viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, locale: 'en-US',
    launchOptions: {
      executablePath: process.env.DEPTH_WITNESS_CHROME,
      args: process.env.DEPTH_WITNESS_GPU === 'native'
        ? ['--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-gpu']
        : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
          '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu'],
    },
  },
});
