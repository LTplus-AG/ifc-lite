/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for scripts/lib/main-entry-guards.mjs, the detector behind
 * check-main-entry-guards.mjs. Synthetic sources only.
 *
 * Run: `node --test scripts/check-main-entry-guards.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { findHandRolledMainGuards } from './lib/main-entry-guards.mjs';

const scan = (src, file = 'scripts/x.mjs') => findHandRolledMainGuards([file], () => src);

test('flags every hand-rolled shape that this repo actually carried', () => {
  const shapes = [
    "if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();",
    "if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {",
    "if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {",
    "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {",
    "if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {",
    "const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;",
  ];
  for (const shape of shapes) assert.equal(scan(shape).length, 1, shape);
});

test('accepts isMainEntry, an endsWith guard, and comments that quote the bad shape', () => {
  assert.deepEqual(scan("if (isMainEntry(import.meta.url)) main();"), []);
  assert.deepEqual(scan("if (process.argv[1] && process.argv[1].endsWith('x.mjs')) main();"), []);
  assert.deepEqual(scan("// not `import.meta.url === `file://${process.argv[1]}``, see is-main-entry"), []);
  assert.deepEqual(scan(" * `import.meta.url === file://${argv[1]}` is wrong"), []);
});

test('accepts a comparison that realpaths both sides', () => {
  assert.deepEqual(scan('process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));'), []);
});

test('ignores non-source files, test files and the helper itself', () => {
  const bad = "if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();";
  assert.deepEqual(scan(bad, 'docs/notes.md'), []);
  assert.deepEqual(scan(bad, 'scripts/lib/is-main-entry.mjs'), []);
  assert.deepEqual(scan(bad, 'scripts/lib/is-main-entry.test.mjs'), []);
});

test('reports file and 1-based line', () => {
  const hits = scan("a();\nb();\nif (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();");
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].file, 'scripts/x.mjs');
});
