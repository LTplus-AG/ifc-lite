/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { Scene } from './scene.js';
import { collectLaneDraws, lineMeetsBox, refineLaneHit, type LaneRouteScene, type Ray } from './pick-lane-route.js';
import type { BatchedMesh } from './types.js';

const DOWN: Ray = { origin: { x: 0.5, y: 10, z: 0.5 }, direction: { x: 0, y: -1, z: 0 } };

/** A unit square at height `y`, in the XZ plane under DOWN. */
function square(expressId: number, y: number, extra: Partial<MeshData> = {}): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, y, 0, 1, y, 0, 1, y, 1, 0, y, 1]),
    normals: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    color: [1, 1, 1, 1],
    ...extra,
  };
}

function batch(expressIds: number[], fields: Partial<BatchedMesh> = {}): BatchedMesh {
  return {
    id: 1, colorKey: 'k', vertexBuffer: {} as GPUBuffer, indexBuffer: {} as GPUBuffer, indexCount: 6,
    color: [1, 1, 1, 1], expressIds, ...fields,
  };
}

function laneScene(batches: BatchedMesh[], state: { pending?: boolean } = {}): LaneRouteScene {
  const scene = new Scene();
  scene.getBatchedMeshes = () => batches;
  scene.hasPendingBatches = () => state.pending ?? false;
  return scene;
}

describe('batch pick route (#10264 S1)', () => {
  it('meets boxes along the whole line, including behind an orthographic ray origin', () => {
    const box = { min: [0, 0, 0], max: [1, 1, 1] };
    assert.equal(lineMeetsBox(DOWN, box), true);
    assert.equal(lineMeetsBox({ origin: { x: 0.5, y: -10, z: 0.5 }, direction: DOWN.direction }, box), true, 'box behind the origin');
    assert.equal(lineMeetsBox({ origin: { x: 3, y: 10, z: 0.5 }, direction: DOWN.direction }, box), false);
    assert.equal(lineMeetsBox({ origin: { x: 1.0005, y: 10, z: 0.5 }, direction: DOWN.direction }, box), true, 'margin covers f32 edges');
  });

  it('draws only the batches the ray meets, with their layout, origin and lane anchor', () => {
    const hit = batch([0x01000005, 0x01000009], { bounds: { min: [0, 0, 0], max: [1, 1, 1] }, origin: [10, 0, 0] });
    const quantized = batch([3], { bounds: { min: [0, -1, 0], max: [1, 0, 1] }, quantized: { min: [0, 0, 0], step: 1 / 1024 } });
    const away = batch([4], { bounds: { min: [5, 0, 5], max: [6, 1, 6] } });
    const unbounded = batch([5]);
    const draws = collectLaneDraws(laneScene([hit, quantized, away, unbounded]), DOWN);
    assert.deepEqual(draws?.map((d) => [d.layout, d.anchor, d.origin]), [
      ['flat', 0x01000005, [10, 0, 0]],
      ['quantized', 3, [0, 0, 0]],
      ['flat', 5, [0, 0, 0]],
    ]);
    assert.equal(collectLaneDraws(laneScene([hit, away]), null)?.length, 2, 'a marquee draws every batch');
  });

  // Never a partial GPU answer (the batch's elements would silently vanish from the pick).
  it('refuses the route when a needed batch cannot be drawn or resolved', () => {
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    assert.equal(collectLaneDraws(laneScene([batch([1], { bounds, gpuResident: false })]), DOWN), null, 'evicted');
    assert.equal(collectLaneDraws(laneScene([batch([1], { bounds })], { pending: true }), DOWN), null, 'pending rebuild');
    assert.equal(collectLaneDraws(laneScene([batch([1, 0x01000001], { bounds })]), DOWN), null, 'ids span two 2^24 pages');
    assert.equal(collectLaneDraws(laneScene([batch([0x3FFFFFF0], { bounds })]), DOWN), null, 'ids past the 30-bit sample');
    assert.deepEqual(collectLaneDraws(laneScene([batch([1], { bounds: { min: [5, 0, 5], max: [6, 1, 6] }, gpuResident: false })]), DOWN), [],
      'an evicted batch the ray cannot meet does not matter');
  });

  it('refines a lane hit to the nearest piece of that entity: model and item, GPU point kept', () => {
    const scene = new Scene();
    scene.addMeshData(square(7, 1, { modelIndex: 2, geometryItemId: 71 }));
    scene.addMeshData(square(7, 3, { modelIndex: 2, geometryItemId: 72 }));
    const world = { x: 0.5, y: 3, z: 0.5 };
    assert.deepEqual(refineLaneHit(scene, { expressId: 7, modelIndex: undefined, worldXYZ: world }, DOWN, undefined, null),
      { expressId: 7, modelIndex: 2, worldXYZ: world, geometryItemId: 72 });
    // Under a section plane that cuts the upper piece the visible item is the lower one.
    const clip = { sectionPlane: { normal: [0, 1, 0] as [number, number, number], distance: 2, flipped: false } };
    assert.equal(refineLaneHit(scene, { expressId: 7 }, DOWN, undefined, clip).geometryItemId, 71);
  });

  it('applies the shared item rule: a colour-merged piece reports no item', () => {
    const scene = new Scene();
    const merged = square(8, 1, { geometryItemId: 80, entityIds: new Uint32Array([8, 8, 9, 9]) });
    scene.addMeshData(merged);
    const result = refineLaneHit(scene, { expressId: 8 }, DOWN, undefined, null);
    assert.equal('geometryItemId' in result, false);
  });

  it('falls back to what all pieces agree on when the narrow raycast misses', () => {
    const scene = new Scene();
    scene.addMeshData(square(5, 1, { modelIndex: 1, geometryItemId: 50 }));
    const miss: Ray = { origin: { x: 2, y: 10, z: 2 }, direction: DOWN.direction };
    assert.deepEqual(refineLaneHit(scene, { expressId: 5 }, miss, undefined, null), { expressId: 5, modelIndex: 1, geometryItemId: 50 });
    scene.addMeshData(square(5, 2, { modelIndex: 1, geometryItemId: 51 }));
    assert.deepEqual(refineLaneHit(scene, { expressId: 5 }, miss, undefined, null), { expressId: 5, modelIndex: 1 },
      'two items and no hit: the entity only, never a guess');
  });

  it('reports entity and model only when the CPU geometry is gone', () => {
    const scene = new Scene();
    scene.getBatchedMeshes = () => [batch([4, 6], { modelIndices: [0, 3] })];
    assert.deepEqual(refineLaneHit(scene, { expressId: 6 }, DOWN, undefined, null), { expressId: 6, modelIndex: 3 });
    assert.deepEqual(refineLaneHit(scene, { expressId: 11 }, DOWN, undefined, null), { expressId: 11 });
  });
});
