/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('#6537 real held ELF preserves kernel inode, owner PID and argv despite path replacement and refuses invalid receipts', t => {
  if (process.platform !== 'linux') {
    assert.notEqual(process.env.NATIVE_FD_CONTROL_REQUIRED, '1', 'hosted FD control requires Linux');
    t.skip('numeric-FD Linux execution control'); return;
  }
  const result = spawnSync('python3', ['-I', '-S', '-B', fileURLToPath(new URL('./native-prebuilt-control.py', import.meta.url)), 'suite'], {
    env: { ...process.env, OBS: '0' }, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 ** 2,
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, '');
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'qualified-functional-ELF-only');
  assert.equal(receipt.independentExecutions.length, 2);
  for (const row of receipt.independentExecutions) assert.equal(row.observed.marker, 'held-original');
});
