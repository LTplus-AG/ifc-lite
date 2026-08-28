/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared walk's refusals, under a `fail` that RETURNS.
 *
 * Both gates' `fail` throws, so nothing reachable through them exercises what
 * happens if one ever stops. That is the whole point of the rethrows in
 * `list-workspace-packages.mjs`: without them a soft `fail` prints the message
 * and then CONTINUES, and the package this module exists to protect enters the
 * counted population with `pkgJson: undefined`. Measured, that is not a
 * hypothetical - it is what the code did before those lines.
 *
 * Deleting any of the three rethrows left every other test in `scripts/` green,
 * which is why this file exists rather than another case in the gate suites.
 *
 * Run: node --test scripts/lib/list-workspace-packages.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listWorkspacePackages } from './list-workspace-packages.mjs';

/** Prints and RETURNS, the way a gate's `fail` must never be written. */
function softFail(messages) {
  return (message) => { messages.push(message); };
}

function withTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'list-workspace-packages-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seed(root, manifest = '{"name":"alpha"}') {
  mkdirSync(join(root, 'packages/alpha'), { recursive: true });
  writeFileSync(join(root, 'packages/alpha/package.json'), manifest);
}

test('the happy path returns the package and the parent it came from', () => {
  withTree((root) => {
    seed(root);
    const messages = [];
    const { packages, seenParents } = listWorkspacePackages(root, softFail(messages), ['packages']);
    assert.deepEqual(packages.map((p) => p.rel), ['packages/alpha']);
    assert.deepEqual(seenParents, ['packages']);
    assert.deepEqual(messages, [], 'nothing should have been refused here');
  });
});

test('an unreadable package PARENT throws rather than returning a short population', (t) => {
  if (process.platform === 'win32') return t.skip('chmod 000 does not block traversal on Windows');
  if (process.getuid?.() === 0) return t.skip('root traverses every directory regardless of mode');
  withTree((root) => {
    seed(root);
    const parent = join(root, 'packages');
    chmodSync(parent, 0o000);
    try {
      const messages = [];
      // Asserts the ORIGINAL fs error escapes, not merely that SOMETHING did.
      // Without the rethrow this still threw - `entries` stayed undefined and
      // the `for...of` below died with a TypeError - so a bare assert.throws
      // passed on the wrong error and the test could not fail. Pinning the
      // errno is what makes it discriminate.
      assert.throws(
        () => listWorkspacePackages(root, softFail(messages), ['packages']),
        (err) => err.code === 'EACCES',
        'the fs error itself must escape, not a TypeError from undefined entries',
      );
      assert.match(messages[0] ?? '', /cannot read package parent/);
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

test('an unreadable MANIFEST throws rather than admitting a package with no pkgJson', (t) => {
  if (process.platform === 'win32') return t.skip('chmod does not gate reads on Windows');
  if (process.getuid?.() === 0) return t.skip('root reads a 000 file regardless of mode');
  withTree((root) => {
    seed(root);
    const manifest = join(root, 'packages/alpha/package.json');
    chmodSync(manifest, 0o000);
    try {
      const messages = [];
      // The one that corrupts rather than merely confusing: without the rethrow
      // this returned [{rel:'packages/alpha', pkgJson: undefined}].
      assert.throws(
        () => listWorkspacePackages(root, softFail(messages), ['packages']),
        (err) => err.code === 'EACCES',
      );
      assert.match(messages[0] ?? '', /cannot read package manifest/);
    } finally {
      chmodSync(manifest, 0o644);
    }
  });
});

test('a MALFORMED manifest throws too, and says syntax rather than unreadable', () => {
  withTree((root) => {
    seed(root, '{oops');
    const messages = [];
    // The sibling hole: same corruption, reached through the parse branch.
    assert.throws(
      () => listWorkspacePackages(root, softFail(messages), ['packages']),
      (err) => err instanceof SyntaxError,
    );
    assert.match(messages[0] ?? '', /is not valid JSON/);
    assert.doesNotMatch(messages[0] ?? '', /cannot read package manifest/);
  });
});

test('an ABSENT parent is skipped, not refused', () => {
  withTree((root) => {
    seed(root);
    const messages = [];
    const { packages, seenParents } = listWorkspacePackages(root, softFail(messages), ['packages', 'apps']);
    assert.deepEqual(packages.map((p) => p.rel), ['packages/alpha']);
    assert.deepEqual(seenParents, ['packages'], 'apps/ does not exist, so it is not a seen parent');
    assert.deepEqual(messages, [], 'absent is not unreadable');
  });
});
