/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The refusal itself, tested where its callers cannot reach it.
 *
 * check-test-glob-coverage.test.mjs and check-test-wiring.test.mjs both pin
 * this end-to-end, through their own gates, which is the coverage that matters.
 * Two things are only visible from here:
 *
 *   - The ENOENT/not-ENOENT split as a PROPERTY rather than as the two error
 *     codes those suites happen to construct. `existsOrThrow` is one branch
 *     away from `existsSync` at all times, and the branch is which codes fall
 *     through to `false`.
 *   - The soft-`fail` case. Both gates' `fail` throws, so nothing reachable
 *     from them exercises what happens if one ever stops throwing — which is
 *     exactly the edit that would put the silent drop back while leaving the
 *     error message printed above it.
 *
 * Run: node --test scripts/lib/exists-or-throw.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsOrThrow } from './exists-or-throw.mjs';

class TestFail extends Error {}
const throwingFail = (message) => { throw new TestFail(message); };

function withTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'exists-or-throw-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a path that exists is true', () => {
  withTree((root) => {
    writeFileSync(join(root, 'here.json'), '{}');
    assert.equal(existsOrThrow(join(root, 'here.json'), 'thing', throwingFail), true);
    mkdirSync(join(root, 'dir'));
    assert.equal(existsOrThrow(join(root, 'dir'), 'thing', throwingFail), true);
  });
});

test('a path that is genuinely absent is false — ENOENT, and only ENOENT, means absent', () => {
  withTree((root) => {
    assert.equal(existsOrThrow(join(root, 'nope.json'), 'thing', throwingFail), false);
    // A dangling symlink's target is absent in exactly the same sense.
    assert.equal(existsOrThrow(join(root, 'a', 'b', 'nope.json'), 'thing', throwingFail), false);
  });
});

test('ENOTDIR is refused, not read as absent', () => {
  // A FILE where a directory belongs — what macOS `.DS_Store` produces, and
  // what a mistyped path produces. `existsSync` answers false here.
  withTree((root) => {
    writeFileSync(join(root, 'file'), 'not a directory\n');
    assert.throws(
      () => existsOrThrow(join(root, 'file', 'package.json'), 'package manifest', throwingFail),
      (err) => err instanceof TestFail
        && /cannot read package manifest/.test(err.message)
        && /ENOTDIR/.test(err.message)
        && /Refusing to treat an unreadable path as an absent one/.test(err.message),
    );
  });
});

test('EACCES is refused, not read as absent', (t) => {
  // Windows chmod does not remove directory traversal, so statSync succeeds and
  // the refusal never fires. CI is linux-only today, but a Windows checkout
  // would see a spurious failure here rather than a real one.
  if (process.platform === 'win32') return t.skip('chmod 000 does not block traversal on Windows');
  if (process.getuid?.() === 0) return t.skip('root traverses every directory regardless of mode');
  withTree((root) => {
    mkdirSync(join(root, 'locked'));
    writeFileSync(join(root, 'locked', 'package.json'), '{}');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      assert.throws(
        () => existsOrThrow(join(root, 'locked', 'package.json'), 'package manifest', throwingFail),
        (err) => err instanceof TestFail && /EACCES/.test(err.message),
      );
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
    }
  });
});

test('a `fail` that RETURNS still does not yield a false: the refusal cannot go soft', () => {
  // Neither gate can reach this — both `fail`s throw. It is here because the
  // whole helper is one non-throwing reporter away from handing back
  // `undefined`, which every caller reads as "absent": the printed error would
  // stay, the package would still drop out of the audit, and the exit code
  // would still be 0.
  withTree((root) => {
    writeFileSync(join(root, 'file'), 'not a directory\n');
    const reported = [];
    const softFail = (message) => { reported.push(message); };
    assert.throws(
      () => existsOrThrow(join(root, 'file', 'package.json'), 'package manifest', softFail),
      (err) => err.code === 'ENOTDIR',
      'it must throw the underlying error rather than return',
    );
    assert.equal(reported.length, 1, 'and it must still have reported through fail');
  });
});
