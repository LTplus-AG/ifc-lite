/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCaseCollisions } from './check-path-case-collisions.mjs';

test('reports paths that differ only in case', () => {
  const groups = findCaseCollisions([
    'apps/viewer/src/SourceWideSearch.tsx',
    'apps/viewer/src/sourceWideSearch.ts',
    'apps/viewer/src/sourceWideSearch.tsx',
  ]);
  assert.deepEqual(groups, [['apps/viewer/src/SourceWideSearch.tsx', 'apps/viewer/src/sourceWideSearch.tsx']]);
});

test('detects a collision in a directory name', () => {
  assert.equal(findCaseCollisions(['a/Foo/x.ts', 'a/foo/y.ts', 'a/foo/x.ts']).length, 1);
});

test('distinct names and duplicate entries are clean', () => {
  assert.deepEqual(findCaseCollisions(['a.ts', 'b.ts', 'b.ts']), []);
});

test('the current repository has no collisions', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  assert.deepEqual(findCaseCollisions(out.split('\0').filter(Boolean)), []);
});
