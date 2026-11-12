/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer import graph: specifier extraction, resolution the way the
 * viewer's tsconfig and workspace packages resolve, and the reverse walk.
 *
 * Run: node --test scripts/lib/viewer-import-graph.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  affectedTests, buildGraph, createResolver, extractSpecifiers, isViewerTest, packageNode,
} from './viewer-import-graph.mjs';

test('extractSpecifiers finds every static, dynamic, worker and loader form', () => {
  const code = [
    "import a from './a.js';",
    "import { b,\n  c as d } from '../b';",
    "import './side-effect';",
    "export * from './barrel.js';",
    "export { e } from '@/lib/e.js';",
    "const m = await import('./lazy.js');",
    "const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });",
    "register('./hooks-impl.mjs', import.meta.url);",
    "module.register('./other-hooks.mjs', import.meta.url);",
    "const r = require('./cjs');",
    "mock.module('./mocked.js', { namedExports: {} });",
    "import raw from './shader.wgsl?raw';",
    "import { type T, f } from './mixed.js';",
  ].join('\n');
  assert.deepEqual(new Set(extractSpecifiers(code)), new Set([
    './a.js', '../b', './side-effect', './barrel.js', '@/lib/e.js', './lazy.js', './worker.ts',
    './hooks-impl.mjs', './other-hooks.mjs', './cjs', './mocked.js', './shader.wgsl', './mixed.js',
  ]));
});

test('extractSpecifiers drops whole type-only statements, which tsx erases', () => {
  const code = "import type { A } from './types.js';\nexport type { B } from './more.js';\nimport { c } from './real.js';";
  assert.deepEqual(extractSpecifiers(code), ['./real.js']);
});

test('extractSpecifiers keeps an import list that holds comments', () => {
  const code = "export {\n  // the decoder, see #123\n  decode, /* inline */ encode,\n} from './codec.js';";
  assert.deepEqual(extractSpecifiers(code), ['./codec.js']);
});

test('a type-only strip without semicolons does not swallow the next import', () => {
  assert.deepEqual(extractSpecifiers("export type { A }\nimport b from './b'\n"), ['./b']);
  assert.deepEqual(extractSpecifiers("import type T from './t'\nimport c from './c'"), ['./c']);
});

test('resolve: an alias that matches but resolves nowhere falls back to the package exports', () => {
  const r = createResolver({
    files: new Set(['packages/p/src/index.ts']),
    aliases: [{ pattern: '@x/p', targets: ['packages/p/moved'] }],
    packages: new Map([['@x/p', { dir: 'packages/p', exports: { '.': './dist/index.js' } }]]),
  });
  assert.deepEqual(r('a.ts', '@x/p'), { kind: 'file', path: 'packages/p/src/index.ts' });
});

test('extractSpecifiers ignores runtime-built specifiers and property calls', () => {
  // A literal template-literal import in the source text under test, not a template string here.
  // eslint-disable-next-line no-template-curly-in-string
  const code = "await import(`./x/${name}.js`);\nconst p = './y.js';\nfoo.import('./z.js');\nslots.register('./q.js', [entry]);";
  assert.deepEqual(extractSpecifiers(code), []);
});

const FILES = new Set([
  'apps/viewer/src/a.test.ts',
  'apps/viewer/src/lib/util.ts',
  'apps/viewer/src/lib/index.tsx',
  'apps/viewer/src/data.json',
  'packages/parser/src/index.ts',
  'packages/parser/src/deep.ts',
  'packages/sdk/src/review.ts',
]);
const resolve = createResolver({
  files: FILES,
  aliases: [
    { pattern: '@/*', targets: ['apps/viewer/src/*'] },
    { pattern: '@ifc-lite/parser', targets: ['packages/parser/src'] },
  ],
  packages: new Map([
    ['@ifc-lite/parser', { dir: 'packages/parser', exports: { '.': { import: './dist/index.js' } } }],
    ['@ifc-lite/sdk', { dir: 'packages/sdk', exports: { './review': { import: './dist/review.js', types: './dist/review.d.ts' } } }],
    ['@ifc-lite/wasm', { dir: 'packages/wasm', exports: { '.': { import: './pkg/ifc-lite.js' } } }],
  ]),
});
const IMPORTER = 'apps/viewer/src/a.test.ts';

test('resolve: relative, the .js -> .ts convention, directory index and JSON', () => {
  assert.deepEqual(resolve(IMPORTER, './lib/util.js'), { kind: 'file', path: 'apps/viewer/src/lib/util.ts' });
  assert.deepEqual(resolve(IMPORTER, './lib/util'), { kind: 'file', path: 'apps/viewer/src/lib/util.ts' });
  assert.deepEqual(resolve(IMPORTER, './lib'), { kind: 'file', path: 'apps/viewer/src/lib/index.tsx' });
  assert.deepEqual(resolve(IMPORTER, './data.json'), { kind: 'file', path: 'apps/viewer/src/data.json' });
});

