/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 8, INDEX: 16, VERTEX: 32 };

const device = {
  limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
  createBuffer: (desc: GPUBufferDescriptor) => {
    const data = new ArrayBuffer(desc.size);
    return { size: desc.size, getMappedRange: () => data, unmap() {}, destroy() {} } as unknown as GPUBuffer;
  },
  queue: { writeBuffer: () => {} },
} as unknown as GPUDevice;

function triangle(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  } as unknown as MeshData;
}

/** Three flat entities (1, 2, 3) plus two GPU-instanced-only occurrences (41, 42). */
function scene(): Scene {
  const s = new Scene();
  for (const id of [1, 2, 3]) s.addMeshData(triangle(id));
  const shard: DecodedInstancedShard = {
    carriesItemIds: false,
    templates: [{
      positions: new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      origin: [0, 0, 0],
    }],
    instances: [41, 42].map((entityId, index) => ({
      templateIndex: 0, entityId, color: [0.4, 0.5, 0.6, 1],
      transform: new Float32Array([1, 0, 0, index * 5, 0, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 1]),
    })),
  };
  s.addInstancedShard(device, shard, 0);
  return s;
}

// The pick-mesh budget reads this count on every hover pick (#6392): it must
// count what a pick would hydrate — entities with mesh data that are visible —
// and nothing else.
describe('Scene.visibleMeshDataEntitiesExceed (#6392)', () => {
  it('counts flat entities with mesh data, not instanced-only occurrences', () => {
    const s = scene();
    assert.ok(s.getAllMeshDataExpressIds().includes(41), 'fixture: 41 is pickable via instancing');
    assert.equal(s.visibleMeshDataEntitiesExceed(2), true);
    assert.equal(s.visibleMeshDataEntitiesExceed(3), false, 'the two instanced occurrences have no pieces to hydrate');
  });

  it('leaves hidden entities out', () => {
    assert.equal(scene().visibleMeshDataEntitiesExceed(2, new Set([1])), false);
  });

  it('counts only isolated entities under isolation', () => {
    const s = scene();
    assert.equal(s.visibleMeshDataEntitiesExceed(1, null, new Set([1, 41])), false);
    assert.equal(s.visibleMeshDataEntitiesExceed(1, null, new Set([1, 2])), true);
  });
});
