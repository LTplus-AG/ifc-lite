/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `test` for real-GPU specs that must also run where Playwright cannot
 * launch the GPU browser itself. With `IFC_GPU_CDP_URL` set (the PC fleet
 * host: `ifc-gpu-check` starts Windows Chrome on the RTX GPU, because WSL
 * Chrome only gets SwiftShader), the worker attaches to that browser over
 * CDP and every test gets a fresh context in it, with the config's `use`
 * options (viewport, hasTouch). Without it this is plain `@playwright/test`.
 *
 * Over CDP the browser is not co-located with Playwright, so `setInputFiles`
 * sends file bytes (Linux paths work, 50 MB total per call) and the dev
 * server's 127.0.0.1 is reachable through WSL's mirrored networking.
 */

import { test as base, type Browser } from '@playwright/test';

export { expect } from '@playwright/test';

export interface GpuAdapterReport {
  vendor: string; architecture: string; device: string; description: string; fallback: boolean;
}

/** Software adapters (SwiftShader, fallback) are not GPU evidence. */
export function isSoftwareAdapter(adapter: GpuAdapterReport | null): boolean {
  if (!adapter) return true;
  const text = `${adapter.vendor} ${adapter.architecture} ${adapter.device} ${adapter.description}`.toLowerCase();
  return adapter.fallback || text.includes('swiftshader');
}

/** The attached browser's WebGPU adapter, from a secure (`*.localhost`) page served by Playwright itself. */
async function adapterOf(browser: Browser): Promise<GpuAdapterReport | null> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const url = 'http://ifc-gpu-adapter.localhost/';
    await page.route(url, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>adapter</title>' }));
    await page.goto(url);
    return await page.evaluate(async () => {
      type Info = { vendor?: string; architecture?: string; device?: string; description?: string; isFallbackAdapter?: boolean };
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<{ info?: Info; isFallbackAdapter?: boolean } | null> } }).gpu;
      const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const info = adapter.info ?? {};
      return { vendor: info.vendor ?? '', architecture: info.architecture ?? '', device: info.device ?? '',
        description: info.description ?? '', fallback: Boolean(info.isFallbackAdapter ?? adapter.isFallbackAdapter) };
    });
  } finally {
    await context.close();
  }
}

const cdpUrl = process.env.IFC_GPU_CDP_URL;

export const test: typeof base = cdpUrl
  ? base.extend<object, { browser: Browser }>({
    browser: [async ({ playwright }, use) => {
      const browser = await playwright.chromium.connectOverCDP(cdpUrl);
      const adapter = await adapterOf(browser);
      // Marked line: on the PC fleet host only stdout comes back.
      console.log(`IFC_GPU_ADAPTER ${JSON.stringify({ cdp: true, version: browser.version(), adapter })}`);
      if (isSoftwareAdapter(adapter)) {
        await browser.close();
        throw new Error(`IFC_GPU_CDP_URL browser has no hardware WebGPU adapter: ${JSON.stringify(adapter)}`);
      }
      await use(browser);
      await browser.close();
    }, { scope: 'worker' }],
  }) as unknown as typeof base
  : base;
