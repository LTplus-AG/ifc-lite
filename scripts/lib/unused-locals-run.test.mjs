/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { assertCompleteTscRun } from './unused-locals-run.mjs';

for (const status of [0, 2, 1, 134, 137]) {
  test(`#8981: compiler outcome ${status} retains diagnostics and rejects incomplete census`, () => {
    const run = spawnSync(process.execPath, ['-e', `
      console.log("src/a.ts(1,1): error TS6133: unused");
      console.error("compiler stderr sentinel");
      process.exit(${status});
    `], { encoding: 'utf8' });
    if (status === 0 || status === 2) assert.doesNotThrow(() => assertCompleteTscRun(run));
    else assert.throws(() => assertCompleteTscRun(run), (error) => {
      assert.match(error.message, new RegExp(`status=${status}`));
      assert.match(error.message, /TS6133: unused/);
      assert.match(error.message, /compiler stderr sentinel/);
      return true;
    });
  });
}

test('#8981: truncated output cannot pass as a completed census', () => {
  const run = spawnSync(process.execPath, ['-e', 'console.log("x".repeat(100000))'],
    { encoding: 'utf8', maxBuffer: 128 });
  assert.throws(() => assertCompleteTscRun(run), /ENOBUFS/);
});
