/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Scene } from './scene.js';
import type { MeshData } from '@ifc-lite/geometry';
import { TriangleCounts } from './triangle-counts.js';

it('counts split and merged indexed faces under their original objects (#10370)', () => {
  const counts = new TriangleCounts();
  const triangle = new Uint32Array([0, 1, 2]);
  counts.addMesh({ expressId: 7, indices: triangle });
  counts.addMesh({ expressId: 7, indices: triangle });
  counts.addMesh({ expressId: 999, indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
    entityIds: new Uint32Array([7, 7, 7, 8, 8, 8]) });
  assert.equal(counts.byEntity.get(7), 3);
  assert.equal(counts.byEntity.get(8), 1);
  assert.equal(counts.byEntity.has(999), false);
  assert.equal(counts.total, 4);
});

it('counts each template occurrence and combines flat and instanced pieces (#10370)', () => {
  const counts = new TriangleCounts();
  const template = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), origin: [0, 0, 0] as [number, number, number] };
  const occurrence = (entityId: number) => ({ entityId, templateIndex: 0,
    color: [1, 1, 1, 1] as [number, number, number, number], transform: new Float32Array(16) });
  counts.addInstancedShard({ templates: [template], instances: [occurrence(7), occurrence(8), occurrence(8)] });
  counts.addMesh({ expressId: 7, indices: template.indices });
  assert.equal(counts.byEntity.get(7), 2);
  assert.equal(counts.byEntity.get(8), 2);
  assert.equal(counts.total, 4, 'one template used three times contributes three faces');
});

function sourceTriangle(expressId: number): MeshData {
  return { expressId, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] };
}

it('keeps source counts across CPU release, deletion and a new scene (#10370)', () => {
  const scene = new Scene();
  const mesh = sourceTriangle(7);
  scene.queueMeshes([mesh, sourceTriangle(8)]);
  scene.addMeshData(mesh);
  assert.equal(scene.getTriangleCounts()?.get(7), 1);
  scene.releaseGeometryData();
  assert.equal(scene.getTriangleCounts()?.get(7), 1, 'releasing vertices does not erase compact source metadata');
  scene.removeMeshesForEntity(7);
  assert.equal(scene.getTriangleCounts()?.has(7), false);
  assert.equal(scene.getTriangleCounts()?.get(8), 1);
  scene.clearFlatGeometry();
  assert.equal(scene.getTriangleCounts()?.size, 0, 'a reset cannot reuse the previous model counts');
  scene.queueMeshes([sourceTriangle(7), sourceTriangle(7)]);
  assert.equal(scene.getTriangleCounts()?.get(7), 2, 'new geometry under a reused ID has its own count');
});
