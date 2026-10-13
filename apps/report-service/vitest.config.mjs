/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // #7495: suites migrate the shared integration database. Serialize files
    // so DDL cannot overlap another suite's live upload transactions. Race
    // tests retain their explicit concurrent operations within each test.
    fileParallelism: false,
  },
});
