/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { PickingManager, type PointPickProvider } from './picking-manager.ts';
import type { PointPickNode } from './point-picker.ts';

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

  // Regression for #1904. pickRect used to pass scene.getMeshes() straight to
  // the GPU picker. On a batched model that list is empty or partial — batched
  // geometry never reaches the pick pass — so rectangle select returned an
  // empty set however many elements the rect covered. Reproduced by the
  // maintainer at 8 meshes / 3 batches, so this is not a large-model-only bug.
  describe('pickRect on batched geometry (#1904)', () => {
    const WALL = 300;
    const SLAB = 301;
    const POINT_ASSET = 900;

    /** Stand-in for Scene.getInstancedTemplates(); identity is all the tests read. */
    const INSTANCED_TEMPLATES = [{ instanceCount: 2 }];

    /** A pickable point-cloud asset with no chunks — nothing here draws. */
    const pointNode = (expressId: number): PointPickNode => ({ expressId, chunks: [] });

    function harness(overrides: {
      released?: boolean;
      existingMeshes?: Array<{ expressId: number }>;
      pieces?: (id: number) => Array<{ expressId: number }> | undefined;
      pointNodes?: PointPickNode[] | null;
      /** When set, the picker rejects with this instead of returning hits. */
      pointPassError?: Error;
    } = {}) {
      const createdMeshes: Array<{ expressId: number }> = [
        ...(overrides.existingMeshes ?? []),
      ];
      let pickerRectMeshes: Array<{ expressId: number }> | null = null;
      let pickerRectTemplates: unknown = 'not called';
      let pickerRectPointNodes: unknown = 'not called';
      let selectRectCalls = 0;

      const camera = {
        getViewProjMatrix: () => ({ m: new Float32Array(16) }),
        unprojectToRay: () => ({ origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 } }),
      };

      const scene = {
        getMeshes: () => createdMeshes,
        getBatchedMeshes: () => [{ expressIds: [WALL] }],
        isGeometryDataReleased: () => overrides.released ?? false,
        getAllMeshDataExpressIds: () => [WALL, SLAB],
        getMeshDataPieces:
          overrides.pieces ?? ((id: number) => [{ expressId: id }]),
        getInstancedTemplates: () => INSTANCED_TEMPLATES,
        selectRect: () => {
          selectRectCalls += 1;
          return new Set([WALL, SLAB]);
        },
      };

      const picker = {
        pickRect: async (
          _x0: number, _y0: number, _x1: number, _y1: number,
          _w: number, _h: number,
          meshes: Array<{ expressId: number }>,
          _viewProj: Float32Array,
          pointNodes: Array<{ expressId: number }> | undefined,
          _pointSizing: unknown,
          instancedTemplates: unknown,
        ) => {
          pickerRectMeshes = meshes;
          pickerRectPointNodes = pointNodes;
          pickerRectTemplates = instancedTemplates;
          if (overrides.pointPassError) throw overrides.pointPassError;
          // Mirrors the real picker: mesh samples resolve through the mesh list,
          // point samples carry the asset's federated id directly.
          const ids = new Set(meshes.map((m) => m.expressId));
          for (const node of pointNodes ?? []) ids.add(node.expressId);
          return ids;
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
        (piece) => { createdMeshes.push({ expressId: piece.expressId }); },
      );

      if (overrides.pointNodes !== undefined) {
        const nodes = overrides.pointNodes;
        const provider: PointPickProvider = nodes === null
          ? () => null
          : () => ({ nodes, sizing: { sizeMode: 0, worldRadius: 0.02, pointSizePx: 4 } });
        manager.setPointPickProvider(provider);
      }

      return {
        manager,
        createdMeshes,
        get pickerRectMeshes() { return pickerRectMeshes; },
        get pickerRectPointNodes() { return pickerRectPointNodes; },
        get pickerRectTemplates() { return pickerRectTemplates; },
        get selectRectCalls() { return selectRectCalls; },
      };
    }

    it('hydrates batched pieces so the rect pass can see them', async () => {
      const h = harness();

      const result = await h.manager.pickRect(0, 0, 100, 100);

      assert.deepStrictEqual(
        result,
        new Set([WALL, SLAB]),
        'rect select must return the batched entities, not an empty set',
      );
      assert.deepStrictEqual(
        h.createdMeshes.map((m) => m.expressId).sort(),
        [WALL, SLAB],
        'expected both batched pieces to be hydrated for the rect pass',
      );
      assert.equal(h.selectRectCalls, 0, 'small model should use the GPU path, not the CPU fallback');
    });

    it('falls back to Scene.selectRect once geometry data is released', async () => {
      const h = harness({ released: true });

      const result = await h.manager.pickRect(0, 0, 100, 100);

      assert.deepStrictEqual(result, new Set([WALL, SLAB]));
      assert.equal(h.selectRectCalls, 1, 'released geometry has no mesh data to hydrate');
      assert.equal(h.createdMeshes.length, 0, 'must not try to hydrate released geometry');
      assert.equal(h.pickerRectMeshes, null, 'GPU rect pass must be skipped entirely');
    });

    it('falls back to Scene.selectRect when hydration would exceed the pick-mesh budget', async () => {
      // 600 pieces for one entity blows MAX_PICK_MESH_CREATION (500), which is
      // the large-model case named in the issue title.
      const many = Array.from({ length: 600 }, () => ({ expressId: WALL }));
      const h = harness({ pieces: (id) => (id === WALL ? many : [{ expressId: id }]) });

      const result = await h.manager.pickRect(0, 0, 100, 100);

      assert.deepStrictEqual(result, new Set([WALL, SLAB]));
      assert.equal(h.selectRectCalls, 1, 'over-budget hydration must take the CPU path');
      assert.equal(h.createdMeshes.length, 0, 'must not hydrate when over budget');
    });

    it('honours isolation when falling back to the CPU path', async () => {
      const h = harness({ released: true });

      await h.manager.pickRect(0, 0, 100, 100, { isolatedIds: new Set([SLAB]) });

      assert.equal(h.selectRectCalls, 1);
    });

    // Point splats render into the pick pass on their own — they never depend
    // on per-element mesh hydration — so a mixed scene (batched IFC + point
    // cloud) that misses the pick-mesh budget must still select points. The CPU
    // fallback returning only Scene.selectRect would drop them. (#1904)
    it('unions point-cloud hits into the CPU fallback result', async () => {
      const h = harness({ released: true, pointNodes: [pointNode(POINT_ASSET)] });

      const result = await h.manager.pickRect(0, 0, 100, 100);

      assert.equal(h.selectRectCalls, 1, 'released geometry must still take the CPU path');
      assert.equal(h.createdMeshes.length, 0, 'must not hydrate released geometry');
      assert.deepStrictEqual(
        result,
        new Set([WALL, SLAB, POINT_ASSET]),
        'rect select over a point cloud must return its points as well as the boxed entities',
      );
    });

    // Pins the two arguments the CPU-branch point pass deliberately withholds.
    // Instanced templates in particular: the instanced pick shader DOES discard
    // hidden/non-isolated occurrences (picker.ts checks instFlags bit 1, which
    // Scene sets for both), so passing them would be safe — it is withheld
    // because Scene.selectRect already returns every instanced occurrence that
    // has geometry, from its registered world AABB, so the draw adds no id while
    // sharing the pass's depth buffer, where it could occlude a splat and REMOVE
    // a point hit. (#1904)
    it('runs the CPU point pass with no meshes and no instanced templates', async () => {
      const h = harness({ released: true, pointNodes: [pointNode(POINT_ASSET)] });

      await h.manager.pickRect(0, 0, 100, 100);

      assert.deepStrictEqual(
        h.pickerRectMeshes, [],
        'the CPU branch runs because meshes are not hydrated; a partial list would only duplicate selectRect',
      );
      assert.equal(
        h.pickerRectTemplates, undefined,
        'instanced occurrences already come back from selectRect, so drawing them could only occlude points',
      );
      assert.deepStrictEqual(h.pickerRectPointNodes, [pointNode(POINT_ASSET)]);
    });

    it('keeps the pure-CPU fast path when there are no splats to pick (#1904)', async () => {
      const noProvider = harness({ released: true });
      const nullSnapshot = harness({ released: true, pointNodes: null });
      const emptySnapshot = harness({ released: true, pointNodes: [] });

      for (const h of [noProvider, nullSnapshot, emptySnapshot]) {
        const result = await h.manager.pickRect(0, 0, 100, 100);
        assert.deepStrictEqual(result, new Set([WALL, SLAB]));
        assert.equal(h.pickerRectMeshes, null, 'no points to draw means no GPU pass at all');
      }
    });

    // Picker.pickRect rethrows any readback failure that is not a device-loss
    // abort. Adding the point pass put that throw in front of a result the CPU
    // branch had already computed, so a device fault would have turned a working
    // rectangle select into a rejected promise. Degrade to the box hits. (#1904)
    it('degrades to the bounding-box hits when the point pass throws', async () => {
      const h = harness({
        released: true,
        pointNodes: [pointNode(POINT_ASSET)],
        pointPassError: new Error('readback failed'),
      });

      const warnings: unknown[][] = [];
      const realWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args); };
      let result: Set<number>;
      try {
        result = await h.manager.pickRect(0, 0, 100, 100);
      } finally {
        console.warn = realWarn;
      }

      assert.deepStrictEqual(
        result, new Set([WALL, SLAB]),
        'a failed point pass must not discard the bounding-box hits already computed',
      );
      assert.equal(warnings.length, 1, 'the failure must be logged, not swallowed');
    });
  });
});
