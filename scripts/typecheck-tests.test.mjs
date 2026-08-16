#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression tests for the `extends` path typecheck-tests.mjs writes into
 * every generated tsconfig.tests.json.
 *
 * The defect pinned here (#2664 review): the value came straight from
 * `path.relative()`, which returns a BARE `tsconfig.tests.base.json` whenever
 * the generated program sits next to the base config — i.e. whenever the
 * program is written at the repo root. tsc resolves a bare `extends` as a NODE
 * MODULE, not a path, so the base config was not found (TS6053) and the
 * `noEmit` it carries never applied. Confirmed with a two-file control: an
 * otherwise identical program with a bare extends emitted `a.js`; the
 * `./`-prefixed one emitted nothing. Combined with the CLI ignoring an
 * unrecognised argument, `node scripts/typecheck-tests.mjs packages/clash`
 * from the repo root left 9,609 untracked .js/.d.ts/.map files in the source
 * tree.
 *
 * Nothing about this is visible in normal use — the config parses, tsc runs,
 * every package under packages/ happens to get a `../../`-prefixed path that
 * resolves fine — which is exactly why it needs a test rather than a comment.
 *
 * Run: node --test scripts/typecheck-tests.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { relativeExtends } from './typecheck-tests.mjs';

test('a sibling base config is ./-prefixed, not bare', () => {
  // The repo-root case: pkgDir and the base config are the same directory.
  const root = path.resolve('/repo');
  assert.equal(
    relativeExtends(root, path.join(root, 'tsconfig.tests.base.json')),
    './tsconfig.tests.base.json',
  );
});

test('a base config above the package keeps its ../ prefix untouched', () => {
  // The packages/* case, which always worked and must keep working.
  const root = path.resolve('/repo');
  assert.equal(
    relativeExtends(path.join(root, 'packages', 'clash'), path.join(root, 'tsconfig.tests.base.json')),
    '../../tsconfig.tests.base.json',
  );
});

test('a base config in a subdirectory is ./-prefixed', () => {
  const root = path.resolve('/repo');
  assert.equal(
    relativeExtends(root, path.join(root, 'config', 'tsconfig.tests.base.json')),
    './config/tsconfig.tests.base.json',
  );
});

test('every result tsc would treat as a path, does start with . ', () => {
  // The property that actually matters: tsc treats `extends` as a relative
  // path only when it begins with `./` or `../`. Anything else is a package
  // name. Assert the property directly, not just the three cases above.
  const root = path.resolve('/repo');
  const targets = [
    path.join(root, 'tsconfig.tests.base.json'),
    path.join(root, 'a', 'tsconfig.tests.base.json'),
  ];
  const froms = [root, path.join(root, 'packages', 'clash'), path.join(root, 'apps', 'viewer')];
  for (const from of froms) {
    for (const target of targets) {
      const value = relativeExtends(from, target);
      assert.ok(
        value.startsWith('./') || value.startsWith('../'),
        `${value} (from ${from}) would be resolved as a node module, not a path`,
      );
    }
  }
});
