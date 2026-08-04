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
      '@ifc-lite/embed-protocol': path.resolve(__dirname, '../embed-protocol/src/index.ts'),
    },
  },
  test: {
    environment: 'happy-dom',
    // The SDK points the iframe at a real https origin; without this happy-dom
    // would try to fetch it over the network and the suite would be flaky/offline-broken.
    environmentOptions: {
      happyDOM: { settings: { navigation: { disableChildFrameNavigation: true } } },
    },
    globals: true,
  },
});
