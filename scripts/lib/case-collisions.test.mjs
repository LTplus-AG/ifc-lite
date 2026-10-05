/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findCollisions } from './case-collisions.mjs';

const flat = (groups) => groups.map((g) => [...g].sort());

test('#6944 component and model differing by case and extension collide', () => {
  assert.deepEqual(flat(findCollisions(['a/SourceWideSearch.tsx', 'a/sourceWideSearch.ts'])), [
    ['a/SourceWideSearch.tsx', 'a/sourceWideSearch.ts'],
  ]);
});

test('same-case stems with different extensions are not a collision', () => {
  assert.deepEqual(findCollisions(['a/Foo.ts', 'a/Foo.tsx', 'a/Foo.test.ts']), []);
});

test('paths that differ only by extension case are the same file on a case-insensitive filesystem', () => {
  assert.deepEqual(flat(findCollisions(['img/a.PNG', 'img/a.png'])), [['img/a.PNG', 'img/a.png']]);
});

test('directories differing only by case collide even when their files differ', () => {
  const groups = findCollisions(['Docs/a.md', 'docs/b.md']);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0]].sort(), ['Docs', 'docs']);
});

test('a file and a directory differing only by case collide', () => {
  const groups = findCollisions(['Foo', 'foo/x.ts']);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0]].sort(), ['Foo', 'foo']);
});

test('dotfiles are compared whole, not as an empty stem', () => {
  assert.deepEqual(flat(findCollisions(['.Env', '.env'])), [['.Env', '.env']]);
});

test('non-ASCII case folding and Unicode normalization are honoured', () => {
  assert.equal(findCollisions(['a/École.ts', 'a/école.ts']).length, 1);
  // precomposed vs decomposed: APFS treats these as one name
  assert.equal(findCollisions(['a/café.ts', 'a/café.ts']).length, 1);
});

test('paths with spaces and dots in directory names are handled', () => {
  assert.equal(findCollisions(['my dir.v1/Read Me.md', 'my dir.v1/read me.txt']).length, 1);
  assert.deepEqual(findCollisions(['my dir.v1/Read Me.md', 'my dir.v2/read me.txt']), []);
});

test('a clean tree reports nothing and an identical path listed twice is not a collision', () => {
  assert.deepEqual(findCollisions(['a/b.ts', 'a/c.ts', 'a/b.ts']), []);
});
