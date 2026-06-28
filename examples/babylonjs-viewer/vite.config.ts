/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vite';
import { threadedWasmAliasTarget } from '../../packages/wasm/threaded-alias.mjs';

export default defineConfig({
  resolve: {
    alias: {
      // The geometry worker dynamic-imports the optional `@ifc-lite/wasm/threaded`
      // subpath; resolve it to the built threaded bundle or a stub so the build
      // succeeds whether or not BUILD_THREADED produced it.
      '@ifc-lite/wasm/threaded': threadedWasmAliasTarget,
    },
  },
  // The @ifc-lite geometry worker pool ships ES-module workers; emit them as
  // ESM so a production build never trips over Rollup's IIFE worker default.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@ifc-lite/wasm', '@ifc-lite/geometry', '@ifc-lite/parser', '@ifc-lite/data'],
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
