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
      // Same reason, for the type-compatibility test that pins the commit
      // shapes against the real engine's (`commit-diff-shape.test.ts`).
      '@ifc-lite/diff': path.resolve(__dirname, '../diff/src/index.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // `commit-diff-shape.test.ts` is mostly `expectTypeOf`, which is erased at
    // runtime — see `packages/plugin-api/vitest.config.ts` for what happens
    // when type assertions are allowed to "pass" without ever being checked.
    typecheck: {
      enabled: true,
      include: ['test/commit-diff-shape.test.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
});
