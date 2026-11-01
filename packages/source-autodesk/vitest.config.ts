/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: [
      'default',
      ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []),
      // #8525: skip native reporting after the Windows post-test abort.
      ...(process.platform !== 'win32' && process.env.MERGIFY_TOKEN
        ? ['@mergifyio/vitest']
        : []),
    ],
    include: ['test/**/*.test.ts'],
  },
});