test('resolve: tsconfig paths, wildcard and exact', () => {
  assert.deepEqual(resolve(IMPORTER, '@/lib/util.js'), { kind: 'file', path: 'apps/viewer/src/lib/util.ts' });
  assert.deepEqual(resolve(IMPORTER, '@ifc-lite/parser'), { kind: 'file', path: 'packages/parser/src/index.ts' });
});

test('resolve: a workspace export maps dist back to src; one that cannot is opaque', () => {
  assert.deepEqual(resolve(IMPORTER, '@ifc-lite/sdk/review'), { kind: 'file', path: 'packages/sdk/src/review.ts' });
  assert.deepEqual(resolve(IMPORTER, '@ifc-lite/wasm'), { kind: 'package', name: '@ifc-lite/wasm' });
  assert.deepEqual(resolve(IMPORTER, '@ifc-lite/sdk/nope'), { kind: 'package', name: '@ifc-lite/sdk' });
});

test('resolve: npm packages are external and a missing relative file is recorded', () => {
  assert.deepEqual(resolve(IMPORTER, 'react'), { kind: 'external' });
  assert.deepEqual(resolve(IMPORTER, './gone.js'), { kind: 'missing', base: 'apps/viewer/src/gone.js' });
  assert.deepEqual(resolve(IMPORTER, '../../../../escape.js'), { kind: 'missing', base: '../escape.js' });
});

test('isViewerTest matches the set the viewer test script finds', () => {
  assert.equal(isViewerTest('apps/viewer/src/x/y.test.ts'), true);
  assert.equal(isViewerTest('apps/viewer/src/x/y.test.tsx'), true);
  assert.equal(isViewerTest('apps/viewer/src/x/y.ts'), false);
  assert.equal(isViewerTest('apps/viewer/e2e/y.test.ts'), false);
  assert.equal(isViewerTest('packages/parser/src/y.test.ts'), false);
});

/** A small graph: two tests, a shared hub, a preload every test depends on. */
function fixtureGraph() {
  const src = {
    'apps/viewer/src/t1.test.ts': "import './near.js';",
    'apps/viewer/src/t2.test.ts': "import './far.js';\nimport { w } from '@ifc-lite/wasm';",
    'apps/viewer/src/t3.test.ts': "import './gone.js';",
    'apps/viewer/src/near.ts': "import './hub.js';",
    'apps/viewer/src/far.ts': "import './mid.js';",
    'apps/viewer/src/mid.ts': "import './hub.js';",
    'apps/viewer/src/hub.ts': '',
    'apps/viewer/src/test/hooks.mjs': "register('./hooks-impl.mjs', import.meta.url);",
    'apps/viewer/src/test/hooks-impl.mjs': '',
  };
  const files = new Set(Object.keys(src));
  const r = createResolver({ files, packages: new Map([['@ifc-lite/wasm', { dir: 'packages/wasm', exports: { '.': './pkg/x.js' } }]]) });
  return buildGraph({
    tests: ['apps/viewer/src/t1.test.ts', 'apps/viewer/src/t2.test.ts', 'apps/viewer/src/t3.test.ts'],
    preloads: ['apps/viewer/src/test/hooks.mjs'],
    read: (p) => src[p],
    resolve: r,
  });
}

test('affectedTests returns the shortest import distance per test', () => {
  const g = fixtureGraph();
  assert.deepEqual(affectedTests(g, ['apps/viewer/src/hub.ts']), new Map([
    ['apps/viewer/src/t1.test.ts', 2],
    ['apps/viewer/src/t2.test.ts', 3],
  ]));
  assert.deepEqual(affectedTests(g, ['apps/viewer/src/t1.test.ts']), new Map([['apps/viewer/src/t1.test.ts', 0]]));
});

test('a preloaded module and what it registers reach every test', () => {
  const g = fixtureGraph();
  assert.equal(affectedTests(g, ['apps/viewer/src/test/hooks-impl.mjs']).size, 3);
});

test('an opaque package import is a `pkg:` node, and a missing import is kept for deletions', () => {
  const g = fixtureGraph();
  assert.ok(g.nodes.has(packageNode('@ifc-lite/wasm')));
  assert.deepEqual(affectedTests(g, [packageNode('@ifc-lite/wasm')]), new Map([['apps/viewer/src/t2.test.ts', 1]]));
  assert.deepEqual([...g.missing.get('apps/viewer/src/gone')], ['apps/viewer/src/t3.test.ts']);
});

test('a node no test reaches affects nothing', () => {
  assert.equal(affectedTests(fixtureGraph(), ['apps/viewer/src/unrelated.ts']).size, 0);
});
