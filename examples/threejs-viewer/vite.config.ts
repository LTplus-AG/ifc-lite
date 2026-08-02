/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // The @ifc-lite geometry worker pool ships ES-module workers. Rollup's
  // default worker format is IIFE, which it refuses to emit for a
  // code-splitting build (multiple entries) — force ESM workers instead.
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        compare: resolve(__dirname, 'compare.html'),
      },
    },
  },
  optimizeDeps: {
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
