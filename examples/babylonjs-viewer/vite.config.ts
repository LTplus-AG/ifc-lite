/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vite';

export default defineConfig({
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
