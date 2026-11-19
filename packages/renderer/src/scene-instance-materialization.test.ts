/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `materializeShardOccurrences` must give a decoded shard's occurrences exactly
 * as the scene materializes the same shard after upload: released-geometry
 * readback (#10264) measures and exports them, so any transform, anchor or
 * selection drift would be a wrong answer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { DecodedInstancedShard, MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { materializeShardOccurrences } from './scene-instance-materialization.js';

(globalThis as Record<string, unknown>).GPUBufferUsage = { COPY_DST: 1, INDEX: 2, VERTEX: 4 };

function device(): GPUDevice {
  return {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30 },
    createBuffer: ({ size }: { size: number }) => {
      const bytes = new ArrayBuffer(size);
      return { size, getMappedRange: () => bytes, unmap() {}, destroy() {} };
    },
    queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
}

/** Two templates; a rotated + far-translated occurrence, a plain one, and a transparent one. */
function shard(): DecodedInstancedShard {
  const c = Math.cos(0.7), s = Math.sin(0.7);
  return {
    carriesItemIds: true,
    templates: [
      { positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 0, 0, 1]), normals: Float32Array.from([0, -1, 0, 0, -1, 0, 0, -1, 0]),
        indices: Uint32Array.from([0, 1, 2]), origin: [2_600_000.25, 1_200_000.5, 431.75] },
      { positions: Float32Array.from([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0]), normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 1, 3, 2]), origin: [0, 0, 0] },
    ],
    instances: [
      { templateIndex: 0, entityId: 11, itemId: 911, color: [0.2, 0.4, 0.6, 1],
        transform: Float32Array.from([c, -s, 0, 12.5, s, c, 0, -3.25, 0, 0, 1, 7, 0, 0, 0, 1]) },
      { templateIndex: 1, entityId: 12, color: [1, 1, 1, 1], transform: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
      { templateIndex: 1, entityId: 13, color: [1, 1, 1, 0.3], transform: Float32Array.from([1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) },
    ],
  };
}

const view = (m: MeshData) => ({ expressId: m.expressId, modelIndex: m.modelIndex, positions: [...m.positions], normals: [...m.normals],
  indices: [...m.indices], origin: m.origin, color: m.color, geometryItemId: m.geometryItemId,
  fenceIsIndices: m.appearanceSource?.indices === m.indices, sourceIsIndices: m.appearanceSource?.sourceIndices === m.indices });

describe('materializeShardOccurrences', () => {
  it('equals the scene materialization of the same uploaded shard, model-local and opaque only', () => {
    const scene = new Scene();
    scene.addInstancedShard(device(), shard(), 3);
    const fromScene = [11, 12, 13].flatMap((id) => scene.getInstancedMeshDataPieces(id) ?? []);
    const backed = materializeShardOccurrences(shard(), 3, 'readback:');
    assert.deepEqual(backed.map(view), fromScene.map(view));
    assert.equal(backed.some((m) => m.expressId === 13), false, 'transparent occurrences go the flat route, as on upload');
    assert.ok(backed.every((m) => m.occurrenceKey?.startsWith('readback:')), 'keys never collide with the scene cache');
    assert.equal(backed[0].geometryItemId, 911);
    assert.ok(Math.abs(backed[0].origin![0]) > 1e6, 'the f64 anchor is kept, not narrowed through the f32 matrix');
  });

  it('limits work to the wanted entities', () => {
    assert.deepEqual(materializeShardOccurrences(shard(), 0, 'k', (id) => id === 12).map((m) => m.expressId), [12]);
  });
});
