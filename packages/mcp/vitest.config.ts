/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // parquet-wasm is dynamically imported by @ifc-lite/export and never
      // exercised in MCP unit tests; alias to a no-op so Vite can resolve.
      'parquet-wasm': '/dev/null',
    },
  },
});
