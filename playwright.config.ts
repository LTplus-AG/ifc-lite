import { defineConfig, devices } from '@playwright/test';

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
    command: 'pnpm --filter @ifc-lite/viewer exec vite preview --port 3000',
    port: 3000,
    reuseExistingServer: true,
    timeout: 90000,
    env: {
      BROWSER: 'none',
    },
  },
  projects: [
    {
      name: 'viewer-e2e',
      testMatch: /viewer-smoke\.e2e\.spec\.ts/,
      timeout: 240000,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3000',
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
      testMatch: /viewer-smoke\.e2e\.spec\.ts/,
      timeout: 240000,
      use: {
        baseURL: 'http://localhost:3000',
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
      name: 'browser-benchmark',
      testMatch: /benchmark\.spec\.ts/,
      webServer: {
        command: 'npx serve . -p 3333',
        port: 3333,
        reuseExistingServer: true,
        timeout: 30000,
      },
      use: {
        baseURL: 'http://localhost:3333',
      },
    },
    {
      name: 'viewer-benchmark',
      testMatch: /viewer-benchmark\.spec\.ts/,
      timeout: 600000, // 10 min for very large files (327MB)
      webServer: {
        command: 'pnpm --filter @ifc-lite/viewer exec vite preview --port 3000',
        port: 3000,
        reuseExistingServer: true,
        timeout: 60000,
        env: {
          BROWSER: 'none',
        },
      },
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3000',
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
        command: 'pnpm --filter @ifc-lite/viewer exec vite preview --port 3000',
        port: 3000,
        reuseExistingServer: true,
        timeout: 60000,
        env: {
          BROWSER: 'none',
        },
      },
      use: {
        baseURL: 'http://localhost:3000',
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
    {
      name: 'holter-debug',
      testMatch: /holter-tower-debug\.spec\.ts/,
      timeout: 600000, // 10 min for large file
      webServer: {
        command: 'pnpm --filter @ifc-lite/viewer dev --port 3000',
        port: 3000,
        reuseExistingServer: true,
        timeout: 60000,
        env: {
          BROWSER: 'none',
        },
      },
      use: {
        ...devices['Desktop Chrome'],
        baseURL: 'http://localhost:3000',
        actionTimeout: 300000,
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
  ],
});
