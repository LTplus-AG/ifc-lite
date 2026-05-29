import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/benchmark',
  timeout: 180000, // 3 min for large files
  workers: 1, // Single worker for accurate benchmarks (no resource contention)
  fullyParallel: false, // Sequential execution for consistent timing
  projects: [
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
        command: 'pnpm --filter viewer exec vite preview --port 3000',
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
        command: 'pnpm --filter viewer exec vite preview --port 3000',
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
        command: 'pnpm --filter viewer dev --port 3000',
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
