/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entry for `laz-probe.html`, an E2E-only page read by
 * `tests/e2e/laz-wasm.e2e.spec.ts` (#2097).
 *
 * Every other test that touches `LazStreamingSource` substitutes the wasm
 * loader (`setLazPerfLoaderForTesting`), so the two mechanisms that make LAZ
 * work in a real browser — the Vite `?url` wasm-asset fetch and the
 * `Module.wasmBinary` hand-off to emscripten — are otherwise never
 * exercised against a real production build. This page is not linked from
 * the app UI; it exists solely so `pnpm --filter @ifc-lite/viewer build`
 * bundles `probeLazPerfWasmLoad()` through the real asset pipeline, and a
 * Playwright test can read the result off `window.__LAZ_PROBE__`.
 */
import { probeLazPerfWasmLoad } from '@ifc-lite/pointcloud';

declare global {
  interface Window {
    __LAZ_PROBE__?: Awaited<ReturnType<typeof probeLazPerfWasmLoad>>;
  }
}

void probeLazPerfWasmLoad().then((result) => {
  window.__LAZ_PROBE__ = result;
});
