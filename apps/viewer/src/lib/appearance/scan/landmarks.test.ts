/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Raycaster } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { sourceLandmark } from './landmarks';

// #4381: use the actual renderer ray/triangle contract, including A:w weights.
test('scan observations retain original triangle and barycentric scene coordinates across rebasing', () => {
  const mesh: MeshData = { expressId: 17, positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 8, 0]), indices: new Uint32Array([0, 1, 2]), normals: new Float32Array([0,0,1,0,0,1,0,0,1]), color: [1,1,1,1], origin: [1000000, 2000000, 30] };
  const local = { ...mesh, origin: [0,0,0] as [number,number,number] };
  const hit = new Raycaster().raycast({ origin: { x: 1, y: 4, z: 10 }, direction: { x: 0, y: 0, z: -1 } }, [local]);
  assert.ok(hit);
  const landmark = sourceLandmark(mesh, hit, 3);
  assert.deepEqual(landmark.point, [1000001, 2000004, 30]);
  assert.equal(landmark.kind, 'triangle');
  if (landmark.kind !== 'triangle') throw new Error('unreachable');
  assert.deepEqual(landmark.barycentric, [0.25, 0.25, 0.5]);
  assert.equal(landmark.triangle, 0);
  assert.match(landmark.observation, /^surface:3:triangle:0:bary:/);
  assert.deepEqual(Array.from(mesh.positions), [0,0,0,4,0,0,0,8,0]);
});
