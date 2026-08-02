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

/**
 * GPU-instanced occurrences live in the per-template instance buffers, not
 * meshDataMap, so the flat translate can't reach them. `translateInstancedEntity`
 * lifts them with their storey in Exploded mode (#1289). The GPU writeBuffer is
 * guarded by a cached device we don't supply, so the matrix math is exercised
 * CPU-side via the instance record + the lazily-materialized occurrence MeshData.
 */
const INSTANCE_STRIDE = 88; // mirrors INSTANCE_STRIDE_BYTES

interface InstancedTestState {
  instancedEntityMap: Map<number, { templateIndex: number; byteOffset: number; originalColor: number[] }[]>;
  instancedTemplateCpu: {
    positions: Float32Array; normals: Float32Array; indices: Uint32Array;
    instanceData: ArrayBuffer; localMin: number[]; localMax: number[];
  }[];
  instancedTemplates: unknown[];
  boundingBoxes: Map<number, { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>;
}

/** Inject one instanced template (a unit triangle) with one occurrence of
 *  `expressId` at world translation `t`, plus its cached world AABB. */
function injectInstanced(scene: Scene, expressId: number, t: [number, number, number]): DataView {
  const instanceData = new ArrayBuffer(INSTANCE_STRIDE);
  const dv = new DataView(instanceData);
  // Identity upper-3x3 (col-major: m0, m5, m10, m15 = 1).
  dv.setFloat32(0, 1, true); dv.setFloat32(20, 1, true); dv.setFloat32(40, 1, true); dv.setFloat32(60, 1, true);
  // Translation column (m12, m13, m14) at +48/+52/+56.
  dv.setFloat32(48, t[0], true); dv.setFloat32(52, t[1], true); dv.setFloat32(56, t[2], true);

  const s = scene as unknown as InstancedTestState;
  s.instancedTemplateCpu = [{
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    instanceData,
    localMin: [0, 0, 0], localMax: [1, 1, 0],
  }];
  s.instancedTemplates = []; // no GPU buffer => writeBuffer path skipped
  s.instancedEntityMap = new Map([[expressId, [{ templateIndex: 0, byteOffset: 0, originalColor: [1, 1, 1, 1] }]]]);
  s.boundingBoxes = new Map([[expressId, {
    min: { x: t[0], y: t[1], z: t[2] }, max: { x: t[0] + 1, y: t[1] + 1, z: t[2] },
  }]]);
  return dv;
}

describe('Scene.translateInstancedEntity', () => {
  it('lifts an instanced occurrence: instance matrix, AABB, and materialized geometry', () => {
    const scene = new Scene();
    const dv = injectInstanced(scene, 42, [0, 0, 0]);

    assert.strictEqual(scene.translateInstancedEntity(42, [0, 5, 0]), true);

    // Instance record translation column updated in place.
    assert.strictEqual(dv.getFloat32(48, true), 0, 'x translation unchanged');
    assert.strictEqual(dv.getFloat32(52, true), 5, 'y translation += 5');
    assert.strictEqual(dv.getFloat32(56, true), 0, 'z translation unchanged');

    // Cached world AABB shifted by the same delta (no recompute).
    const bbox = (scene as unknown as InstancedTestState).boundingBoxes.get(42)!;
    assert.strictEqual(bbox.min.y, 5);
    assert.strictEqual(bbox.max.y, 6);

    // Lazily-materialized occurrence geometry reflects the lift.
    const pieces = scene.getInstancedMeshDataPieces(42)!;
    assert.ok(pieces && pieces.length === 1);
    assert.strictEqual(pieces[0].positions[1], 5, 'first vertex y lifted by 5');
  });

  it('the public translateMeshesForEntity moves an instanced-only entity', () => {
    const scene = new Scene();
    injectInstanced(scene, 7, [0, 0, 0]);
    // No flat mesh for id 7 — the move must still succeed via the instanced path.
    assert.strictEqual(scene.translateMeshesForEntity(7, [0, 4, 0]), true);
    assert.strictEqual(scene.getInstancedMeshDataPieces(7)![0].positions[1], 4);
  });

  it('is reversible (Exploded -> Stacked subtracts the same delta)', () => {
    const scene = new Scene();
    const dv = injectInstanced(scene, 9, [2, 0, 0]);
    scene.translateInstancedEntity(9, [0, 8, 0]);
    scene.translateInstancedEntity(9, [0, -8, 0]);
    assert.strictEqual(dv.getFloat32(48, true), 2, 'x restored');
    assert.strictEqual(dv.getFloat32(52, true), 0, 'y restored to native');
  });

  it('returns false for a non-instanced id and for a zero delta', () => {
    const scene = new Scene();
    injectInstanced(scene, 5, [0, 0, 0]);
    assert.strictEqual(scene.translateInstancedEntity(404, [0, 5, 0]), false, 'unknown id');
    assert.strictEqual(scene.translateInstancedEntity(5, [0, 0, 0]), false, 'zero delta');
  });

  it('keeps instanced bounds after a mixed flat+instanced move (no stranded null)', () => {
    const scene = new Scene();
    // Same expressId has BOTH an instanced occurrence and a flat mesh. The flat
    // translate deletes the cached AABB; the instanced pass must rebuild it so a
    // later bounds query is non-null (Codex review of #1289).
    injectInstanced(scene, 7, [0, 0, 0]);
    scene.addMeshData(mesh(7, [0, 0, 0, 1, 1, 1]));

    assert.strictEqual(scene.translateMeshesForEntity(7, [0, 5, 0]), true);

    const bounds = scene.getInstancedEntityBounds(7);
    assert.ok(bounds, 'instanced bounds are not stranded to null');
    assert.strictEqual(bounds!.min.y, 5, 'instanced bounds reflect the lift');
    assert.strictEqual(bounds!.max.y, 6);
  });
});
