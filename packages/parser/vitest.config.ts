/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { defineConfig } from 'vitest/config';

/**
 * `--expose-gc` is required, not optional.
 *
 * `test/source-compression-swap.test.ts` proves the original source buffer
 * becomes collectable after the in-place compression swap (#2183). Without a
 * real `globalThis.gc` that proof is impossible, and the 275 MB this feature
 * exists to save is unverifiable. The test HARD-FAILS when `gc` is missing
 * rather than skipping, so losing the flag turns CI red instead of quietly
 * green -- this config is what keeps it present.
 *
 * Set through `NODE_OPTIONS` on the pool's environment rather than
 * `poolOptions.forks.execArgv`: the latter is the documented spelling but does
 * not reach the forked runner in vitest 4.1 (verified by probing
 * `typeof globalThis.gc` inside a test). If a later vitest fixes that, prefer
 * execArgv and delete this -- but re-run the probe, do not assume.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc`.trim() },
  },
});
