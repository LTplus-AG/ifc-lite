/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Scene } from './scene.js';
import type { MeshData } from '@ifc-lite/geometry';

/**
 * `removeMeshesForEntity` is GPU-buffer-agnostic on the data-
 * tracking side — meshDataMap, boundingBoxes, pendingBatchKeys.
 * We exercise those paths without a GPUDevice. The bucket re-batch
 * (which is GPU-bound) is exercised separately in browser tests.
 */

function makeMesh(expressId: number, positions = [0, 0, 0, 1, 1, 1]): MeshData {
  return {
    expressId,
    positions: new Float32Array(positions),
    normals: new Float32Array(positions),
    indices: new Uint32Array([0, 1, 2]),
    color: [0, 0, 0, 1],
    name: `mesh-${expressId}`,
  } as unknown as MeshData;
}

describe('Scene.removeMeshesForEntity', () => {
  it('returns false when no mesh exists for the entity', () => {
    const scene = new Scene();
    assert.strictEqual(scene.removeMeshesForEntity(123), false);
  });

  it('drops dedicated meshes from meshDataMap and returns true', () => {
    const scene = new Scene();
    const mesh = makeMesh(42);
    scene.addMeshData(mesh);
    // Pre-condition: the mesh is registered.
    assert.ok(scene['meshDataMap'].get(42));
    // A dedicated mesh (no per-vertex `entityIds`) counts as
    // removed even when it never made it into a bucket — the
    // bookkeeping side returns true so the bulk-count helper
    // matches the documented contract.
    assert.strictEqual(scene.removeMeshesForEntity(42), true);
    assert.strictEqual(scene['meshDataMap'].get(42), undefined);
  });

  it('clears the bounding-box cache for the entity', () => {
    const scene = new Scene();
    // Directly seed a bounding box (the lazy-compute paths need a
    // GPU device which we're avoiding here).
    scene['boundingBoxes'].set(99, {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
    });
    scene.addMeshData(makeMesh(99));
    scene.removeMeshesForEntity(99);
    assert.strictEqual(scene['boundingBoxes'].has(99), false);
  });

  it('leaves other entities alone', () => {
    const scene = new Scene();
    scene.addMeshData(makeMesh(1));
    scene.addMeshData(makeMesh(2));
    scene.removeMeshesForEntity(1);
    assert.strictEqual(scene['meshDataMap'].get(1), undefined);
    assert.ok(scene['meshDataMap'].get(2));
  });

  it('handles a color-merged mesh by keeping the geometry but de-registering the entity', () => {
    // Color-merged path: one MeshData hosts entityIds for many
    // entities. Removing one should not remove the shared mesh —
    // just stop the entity from being looked up.
    const scene = new Scene();
    const shared = {
      ...makeMesh(0),
      entityIds: new Uint32Array([10, 20, 30]),
    } as unknown as MeshData;
    scene.addMeshData(shared);
    // After addMeshData, all three entities map to the shared mesh.
    assert.ok(scene['meshDataMap'].get(10));
    assert.ok(scene['meshDataMap'].get(20));
    assert.ok(scene['meshDataMap'].get(30));
    scene.removeMeshesForEntity(20);
    // Entity 20 is forgotten; the others still see the mesh.
    assert.strictEqual(scene['meshDataMap'].get(20), undefined);
    assert.ok(scene['meshDataMap'].get(10));
    assert.ok(scene['meshDataMap'].get(30));
  });
});

describe('Scene.removeMeshesForEntities', () => {
  it('counts every entity with at least one dedicated mesh removed', () => {
    const scene = new Scene();
    scene.addMeshData(makeMesh(1));
    scene.addMeshData(makeMesh(2));
    // No mesh for 3 — should be skipped silently.
    const count = scene.removeMeshesForEntities([1, 2, 3]);
    assert.strictEqual(count, 2);
    assert.strictEqual(scene['meshDataMap'].get(1), undefined);
    assert.strictEqual(scene['meshDataMap'].get(2), undefined);
  });

  it('returns 0 for an empty input', () => {
    const scene = new Scene();
    assert.strictEqual(scene.removeMeshesForEntities([]), 0);
  });
});
