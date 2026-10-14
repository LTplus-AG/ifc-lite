/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `AbortSignal.timeout` under the happy-dom test environment behaves like the
 * platform's: it still aborts with a TimeoutError on happy-dom's own signal
 * class, and a timeout that never fires does not keep the process alive.
 * happy-dom's version did, which held every test file that made a bounded
 * request open for the whole timeout after its last test.
 */
import './setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('setup-dom AbortSignal.timeout', () => {
  it('aborts with a TimeoutError on the environment AbortSignal', async () => {
    const signal = AbortSignal.timeout(5);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    assert.equal(signal.aborted, true);
    assert.equal((signal.reason as DOMException).name, 'TimeoutError');
  });

  it('does not hold the process open until a pending timeout fires', () => {
    const setupUrl = new URL('./setup-dom.ts', import.meta.url).href;
    const started = Date.now();
    const child = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e',
      `await import(${JSON.stringify(setupUrl)}); AbortSignal.timeout(120000);`,
    ], { cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 30_000 });
    const elapsedMs = Date.now() - started;
    assert.equal(child.error, undefined, `child did not exit by itself: ${String(child.error)}`);
    assert.equal(child.status, 0, child.stderr);
    assert.ok(elapsedMs < 30_000, `child lingered ${elapsedMs} ms`);
  });
});
