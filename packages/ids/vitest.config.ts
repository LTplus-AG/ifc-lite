/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const BUILT_SIBLING = new RegExp(
  `^${repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}packages/[^/]+/(dist|pkg)/`,
);

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    server: { deps: { external: [BUILT_SIBLING] } },
  },
});
