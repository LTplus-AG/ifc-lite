/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Real-browser, real-build E2E for the laz-perf wasm loading path (#2097).
 *
 * Nothing else exercises this end to end: `laz-source.test.ts` drives
 * `LazStreamingSource` through `setLazPerfLoaderForTesting`, which replaces
 * `importLazPerf` wholesale, so the two mechanisms that actually make LAZ
 * work in a browser never run:
 *
 *   1. `import('laz-perf/lib/web/laz-perf.wasm?url')` — Vite's asset
 *      pipeline resolving the wasm to a hashed, `application/wasm` URL.
 *   2. `factory({ wasmBinary })` — handing the pre-fetched bytes to
 *      emscripten so its own (broken-under-Vite) `locateFile` fetch is
 *      skipped.
 *
 * If either breaks, every unit/vitest suite stays green (see AGENTS.md
 * §Geometry & WASM and the issue) while every LAZ open fails in a real
 * browser. vitest can't catch it either: `?url` resolves there too, but to
 * the dev-server `/@fs/...` form, which `fetch` cannot consume under Node
 * and which is not the production `/assets/...` form anyway — a green
 * vitest test would assert the wrong pipeline (see issue #2097 comments for
 * the measured trap).
 *
 * This test reads `window.__LAZ_PROBE__` off `laz-probe.html`
 * (apps/viewer/src/e2e/laz-wasm-probe-entry.ts), a small page — not linked
 * from the app UI — added to the real `vite build` input list solely so a
 * production build exercises `probeLazPerfWasmLoad()`. That function calls
 * the real `importLazPerf()` (bypassing the `setLazPerfLoaderForTesting`
 * seam) and reports whether a real `LASZip` constructor came back.
 *
 * WHAT THIS DOES NOT COVER: decoding actual LAZ-compressed point data.
 * There is no `.laz` fixture in `tests/models/manifest.json`, and one can't
 * be synthesized in-repo: `laz-perf@0.0.7` is decode-only (`LASZip`,
 * `ChunkDecoder`; no writer/compressor). Reaching a real `LASZip`
 * constructor proves both wasm-loading mechanisms above already worked
 * (emscripten only hands back a working module if instantiation
 * succeeded), independent of decoding any actual points — but the decode
 * step itself (`laszip.open()` on real compressed bytes) is unasserted
 * anywhere in this repo.
 */

import { test, expect } from '@playwright/test';

test.describe('laz-perf wasm loading path (real build, real browser)', () => {
  test('the ?url wasm asset resolves and the wasmBinary hand-off succeeds', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto('/laz-probe.html');
    const handle = await page.waitForFunction(
      () => (window as { __LAZ_PROBE__?: unknown }).__LAZ_PROBE__,
      undefined,
      { timeout: 60000 },
    );
    const result = (await handle.jsonValue()) as
      | { ok: true; hasLASZip: boolean }
      | { ok: false; error: string };

    expect(consoleErrors, `uncaught page errors: ${consoleErrors.join('; ')}`).toEqual([]);
    expect(result.ok, `laz-perf wasm failed to load: ${result.ok ? '' : result.error}`).toBe(true);
    if (result.ok) {
      expect(result.hasLASZip).toBe(true);
    }
  });
});
