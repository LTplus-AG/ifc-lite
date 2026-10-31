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
