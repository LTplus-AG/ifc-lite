/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // `@ifc-lite/plugin-api`'s package export targets `dist/index.js`,
    // which only exists after `pnpm build` — alias straight to the source
    // entrypoint so `vitest run` works on a clean checkout too, matching
    // the pattern other packages (e.g. `packages/bcf`) already use.
    alias: {
      '@ifc-lite/plugin-api': path.resolve(__dirname, '../plugin-api/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
