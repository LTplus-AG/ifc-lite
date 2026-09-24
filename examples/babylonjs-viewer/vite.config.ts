/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vite';

export default defineConfig({
  // The @ifc-lite geometry worker pool ships ES-module workers; emit them as
  // ESM so a production build never trips over Rollup's IIFE worker default.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Only the wasm package stays out of pre-bundling (its .wasm is loaded via
    // import.meta.url). Excluding parser/geometry/data as well would also skip
    // their CommonJS deps (the parser's jszip), which then fail to import in
    // dev with "does not provide an export named 'default'".
    exclude: ['@ifc-lite/wasm'],
  },
  server: {
    headers: {
      // Cross-origin isolation enables SharedArrayBuffer, which the geometry
      // worker pool uses to share the IFC file bytes across workers (each
      // worker runs its own single-threaded WASM instance — not in-WASM threads).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
