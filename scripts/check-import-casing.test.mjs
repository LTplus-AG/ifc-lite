/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for scripts/lib/import-casing.mjs, the resolver behind
 * check-import-casing.mjs. Synthetic file lists only: a change to this
 * checkout's own sources can never make these vacuously pass.
 *
 * Run: `node --test scripts/check-import-casing.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { findCasingMismatches, extractRelativeSpecifiers } from './lib/import-casing.mjs';

const run = (files, sources) => findCasingMismatches(files, (f) => sources[f] ?? '');

test('flags an import whose case differs from the tracked file (works on macOS, fails on Linux)', () => {
  const m = run(['a/main.ts', 'a/foo.ts'], { 'a/main.ts': `import { x } from './Foo';` });
  assert.deepEqual(m, [{ file: 'a/main.ts', specifier: './Foo', actual: 'a/foo.ts' }]);
});

test('flags a wrong-case directory component resolved through an index file', () => {
  const m = run(['a/main.ts', 'a/utils/index.ts'], { 'a/main.ts': `export * from './Utils';` });
  assert.equal(m.length, 1);
  assert.equal(m[0].actual, 'a/utils/index.ts');
});

test('flags dynamic import, require and vi.mock specifiers', () => {
  const src = `await import('./Foo.js'); require('./Foo'); vi.mock('./FOO');`;
  const m = run(['a/main.ts', 'a/foo.ts'], { 'a/main.ts': src });
  assert.deepEqual(m.map((x) => x.specifier).sort(), ['./FOO', './Foo', './Foo.js']);
});

test('accepts exact case, NodeNext .js -> .ts, directories and parent paths', () => {
  const files = ['a/main.ts', 'a/Foo.ts', 'a/sub/index.ts', 'b/bar.tsx', 'a/data.json'];
  const src = {
    'a/main.ts': `import './Foo'; import './Foo.js'; import './sub'; import '../b/bar'; import d from './data.json';`,
  };
  assert.deepEqual(run(files, src), []);
});

test('ignores specifiers that resolve to nothing and bare package imports', () => {
  const m = run(['a/main.ts'], { 'a/main.ts': `import './generated'; import 'react'; import '@x/y';` });
  assert.deepEqual(m, []);
});

test('extractRelativeSpecifiers ignores non-relative specifiers', () => {
  assert.deepEqual(extractRelativeSpecifiers(`import a from 'a'; import b from './b';`), ['./b']);
});

test('flags a wrong-case `new URL(..., import.meta.url)` worker or asset path', () => {
  const src = `new Worker(new URL('./Foo.worker.ts', import.meta.url), { type: 'module' });`;
  const m = run(['a/main.ts', 'a/foo.worker.ts'], { 'a/main.ts': src });
  assert.deepEqual(m, [{ file: 'a/main.ts', specifier: './Foo.worker.ts', actual: 'a/foo.worker.ts' }]);
  assert.deepEqual(run(['a/main.ts', 'a/Foo.worker.ts'], { 'a/main.ts': src }), []);
});

test('a `new URL` against another base is not an import specifier', () => {
  const m = run(['a/main.ts', 'a/foo.ts'], { 'a/main.ts': `new URL('./Foo', base);` });
  assert.deepEqual(m, []);
});
