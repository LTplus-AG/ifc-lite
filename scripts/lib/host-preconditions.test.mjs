/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isCI, skipUnlessBuilt, skipUnlessCommand } from './host-preconditions.mjs';

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

test('skipUnlessBuilt skips off CI with a message naming the file and the remedy, runs when it exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-pre-'));
  try {
    const reason = skipUnlessBuilt(root, ['packages/x/dist/index.js'], 'pnpm build', LOCAL);
    assert.equal(typeof reason, 'string');
    assert.match(reason, /packages\/x\/dist\/index\.js/);
    assert.match(reason, /pnpm build/);
    writeFileSync(join(root, 'present.js'), '');
    assert.equal(skipUnlessBuilt(root, ['present.js'], 'pnpm build', LOCAL), false);
    // One missing among several present is still a skip, and names only the missing one.
    const partial = skipUnlessBuilt(root, ['present.js', 'absent.js'], 'pnpm build', LOCAL);
    assert.match(partial, /absent\.js/);
    assert.doesNotMatch(partial, /present\.js/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skipUnlessBuilt never skips on CI: a missing build artifact there must fail, not pass vacuously', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-pre-'));
  try {
    assert.equal(skipUnlessBuilt(root, ['packages/x/dist/index.js'], 'pnpm build', CI), false);
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

test('skipUnlessCommand never skips on CI', () => {
  assert.equal(skipUnlessCommand(process.execPath, ['-e', 'process.exit(3)'], 'install the thing', CI), false);
});
