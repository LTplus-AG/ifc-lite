/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Workspace package exports target `dist/`, which only exists after
    // `pnpm build` — alias to source so `vitest run` works on a clean
    // checkout, matching `packages/source-fixture`'s own config.
    alias: {
      '@ifc-lite/plugin-api': path.resolve(__dirname, '../plugin-api/src/index.ts'),
      '@ifc-lite/oauth-pkce': path.resolve(__dirname, '../oauth-pkce/src/index.ts'),
      '@ifc-lite/source-fixture/conformance': path.resolve(__dirname, '../source-fixture/src/conformance/index.ts'),
      '@ifc-lite/source-fixture': path.resolve(__dirname, '../source-fixture/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
