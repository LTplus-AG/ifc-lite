/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // testTimeout stays at the 5000ms default on purpose; see vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
  },
});
