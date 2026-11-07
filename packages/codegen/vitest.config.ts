/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    reporters: [
      'default',
      ...(process.env.GITHUB_ACTIONS === 'true' ? ['github-actions'] : []),
      '@mergifyio/vitest',
    ],
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['dist/**', 'generated/**', 'test/**'],
    },
  },
});
