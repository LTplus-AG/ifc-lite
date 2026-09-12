/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig, devices } from '@playwright/test';

// One preview server per run. Every project shares it; `reuseExistingServer`
// means a server another checkout already runs on the port would be tested
// instead, so a host with several checkouts sets PLAYWRIGHT_PORT per run.
const PORT = process.env.PLAYWRIGHT_PORT ?? '3000';
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  // Covers tests/benchmark (perf) and tests/e2e (functional smoke);
  // each project scopes its own files via testMatch.
  testDir: './tests',
  timeout: 180000, // 3 min for large files
  workers: 1, // Single worker for accurate benchmarks (no resource contention)
  fullyParallel: false, // Sequential execution for consistent timing
  // NOTE: webServer is only honored at the TOP level — the per-project
  // webServer blocks on the benchmark projects below are silently
  // ignored by Playwright (latent: those projects are run manually
  // against an already-running server). The e2e projects rely on this
  // one; reuseExistingServer keeps local dev-server workflows working.
  webServer: {
    command: `pnpm --filter @ifc-lite/viewer exec vite preview --port ${PORT}`,
    port: Number(PORT),
    reuseExistingServer: true,
    timeout: 90000,
    env: {
      BROWSER: 'none',
    },
  },
  projects: [
    {
      name: 'viewer-e2e',
      testMatch: /(viewer-smoke|usd-export|laz-wasm|model-reposition)\.e2e\.spec\.ts/,
      timeout: 240000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
        actionTimeout: 60000,
        headless: false,
        channel: 'chrome',
        launchOptions: {
          args: [
            '--enable-gpu',
            '--enable-webgpu',
            '--enable-unsafe-webgpu',
            '--use-angle=default',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
    {
      name: 'viewer-e2e-ci',
      testMatch: /(viewer-smoke|usd-export|laz-wasm|model-reposition)\.e2e\.spec\.ts/,
      timeout: 240000,
      use: {
        baseURL: BASE_URL,
        actionTimeout: 60000,
        headless: true,
        // Real Chrome, not Playwright's headless shell — the shell's
        // WebGPU device is broken under software rendering (createBuffer
        // fails for KB-sized buffers, popErrorScope instance drops).
        // GitHub-hosted runners have Chrome preinstalled. WebGPU over
        // SwiftShader needs the Vulkan flag set below.
        channel: 'chrome',
        launchOptions: {
          args: [
            '--enable-unsafe-webgpu',
            '--enable-features=Vulkan',
            '--use-vulkan=swiftshader',
            '--disable-vulkan-surface',
            '--ignore-gpu-blocklist',
            '--enable-gpu',
          ],
        },
      },
    },
    {
      // Opt-in browser acceptance for appearance authoring (#4404 face masks):
      // real wasm planner + WebGPU renderer on a real GPU. Not in CI's default
      // lane; the spec skips unless APPEARANCE_E2E=1. Real Chrome like the
      // other viewer projects, so no Playwright browser download is needed.
      name: 'viewer-appearance-e2e',
      testMatch: /appearance-face-mask\.e2e\.spec\.ts/,
      timeout: 600000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
        actionTimeout: 60000,
        headless: true,
        channel: 'chrome',
        launchOptions: {
          args: [
            '--enable-gpu',
            '--enable-webgpu',
            '--enable-unsafe-webgpu',
            '--use-angle=default',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
    {
      // Opt-in relay acceptance (#4446, #4444): needs the built viewer, a built
      // @ifc-lite/collab-server and the AC20 fixture. Each spec spawns its own
      // signed relay AND its own `vite preview` of this checkout's dist, both
      // on ephemeral ports (the shared webServer above, PLAYWRIGHT_PORT / :3000,
      // is reused from whatever process holds it — a sibling checkout's preview
      // would test the wrong build — so this project sets no baseURL), and enables collab
      // through the viewer's localStorage overrides. Real Google Chrome
      // (`channel: 'chrome'`) is required for WebGPU. Not in CI's default lanes
      // (no relay there) — `pnpm test:e2e:collab`, see
      // docs/contributing/collaboration-testing.md.
      name: 'viewer-collab-e2e',
      testMatch: /collab-(share-seed|federation-scope)\.e2e\.spec\.ts/,
      timeout: 600000,
      use: {
        actionTimeout: 60000,
        headless: true,
        channel: 'chrome',
        launchOptions: {
          args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu'],
        },
      },
    },
    {
      name: 'viewer-benchmark',
      testMatch: /viewer-benchmark\.spec\.ts/,
      timeout: 600000, // 10 min for very large files (327MB)
      webServer: {
        command: `pnpm --filter @ifc-lite/viewer exec vite preview --port ${PORT}`,
        port: Number(PORT),
        reuseExistingServer: true,
        timeout: 60000,
        env: {
          BROWSER: 'none',
        },
      },
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
        actionTimeout: 300000,
        // Run headed for realistic GPU/WebGPU performance
        headless: false,
        // Use real Chrome channel for accurate benchmarks
        channel: 'chrome',
        // Enable GPU for WebGPU
        launchOptions: {
          args: [
            '--enable-gpu',
            '--enable-webgpu',
            '--enable-unsafe-webgpu',
            '--use-angle=default',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
    {
      name: 'viewer-benchmark-ci',
      testMatch: /viewer-benchmark\.spec\.ts/,
      timeout: 600000,
      webServer: {
        command: `pnpm --filter @ifc-lite/viewer exec vite preview --port ${PORT}`,
        port: Number(PORT),
        reuseExistingServer: true,
        timeout: 60000,
        env: {
          BROWSER: 'none',
        },
      },
      use: {
        baseURL: BASE_URL,
        actionTimeout: 300000,
        // CI mode: headless but with GPU flags
        headless: true,
        // Real Chrome (preinstalled on the runner), not Playwright's bundled
        // headless shell — the shell's WebGPU device is broken under software
        // rendering (same reason the E2E CI project pins channel: 'chrome').
        channel: 'chrome',
        launchOptions: {
          args: [
            '--enable-gpu',
            '--enable-webgpu',
            '--enable-unsafe-webgpu',
            '--use-angle=swiftshader', // Software rendering for CI
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
  ],
});
