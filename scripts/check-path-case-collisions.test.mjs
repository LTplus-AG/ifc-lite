/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Drives the gate as a CLI (as CI does) against throwaway git repositories whose
// index is populated with `update-index --cacheinfo`, so a synthetic collision
// can be tracked even on a case-insensitive filesystem.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-path-case-collisions.mjs');
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

function run(tracked) {
  const dir = mkdtempSync(join(tmpdir(), 'case-collisions-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('hash-object', '-w', '--stdin').status, 0);
    for (const path of tracked) {
      assert.equal(git('update-index', '--add', '--cacheinfo', `100644,${EMPTY_BLOB},${path}`).status, 0);
    }
    return spawnSync(process.execPath, [SCRIPT, '--root', dir], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('fails and lists paths that differ only in case', () => {
  const result = run([
    'apps/viewer/src/SourceWideSearch.tsx',
    'apps/viewer/src/sourceWideSearch.tsx',
    'apps/viewer/src/other.ts',
  ]);
  assert.equal(result.status, 1);
  // Booleans, not the raw stderr, so a missing script reads as a plain
  // assertion failure rather than a module-load error.
  assert.equal(/SourceWideSearch\.tsx\s+<->\s+apps\/viewer\/src\/sourceWideSearch\.tsx/.test(result.stderr), true);
  assert.equal(/other\.ts/.test(result.stderr), false);
});

test('fails on a collision in a directory name', () => {
  assert.equal(run(['a/Foo/x.ts', 'a/foo/y.ts']).status, 1);
});

test('passes when names are distinct', () => {
  const result = run(['a.ts', 'b.ts', 'dir/a.ts']);
  assert.equal(result.status, 0);
});

test('passes on the current repository', () => {
  const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
  assert.equal(result.status, 0);
});
