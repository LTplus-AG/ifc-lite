/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { defineConfig } from '@playwright/test';

// Opt-in #10264 S1 hardware acceptance: GPU batch picking against the CPU
// raycast on public fixtures. It serves its own viewer dev server. Run it on a
// real WebGPU adapter (e.g. under ~/build-workers/ifc-gpu-check on Pop, with
// GPU_PICK_CHROME pointing at a chrome-headless-shell); SwiftShader is not
// acceptance evidence, and the spec records the adapter it ran on.
const gpuArgs = (process.env.IFC_GPU_CHROME_ARGS ?? '--enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan --use-angle=vulkan')
  .split(/\s+/).filter(Boolean);

export default defineConfig({
  testDir: '.',
  testMatch: /gpu-batch-pick\.e2e\.spec\.ts/,
  timeout: 600_000, workers: 1, fullyParallel: false, retries: 0,
  outputDir: '../../test-results/gpu-batch-pick',
  reporter: [['list'], ['json', { outputFile: '../../test-results/gpu-batch-pick-results.json' }]],
  use: {
    channel: process.env.GPU_PICK_CHROME ? undefined : 'chrome', headless: true,
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US',
    launchOptions: {
      executablePath: process.env.GPU_PICK_CHROME,
      // A hybrid laptop's default adapter can be either GPU: pin the discrete one.
      args: [...gpuArgs, '--use-webgpu-power-preference=default-high-performance', '--no-sandbox', '--disable-dev-shm-usage'],
    },
  },
});
