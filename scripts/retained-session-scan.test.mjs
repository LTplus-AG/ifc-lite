// SPDX-License-Identifier: MPL-2.0
// Actual WASM session witness, opt-in to avoid compiling WASM in the generic Node lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('retained session publishes without rescanning finishes (#8415)', {
  skip: process.env.IFC_LITE_RETAINED_SESSION_SCAN !== '1' && 'run in the retained WASM/oracle lane',
  timeout: 600_000,
}, () => {
  const run = spawnSync(process.execPath, ['scripts/retained-browser-runtime-tests.mjs',
    'retained_browser_smlib_free_session_finish_scan', '--nocapture'], {
    encoding: 'utf8', timeout: 590_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /test result: ok\. 1 passed/);
});
