/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { defineConfig } from '@playwright/test';

// Opt-in #10264 hardware acceptance on public fixtures: S1 GPU batch picking
// against the CPU raycast, S2 GPU hide/isolate against the frame of the
// visible pieces alone (gpu-entity-visibility.e2e.spec.ts), and S3 highlight
// from the batches against the copies route (gpu-entity-highlight.e2e.spec.ts). It serves its own viewer dev server. Run it on a
// real WebGPU adapter; SwiftShader is not acceptance evidence, and the spec
// records the adapter it ran on. On Pop (hybrid NVIDIA laptop) headless
// Chrome loses the device when the canvas presents, so run a full Chromium
// headed on a private Xvfb (GPU_PICK_HEADED=1, GPU_PICK_CHROME=<chrome>) under
// ~/build-workers/ifc-gpu-check, as scripts/perf/retained-qual-browser.mjs does.
const HARDWARE_ARGS = ['--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan', '--use-angle=vulkan', '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist', '--enable-gpu', '--use-webgpu-power-preference=default-high-performance'];

export default defineConfig({
  testDir: '.',
  testMatch: /gpu-(batch-pick|entity-visibility|entity-highlight)\.e2e\.spec\.ts/,
  timeout: 600_000, workers: 1, fullyParallel: false, retries: 0,
  outputDir: '../../test-results/gpu-batch-pick',
  reporter: [['list'], ['json', { outputFile: '../../test-results/gpu-batch-pick-results.json' }]],
  use: {
    channel: process.env.GPU_PICK_CHROME ? undefined : 'chrome', headless: process.env.GPU_PICK_HEADED !== '1',
    viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'en-US',
    launchOptions: { executablePath: process.env.GPU_PICK_CHROME, args: [...HARDWARE_ARGS, '--no-sandbox', '--disable-dev-shm-usage'] },
  },
});
