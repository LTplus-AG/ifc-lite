/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real-browser E2E for OpenUSD (.usda) export.
 *
 * Every vitest suite MOCKS the WASM boundary (AGENTS.md §Geometry & WASM), and
 * the Rust tests exercise the exporter in-process — neither proves the compiled
 * `IfcAPI.exportUsd` works once the wasm-bindgen `web` bundle is loaded and run
 * in an actual browser. This does: it serves the real runtime
 * (`packages/wasm/pkg`) and a git-tracked IFC to a headless Chrome page via
 * `page.route`, initialises the wasm, and calls `exportUsd` — the same path the
 * viewer/CLI/MCP consumers take. USD export is pure CPU (no WebGPU), so this is
 * independent of the GPU/SwiftShader caveats the viewer smoke test carries.
 *
 * Self-served through `page.route`, so it needs no extra static server; the
 * shared top-level webServer (the viewer preview) only has to be reachable for
 * the session to start — its content is never used here.
 */

import { test, expect, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WASM_JS = join(ROOT, 'packages/wasm/pkg/ifc-lite.js');
const WASM_BIN = join(ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm');
// Git-tracked (unlike tests/models/*), so this runs on any checkout with a
// built wasm runtime — no `pnpm fixtures` needed.
const SAMPLE_IFC = join(ROOT, 'apps/landing/samples/hello-wall.ifc');

// A minimal page that imports the real wasm ESM, runs exportUsd, and parks the
// decoded stage (or the error) on window for the test to read.
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><title>usd-export</title></head>
<body><script type="module">
  import init, { IfcAPI } from './ifc-lite.js';
  (async () => {
    try {
      await init();
      const api = new IfcAPI();
      const res = await fetch('./hello-wall.ifc');
      const bytes = new Uint8Array(await res.arrayBuffer());
      const out = api.exportUsd(bytes);
      window.__USD__ = new TextDecoder().decode(out);
      window.__USD_LEN__ = out.length;
    } catch (e) {
      window.__USD_ERR__ = String((e && e.stack) || e);
    }
  })();
</script></body></html>`;

/** Serve the harness, the wasm runtime and the sample IFC from disk. */
async function serveRuntime(page: Page): Promise<void> {
  const wasmJs = readFileSync(WASM_JS);
  const wasmBin = readFileSync(WASM_BIN);
  const ifc = readFileSync(SAMPLE_IFC);
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.endsWith('/usd-harness.html')) {
      return route.fulfill({ contentType: 'text/html', body: HARNESS });
    }
    if (url.endsWith('/ifc-lite.js')) {
      return route.fulfill({ contentType: 'text/javascript', body: wasmJs });
    }
    if (url.endsWith('/ifc-lite_bg.wasm')) {
      // application/wasm lets instantiateStreaming take the fast path.
      return route.fulfill({ contentType: 'application/wasm', body: wasmBin });
    }
    if (url.endsWith('/hello-wall.ifc')) {
      return route.fulfill({ contentType: 'application/octet-stream', body: ifc });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
}

test.describe('OpenUSD export (real wasm, real browser)', () => {
  // Skip cleanly when the wasm runtime isn't built (mirrors the wasm-contract
  // script); in CI the build-output artifact provides it.
  test.skip(
    !existsSync(WASM_BIN) || !existsSync(SAMPLE_IFC),
    'wasm runtime or sample IFC missing — build with scripts/build-wasm.sh',
  );

  test('exportUsd produces a valid Z-up USDA stage in the browser', async ({ page }) => {
    await serveRuntime(page);
    await page.goto('http://localhost:3000/usd-harness.html');
    await page.waitForFunction(
      () => '__USD__' in window || '__USD_ERR__' in window,
      undefined,
      { timeout: 60000 },
    );

    const err = await page.evaluate(() => (window as Record<string, unknown>).__USD_ERR__);
    expect(err, `browser exportUsd threw: ${err}`).toBeUndefined();

    const len = (await page.evaluate(
      () => (window as Record<string, unknown>).__USD_LEN__,
    )) as number;
    const usda = (await page.evaluate(
      () => (window as Record<string, unknown>).__USD__,
    )) as string;

    expect(len).toBeGreaterThan(100);
    expect(usda.startsWith('#usda 1.0')).toBe(true);
    expect(usda).toMatch(/upAxis\s*=\s*"Z"/);
    expect(usda).toMatch(/metersPerUnit\s*=\s*1/);
    expect(usda).toContain('def Xform "World"');
    expect(usda).toMatch(/def Mesh "|class Mesh "/);
    expect(usda).toMatch(/point3f\[\] points =/);
    expect(usda).toContain('ifc:class');
    // No non-finite coordinate can reach the stage (a usda parse-breaker).
    expect(/(?<![A-Za-z])(nan|-?inf)(?![A-Za-z])/i.test(usda)).toBe(false);
  });

  test('exportUsd is deterministic across two in-browser calls', async ({ page }) => {
    await serveRuntime(page);
    await page.goto('http://localhost:3000/usd-harness.html');
    await page.waitForFunction(() => '__USD__' in window || '__USD_ERR__' in window, undefined, {
      timeout: 60000,
    });
    const first = (await page.evaluate(() => (window as Record<string, unknown>).__USD__)) as string;
    // Re-run the export in-page against the same bytes (the wasm module is
    // already initialised; a fresh IfcAPI must yield byte-identical output).
    const again = (await page.evaluate(async () => {
      const mod = await import('./ifc-lite.js');
      const api = new mod.IfcAPI();
      const res = await fetch('./hello-wall.ifc');
      const bytes = new Uint8Array(await res.arrayBuffer());
      return new TextDecoder().decode(api.exportUsd(bytes));
    })) as string;
    expect(again).toBe(first);
  });
});
