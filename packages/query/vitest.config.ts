/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@ifc-lite/data': path.resolve(__dirname, '../data/src/index.ts'),
      '@ifc-lite/parser': path.resolve(__dirname, '../parser/src/index.ts'),
      '@ifc-lite/spatial': path.resolve(__dirname, '../spatial/src/index.ts'),
      '@ifc-lite/geometry': path.resolve(__dirname, '../geometry/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
  },
});
