/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Intersection } from '@ifc-lite/renderer';
import { pickViewportAppearanceFace, registerViewportFacePicker } from './viewport-face-picker.js';

const hit = (changes: Partial<Intersection> = {}): Intersection => ({
  point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, distance: 1,
  meshIndex: 0, triangleIndex: 0, expressId: 1_025, modelIndex: 1,
  geometryItemId: 1_011, sourceTriangleIndex: 7,
  barycentricCoord: { u: 0.2, v: 0.3, w: 0.5 }, ...changes,
});

test('viewport face picker requires the exact federated owner, item and canonical triangle (#4555)', () => {
  const picked: number[] = [];
  const release = registerViewportFacePicker({ globalId: 1_025, modelIndex: 1,
    geometryItemIds: new Set([1_011, 1_101, 1_102]), triangleCount: 12,
    canPick: () => true, onToggle: triangle => picked.push(triangle) });
  assert.equal(pickViewportAppearanceFace(hit()), 'picked');
  assert.equal(pickViewportAppearanceFace(hit({ geometryItemId: 1_102, sourceTriangleIndex: 11 })), 'picked',
    'another rendered part of the same canonical surface remains pickable');
  assert.equal(pickViewportAppearanceFace(hit({ expressId: 25, modelIndex: 0, geometryItemId: 11 })),
    'different-surface', 'the same local ids in another model cannot cross-select');
  assert.equal(pickViewportAppearanceFace(hit({ geometryItemId: 9_999 })), 'ambiguous');
  assert.equal(pickViewportAppearanceFace(hit({ sourceTriangleIndex: undefined })), 'ambiguous');
  assert.equal(pickViewportAppearanceFace(hit({ sourceTriangleIndex: 12 })), 'ambiguous');
  assert.equal(pickViewportAppearanceFace(null), 'miss');
  assert.deepEqual(picked, [7, 11]);
  release();
  assert.equal(pickViewportAppearanceFace(hit()), 'inactive');
});
