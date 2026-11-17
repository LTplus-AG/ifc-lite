/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
// Namespace import: a missing export reads as undefined and fails an assertion
// below, instead of failing the module load.
import * as chunks from '../../vite-chunks';

type Group = { name: string; priority: number; includeDependenciesRecursively?: boolean; test: RegExp };

function tslibGroup(): Group {
  const group = (chunks as Record<string, unknown>).tslibChunkGroup as Group | undefined;
  assert.ok(group, 'vite-chunks must export tslibChunkGroup');
  return group;
}

test('tslib is claimed by its own chunk before the recursive vendor groups', () => {
  const group = tslibGroup();
  assert.equal(group.name, 'tslib');
  // legacyManualChunk runs at priority 0 and pulls dependencies recursively.
  assert.ok(group.priority > 0, 'must outrank the legacy group');
  assert.equal(group.includeDependenciesRecursively, false);
  for (const id of [
    '/repo/node_modules/.pnpm/tslib@2.8.1/node_modules/tslib/tslib.es6.mjs',
    '/repo/node_modules/.pnpm/tslib@2.9.1/node_modules/tslib/modules/index.js',
    '/repo/node_modules/tslib/tslib.es6.js',
  ]) assert.ok(group.test.test(id), id);
});

test('the tslib group claims nothing else', () => {
  const group = tslibGroup();
  for (const id of [
    '/repo/node_modules/.pnpm/cesium@1.146.0/node_modules/cesium/Source/Cesium.js',
    '/repo/node_modules/.pnpm/apache-arrow@21.2.0/node_modules/apache-arrow/Arrow.dom.mjs',
    '/repo/node_modules/.pnpm/@swc+helpers@0.5.21/node_modules/@swc/helpers/esm/index.js',
    '/repo/node_modules/tslib-extra/index.js',
  ]) assert.equal(group.test.test(id), false, id);
  assert.equal(chunks.legacyManualChunk('/repo/node_modules/tslib/tslib.es6.mjs'), undefined);
});

// #9200: the recursive `sandbox` chunk is eager (eager code imports
// SandboxAbortError and the bridge schema), and it swallowed the QuickJS
// runtime core that only a script run needs. The runtime group claims that
// core first. It must leave the core's index alone: eager code reaches the
// index, and any eager module in a group makes the whole group eager.
test('the QuickJS runtime group claims the lazy runtime files, not the eager index', () => {
  const group = (chunks as Record<string, unknown>).quickjsRuntimeChunkGroup as Group | undefined;
  assert.ok(group, 'vite-chunks must export quickjsRuntimeChunkGroup');
  assert.ok(group.priority > 0, 'must outrank the recursive legacy group');
  assert.equal(group.includeDependenciesRecursively, false);
  const core = '/repo/node_modules/.pnpm/quickjs-emscripten-core@0.32.0/node_modules/quickjs-emscripten-core/dist/';
  for (const id of [
    `${core}chunk-V2S4ZYJR.mjs`,
    `${core}module-ES6BEMUI.mjs`,
    '/repo/node_modules/.pnpm/@jitl+quickjs-ffi-types@0.32.0/node_modules/@jitl/quickjs-ffi-types/dist/index.mjs',
  ]) assert.ok(group.test.test(id), id);
  for (const id of [
    `${core}index.mjs`,
    '/repo/node_modules/.pnpm/quickjs-emscripten@0.32.0/node_modules/quickjs-emscripten/dist/chunk-OHAYRCBA.mjs',
    '/repo/node_modules/.pnpm/@jitl+quickjs-wasmfile-release-sync@0.32.0/node_modules/@jitl/quickjs-wasmfile-release-sync/dist/index.mjs',
    '/repo/packages/sandbox/src/quickjs-module.ts',
  ]) assert.equal(group.test.test(id), false, id);
});

/** The quickjs-emscripten-core the viewer bundles: the sandbox's quickjs-emscripten resolves it. */
function installedQuickjsCore(): { root: string; pkg: { sideEffects?: unknown; exports?: Record<string, Record<string, string>> } } {
  const sandbox = resolve(dirname(new URL(import.meta.url).pathname), '../../../../packages/sandbox/package.json');
  const viaWrapper = createRequire(createRequire(sandbox).resolve('quickjs-emscripten'));
  let root = dirname(viaWrapper.resolve('quickjs-emscripten-core'));
  while (!existsSync(join(root, 'package.json'))) root = dirname(root);
  return { root, pkg: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) };
}

// The split works only while the installed package keeps the shape the group
// was written against (#9200 review). An upgrade that drops `sideEffects`
// keeps the index's static import of the runtime, and one that renames,
// moves or inlines the runtime file gets past the file names above. Either
// would quietly put the ~34 KB runtime back on the boot path.
test('the installed QuickJS core still splits where the runtime group expects', () => {
  const group = (chunks as Record<string, unknown>).quickjsRuntimeChunkGroup as Group | undefined;
  assert.ok(group, 'vite-chunks must export quickjsRuntimeChunkGroup');
  const { root, pkg } = installedQuickjsCore();
  assert.equal(pkg.sideEffects, false, 'eager code reaches the index; only sideEffects:false lets its unused runtime import go');
  assert.equal(pkg.exports?.['.']?.import, './dist/index.mjs', 'the ESM entry is the index the group leaves to the sandbox');
  const dist = join(root, 'dist');
  // @source-text-assertion-ok lists the installed package's file names, not file text
  const modules = readdirSync(dist).filter((name) => name.endsWith('.mjs'));
  // @source-text-assertion-ok a file-name check on the installed package, not file text
  assert.ok(modules.includes('index.mjs'));
  for (const name of modules) {
    // @source-text-assertion-ok runs the chunk rule on real installed paths, not file text
    assert.equal(group.test.test(join(dist, name)), name !== 'index.mjs', `${name} ${name === 'index.mjs' ? 'stays with the sandbox' : 'is claimed by the runtime group'}`);
  }
  const size = (name: string) => statSync(join(dist, name)).size;
  const largest = modules.reduce((a, b) => (size(b) > size(a) ? b : a));
  assert.notEqual(largest, 'index.mjs', 'the runtime lives outside the index, in a file the group claims');
});

