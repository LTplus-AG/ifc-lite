/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Deliberately NOT raising testTimeout. See vitest.setup.ts: the cold
    // dynamic imports are warmed out of every test's budget instead, so the
    // default 5000ms still catches a genuine hang in 5s.
    setupFiles: ['./vitest.setup.ts'],
  },
});
