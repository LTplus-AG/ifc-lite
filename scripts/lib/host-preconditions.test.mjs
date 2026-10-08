/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isCI, skipUnlessFilesExist, skipUnlessCommand } from './host-preconditions.mjs';

const LOCAL = {};
const CI = { CI: 'true' };

test('isCI reads the CI variable the way Actions sets it and ignores empty, 0 and false', () => {
  assert.equal(isCI({ CI: 'true' }), true);
  assert.equal(isCI({ CI: '1' }), true);
  assert.equal(isCI({}), false);
  assert.equal(isCI({ CI: '' }), false);
  assert.equal(isCI({ CI: '0' }), false);
  assert.equal(isCI({ CI: 'false' }), false);
});

test('skipUnlessFilesExist skips off CI with a message naming the file and the remedy, runs when it exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-pre-'));
  try {
    const reason = skipUnlessFilesExist(root, ['packages/x/dist/index.js'], 'pnpm build', LOCAL);
    assert.equal(typeof reason, 'string');
    assert.match(reason, /packages\/x\/dist\/index\.js/);
    assert.match(reason, /pnpm build/);
    writeFileSync(join(root, 'present.js'), '');
    assert.equal(skipUnlessFilesExist(root, ['present.js'], 'pnpm build', LOCAL), false);
    // One missing among several present is still a skip, and names only the missing one.
    const partial = skipUnlessFilesExist(root, ['present.js', 'absent.js'], 'pnpm build', LOCAL);
    assert.match(partial, /absent\.js/);
    assert.doesNotMatch(partial, /present\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skipUnlessFilesExist never skips on CI: a missing build artifact there must fail, not pass vacuously', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-pre-'));
  try {
    assert.equal(skipUnlessFilesExist(root, ['packages/x/dist/index.js'], 'pnpm build', CI), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skipUnlessCommand skips off CI when the probe fails and runs when it succeeds', () => {
  assert.equal(skipUnlessCommand(process.execPath, ['--version'], 'install node', LOCAL), false);
  const reason = skipUnlessCommand(process.execPath, ['-e', 'process.exit(3)'], 'install the thing', LOCAL);
  assert.equal(typeof reason, 'string');
  assert.match(reason, /install the thing/);
  const missingBin = skipUnlessCommand('definitely-not-a-real-binary-xyz', ['--version'], 'install it', LOCAL);
  assert.equal(typeof missingBin, 'string');
});

test('a probe that hangs is killed at the timeout and reads as a skip, not a crash or a hang', () => {
  const started = Date.now();
  const reason = skipUnlessCommand(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], 'install the thing', LOCAL, { timeoutMs: 300 });
  assert.equal(typeof reason, 'string');
  assert.ok(Date.now() - started < 2_500, 'the probe must not outlive its timeout');
});

test('skipUnlessCommand never skips on CI, and does not even run the probe there', () => {
  // A probe that would hang proves the CI branch returns before spawning.
  const started = Date.now();
  assert.equal(skipUnlessCommand(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], 'x', CI, { timeoutMs: 60_000 }), false);
  assert.ok(Date.now() - started < 2_500);
});

test('skipUnlessCommand never skips on CI', () => {
  assert.equal(skipUnlessCommand(process.execPath, ['-e', 'process.exit(3)'], 'install the thing', CI), false);
});
