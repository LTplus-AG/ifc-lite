/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The EPSG dataset is a ~4.4 MB generated TypeScript module that vite
    // transforms on first import. Locally that runs in ~3-5s; on CI with a
    // cold cache it routinely exceeds the default 5s test timeout. Bump the
    // window so the cold-path tests don't flake.
    testTimeout: 30_000,
  },
});
