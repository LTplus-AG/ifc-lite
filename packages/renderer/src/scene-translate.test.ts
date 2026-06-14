/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * `translateMeshesForEntity` mutates mesh positions in place (the GPU re-upload
 * paths are guarded by a device we don't supply here), so the move logic is
 * exercised CPU-side. The key contract: move a single-entity mesh (incl. an
 * authored one that tags every vertex with its own id for picking), but never a
 * genuine colour-merge shared by other entities.
 */

function mesh(
  expressId: number,
  positions: number[],
  entityIds?: number[],
): MeshData {
  return {
    expressId,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions),
    indices: new Uint32Array([0, 1, 2]),
    color: [0, 0, 0, 1],
    name: `mesh-${expressId}`,
    ...(entityIds ? { entityIds: new Uint32Array(entityIds) } : {}),
  } as unknown as MeshData;
}

describe('Scene.translateMeshesForEntity', () => {
  it('moves a dedicated mesh with no entityIds (parsed single-entity)', () => {
    const scene = new Scene();
    const m = mesh(5, [0, 0, 0, 1, 1, 1]);
    scene.addMeshData(m);
    assert.strictEqual(scene.translateMeshesForEntity(5, [0, 5, 0]), true);
    assert.strictEqual(m.positions[1], 5);
    assert.strictEqual(m.positions[4], 6);
  });

  it('moves an authored single-entity mesh (every vertex tagged with its own id)', () => {
    const scene = new Scene();
    // buildPolygonExtrusion does entityIds.fill(globalId) — all the same id.
    const m = mesh(7, [0, 0, 0, 1, 0, 0, 0, 1, 0], [7, 7, 7]);
    scene.addMeshData(m);
    assert.strictEqual(scene.translateMeshesForEntity(7, [10, 0, 0]), true, 'single-entity mesh translates');
    assert.strictEqual(m.positions[0], 10);
    assert.strictEqual(m.positions[3], 11);
  });

  it('skips a genuine colour-merged mesh shared by other entities', () => {
    const scene = new Scene();
    // Vertices belong to entities 7 AND 8 — moving 7 must not drag the merge.
    const m = mesh(7, [0, 0, 0, 1, 0, 0, 0, 1, 0], [7, 7, 8]);
    scene.addMeshData(m); // registered under both 7 and 8
    assert.strictEqual(scene.translateMeshesForEntity(7, [10, 0, 0]), false, 'shared merge is not moved');
    assert.strictEqual(m.positions[0], 0, 'positions unchanged');
  });

  it('returns false when the entity has no mesh', () => {
    const scene = new Scene();
    assert.strictEqual(scene.translateMeshesForEntity(999, [1, 0, 0]), false);
  });

  it('evicts the entity\'s stale selection-highlight meshes on move (no ghost)', () => {
    const scene = new Scene();
    scene.addMeshData(mesh(7, [0, 0, 0, 1, 0, 0, 0, 1, 0]));
    // A standalone highlight mesh (frozen copy made at selection time) lives in
    // scene.meshes and would otherwise linger at the old position after a move.
    let destroyed = false;
    const stub = () => ({ destroy: () => { destroyed = true; } });
    const sceneMeshes = scene as unknown as { meshes: unknown[] };
    sceneMeshes.meshes.push({ expressId: 7, vertexBuffer: stub(), indexBuffer: stub() });
    sceneMeshes.meshes.push({ expressId: 99, vertexBuffer: { destroy() {} }, indexBuffer: { destroy() {} } });

    scene.translateMeshesForEntity(7, [5, 0, 0]);

    assert.strictEqual(sceneMeshes.meshes.length, 1, 'entity 7 highlight evicted, other kept');
    assert.strictEqual((sceneMeshes.meshes[0] as { expressId: number }).expressId, 99);
    assert.strictEqual(destroyed, true, 'evicted highlight GPU buffers were freed');
  });
});
