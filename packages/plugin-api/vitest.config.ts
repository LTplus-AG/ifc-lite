/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // `types.test.ts` is entirely `expectTypeOf`, which is erased at runtime —
    // without this the file "passes" no matter what it asserts. That is not
    // hypothetical: it asserted a `checkRevisions` member the v2 contract had
    // already renamed to `watchRevisions`, and nothing caught it, because the
    // package tsconfig only included `src/**/*` so the test was never
    // type-checked either. Running the type assertions makes a contract drift
    // fail here instead of shipping.
    typecheck: {
      enabled: true,
      include: ['test/**/*.test.ts'],
      tsconfig: './tsconfig.test.json',
    },
  },
});
