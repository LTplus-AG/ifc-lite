/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const BUILT_SIBLING = new RegExp(
  `^${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}packages/[^/]+/(dist|pkg)/`,
);

export default defineConfig({
  resolve: {
    alias: {
      '@ifc-lite/embed-protocol': path.resolve(__dirname, '../../packages/embed-protocol/src/index.ts'),
      // Matches vite.config.ts:29 and tsconfig.json:11, which both point this at
      // `src`. Without it the suite resolves through node_modules to
      // packages/geometry/dist, so the tests need a prior build and can run
      // against a stale artefact. `@/lib/type-view-visibility` made this the
      // first runtime dependency the embed tests have on the geometry package.
      '@ifc-lite/geometry': path.resolve(__dirname, '../../packages/geometry/src'),
      '@': path.resolve(__dirname, '../viewer/src'),
    },
  },
  test: {
    // The bridge talks to `window` only; a hand-rolled window stub keeps the
    // postMessage/targetOrigin assertions exact instead of relying on a DOM impl.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    server: { deps: { external: [BUILT_SIBLING] } },
  },
});
