/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

// Scope vitest to the new quantised-pipeline tests. Other `.test.ts` files in
// this package use `node:test` directly and are run by their own CI step;
// running them under vitest would double-count or fail (vitest's globals
// shadow `node:test` imports).
export default defineConfig({
  test: {
    include: ['src/quantized-*.test.ts'],
  },
});
