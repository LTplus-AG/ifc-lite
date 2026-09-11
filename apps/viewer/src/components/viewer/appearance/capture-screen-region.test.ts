/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { capturedScreenRegion } from './capture-screen-region';
const mesh: MeshData = { expressId: 10, color: [1,1,1,1], normals: new Float32Array(27),
  positions: new Float32Array([0,0,0, 3,0,0, 0,3,0, 0,0,4, 3,0,4, 0,3,4, 10,0,0, 13,0,0, 10,3,0]),
  indices: new Uint32Array([0,1,2,3,4,5,6,7,8]) };

test('capture marquee retains complete source triangle ordinals through depth, independent of drag direction (#4380)', () => {
  const project = (p: { x: number; y: number }) => p;
  assert.deepEqual(capturedScreenRegion(mesh,{x:0,y:0},{x:2,y:2},project),[0,1]);
  assert.deepEqual(capturedScreenRegion(mesh,{x:2,y:2},{x:0,y:0},project),[0,1]);
  assert.deepEqual([...mesh.indices],[0,1,2,3,4,5,6,7,8]);
});

test('capture marquee uses triangle centres rather than inventing geometric cuts (#4380)', () => {
  assert.deepEqual(capturedScreenRegion(mesh,{x:0,y:0},{x:.5,y:.5},p=>p),[]);
  assert.deepEqual(capturedScreenRegion(mesh,{x:0,y:0},{x:2,y:2},p=>p.z>0?null:p),[0]);
  assert.throws(()=>capturedScreenRegion(mesh,{x:NaN,y:0},{x:2,y:2},p=>p),/finite/);
});
