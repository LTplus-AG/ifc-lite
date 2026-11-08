/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
