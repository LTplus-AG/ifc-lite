/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { PickingManager } from './picking-manager.ts';

describe('PickingManager', () => {
  it('uses raycast when geometry data was released after finalize', async () => {
    let raycastCalls = 0;
    let pickerCalls = 0;
    let meshCreations = 0;

    const camera = {
      unprojectToRay: () => ({
        origin: { x: 1, y: 2, z: 3 },
        direction: { x: 0, y: 0, z: -1 },
      }),
    };

    const scene = {
      getMeshes: () => [],
      getBatchedMeshes: () => [{ expressIds: [101] }],
      isGeometryDataReleased: () => true,
      raycast: () => {
        raycastCalls += 1;
        return { expressId: 101, modelIndex: 0 };
      },
    };

    const picker = {
      pick: async () => {
        pickerCalls += 1;
        return null;
      },
    };

    const canvas = {
      width: 100,
      height: 100,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    };

    const manager = new PickingManager(
      camera as never,
      scene as never,
      picker as never,
      canvas as HTMLCanvasElement,
      () => {
        meshCreations += 1;
      },
    );

    const result = await manager.pick(50, 50);

    assert.deepStrictEqual(result, { expressId: 101, modelIndex: 0 });
    assert.equal(raycastCalls, 1);
    assert.equal(pickerCalls, 0);
    assert.equal(meshCreations, 0);
  });

  // Regression for #1358: a door/window colour-fused into a batch keyed by its
  // host wall/opening must stay pickable under isolation. The filler's id lives
  // only in the per-vertex entityIds (and thus in the scene's mesh-data id set),
  // not in batch.expressIds — picking must hydrate it from the former.
  it('hydrates and picks a colour-merged filler (door) isolated under a host batch', async () => {
    const WALL = 200;
    const DOOR = 201; // fused into the wall batch; absent from batch.expressIds

    const camera = {
      unprojectToRay: () => ({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }),
      getViewProjMatrix: () => ({ m: new Float32Array(16) }),
    };

    const createdMeshes: Array<{ expressId: number; modelIndex?: number }> = [];
    let pickerMeshes: Array<{ expressId: number }> = [];

    const scene = {
      getMeshes: () => createdMeshes,
      // Batch only carries the PRIMARY expressId (the wall) — the door is fused in.
      getBatchedMeshes: () => [{ expressIds: [WALL] }],
      isGeometryDataReleased: () => false,
      // Authoritative pickable-id set DOES include the fused door (Scene.addMeshData
      // registers a merged mesh under every per-vertex entityId).
      getAllMeshDataExpressIds: () => [WALL, DOOR],
      getMeshDataPieces: (expressId: number) =>
        expressId === DOOR ? [{ expressId: DOOR }]
        : expressId === WALL ? [{ expressId: WALL }]
        : undefined,
      getInstancedTemplates: () => undefined,
      raycast: () => {
        throw new Error('should not fall back to CPU raycast for a single isolated filler');
      },
    };

    const picker = {
      pick: async (
        _x: number, _y: number, _w: number, _h: number,
        meshes: Array<{ expressId: number }>,
      ) => {
        pickerMeshes = meshes;
        const hit = meshes.find((m) => m.expressId === DOOR);
        return hit ? { expressId: DOOR, modelIndex: 0 } : null;
      },
    };

    const canvas = {
      width: 100,
      height: 100,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
    };

    const manager = new PickingManager(
      camera as never,
      scene as never,
      picker as never,
      canvas as HTMLCanvasElement,
      (piece) => {
        createdMeshes.push({ expressId: piece.expressId, modelIndex: piece.modelIndex });
      },
    );

    const result = await manager.pick(50, 50, { isolatedIds: new Set([DOOR]) });

    // The door mesh was hydrated and passed to the GPU picker, which returned it.
    assert.deepStrictEqual(result, { expressId: DOOR, modelIndex: 0 });
    assert.ok(
      createdMeshes.some((m) => m.expressId === DOOR),
      'expected the isolated door piece to be hydrated for picking',
    );
    assert.ok(
      pickerMeshes.every((m) => m.expressId === DOOR),
      'expected only the isolated door to survive the isolation filter',
    );
  });
});
