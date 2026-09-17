/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from './dataSlice.js';
import { DATA_DEFAULTS } from '../constants.js';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { FederatedModel } from '../types.js';
import { capturePreAlignment, restorePreAlignment } from '../../hooks/ingest/federationRealign.js';

type DataTestState = DataSlice & DataCrossSliceState;

// Mock mesh data for testing
const createMockMesh = (expressId: number, color: [number, number, number, number] = [1, 0, 0, 1]) => ({
  expressId,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  color,
  ifcType: 'IfcWall',
});

// Deliberately asymmetric mesh sizes (vertex count != triangle count, and
// every mesh a different size) so a wrong field, a wrong /3 divisor, or an
// accidental double-subtract shows up as a mismatched number rather than
// hiding behind a coincidental round or symmetric total.
const createSizedMesh = (expressId: number, vertexCount: number, triangleCount: number) => ({
  expressId,
  positions: new Float32Array(vertexCount * 3),
  indices: new Uint32Array(triangleCount * 3),
  normals: new Float32Array(vertexCount * 3),
  color: [1, 0, 0, 1] as [number, number, number, number],
  ifcType: 'IfcWall',
});

type TestSetState = (
  partial:
    | Partial<DataTestState>
    | ((state: DataTestState) => Partial<DataTestState>),
) => void;
type TestGetState = () => DataTestState;

const ACTIVE_MODEL_ID = 'active-model';

describe('DataSlice', () => {
  let state: DataTestState;
  let setState: TestSetState;

  beforeEach(() => {
    setState = (partial) => {
      if (typeof partial === 'function') {
        const updates = partial(state);
        state = { ...state, ...updates };
      } else {
        state = { ...state, ...partial };
      }
    };

    const getState: TestGetState = () => state;

    // Seed the cross-slice fields owned by ModelSlice. dataSlice's
    // updaters look up the active model in this map, so the test mock
    // has to provide it for the typed StateCreator to be satisfiable.
    const slice = createDataSlice(
      setState as Parameters<typeof createDataSlice>[0],
      getState as Parameters<typeof createDataSlice>[1],
      undefined as unknown as Parameters<typeof createDataSlice>[2],
    );
    // `appendGeometryBatch` requires an owning modelId and only mirrors into
    // the top-level `geometryResult` when that id is the active model — most
    // of this suite isn't testing federation routing, so it exercises the
    // active-model path via ACTIVE_MODEL_ID.
    state = { ...slice, activeModelId: ACTIVE_MODEL_ID, models: new Map() };
  });

  describe('appendGeometryBatch', () => {
    it('should create new geometry result when none exists', () => {
      const meshes = [createMockMesh(1), createMockMesh(2)];
      state.appendGeometryBatch(ACTIVE_MODEL_ID, meshes as any);

      assert.notStrictEqual(state.geometryResult, null);
      assert.strictEqual(state.geometryResult?.meshes.length, 2);
    });

    it('should append meshes to existing result', () => {
      const mesh1 = createMockMesh(1);
      const mesh2 = createMockMesh(2);

      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh1] as any);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh2] as any);

      assert.strictEqual(state.geometryResult?.meshes.length, 2);
    });

    it('should use provided coordinate info', () => {
      const meshes = [createMockMesh(1)];
      const coordInfo = {
        originShift: { x: 10, y: 20, z: 30 },
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 100 } },
        shiftedBounds: { min: { x: -10, y: -20, z: -30 }, max: { x: 90, y: 80, z: 70 } },
        hasLargeCoordinates: true,
      };

      state.appendGeometryBatch(ACTIVE_MODEL_ID, meshes as any, coordInfo);

      assert.deepStrictEqual(state.geometryResult?.coordinateInfo.originShift, { x: 10, y: 20, z: 30 });
      assert.strictEqual(state.geometryResult?.coordinateInfo.hasLargeCoordinates, true);
    });

    it('should use default coordinate info when not provided', () => {
      const meshes = [createMockMesh(1)];
      state.appendGeometryBatch(ACTIVE_MODEL_ID, meshes as any);

      // Should have fresh copies, not shared references
      assert.deepStrictEqual(state.geometryResult?.coordinateInfo.originShift, DATA_DEFAULTS.ORIGIN_SHIFT);
      assert.strictEqual(state.geometryResult?.coordinateInfo.hasLargeCoordinates, DATA_DEFAULTS.HAS_LARGE_COORDINATES);
    });

    it('should create fresh coordinate info copies (not shared references)', () => {
      const meshes = [createMockMesh(1)];
      state.appendGeometryBatch(ACTIVE_MODEL_ID, meshes as any);

      // Mutate the result's coordinate info
      state.geometryResult!.coordinateInfo.originShift.x = 999;

      // DATA_DEFAULTS should not be affected
      assert.strictEqual(DATA_DEFAULTS.ORIGIN_SHIFT.x, 0);
    });
  });

  /**
   * #4922: `appendGeometryBatch` used to file newly created meshes (e.g. a
   * wall/slab split's two halves) only under `state.activeModelId`,
   * regardless of which model the caller said it was appending to. In a
   * federation, picking + editing an element in 3D does NOT call
   * `setActiveModel`, so splitting an element in a non-active model got its
   * new halves filed under the WRONG model's `geometryResult`.
   *
   * A single-model fixture cannot catch this: with only one model,
   * `modelId === activeModelId` always holds and the bug is invisible. Every
   * test below seeds TWO federated models and edits the NON-active one.
   */
  describe('federated modelId routing (#4922)', () => {
    const EDITED_MODEL_ID = 'edited-model'; // NOT the active model in this suite

    function seedTwoModels() {
      const models = new Map<string, any>([
        [ACTIVE_MODEL_ID, { id: ACTIVE_MODEL_ID, geometryResult: null }],
        [EDITED_MODEL_ID, { id: EDITED_MODEL_ID, geometryResult: null }],
      ]);
      state = { ...state, activeModelId: ACTIVE_MODEL_ID, models: models as any };
    }

    it('files new meshes on the edited (non-active) model, not the active one', () => {
      seedTwoModels();
      const leftHalf = createMockMesh(101);
      const rightHalf = createMockMesh(102);

      state.appendGeometryBatch(EDITED_MODEL_ID, [leftHalf, rightHalf] as any);

      // Landed on the edited model's per-model geometryResult...
      const editedModel = state.models.get(EDITED_MODEL_ID);
      assert.strictEqual(editedModel?.geometryResult?.meshes.length, 2);
      assert.deepStrictEqual(
        editedModel?.geometryResult?.meshes.map((m: any) => m.expressId),
        [101, 102],
      );

      // ...and did NOT land on the active model's geometryResult, at either copy.
      const activeModel = state.models.get(ACTIVE_MODEL_ID);
      assert.strictEqual(activeModel?.geometryResult, null);
      assert.strictEqual(state.geometryResult, null);
    });

    it('moves totalTriangles/totalVertices with the meshes onto the edited model only', () => {
      seedTwoModels();
      const mesh = createMockMesh(201); // 1 triangle (3 indices), 3 vertices

      state.appendGeometryBatch(EDITED_MODEL_ID, [mesh] as any);

      const editedModel = state.models.get(EDITED_MODEL_ID);
      assert.strictEqual(editedModel?.geometryResult?.totalTriangles, 1);
      assert.strictEqual(editedModel?.geometryResult?.totalVertices, 3);

      // The active model's totals must not have moved.
      const activeModel = state.models.get(ACTIVE_MODEL_ID);
      assert.strictEqual(activeModel?.geometryResult, null);
      assert.strictEqual(state.geometryResult, null);
    });

    it('leaves the top-level geometryResult mirror untouched when the edited model is not active', () => {
      seedTwoModels();
      // Give the active model some geometry of its own first, so we can prove
      // appending to the OTHER model doesn't disturb it.
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [createMockMesh(1)] as any);
      assert.strictEqual(state.geometryResult?.meshes.length, 1);

      state.appendGeometryBatch(EDITED_MODEL_ID, [createMockMesh(2), createMockMesh(3)] as any);

      // Top-level mirror still reflects only the active model.
      assert.strictEqual(state.geometryResult?.meshes.length, 1);
      assert.strictEqual(state.geometryResult?.meshes[0].expressId, 1);
    });

    it('updates BOTH the top-level mirror and the per-model copy when the edited model IS active', () => {
      seedTwoModels();
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [createMockMesh(5)] as any);

      assert.strictEqual(state.geometryResult?.meshes.length, 1);
      assert.strictEqual(state.models.get(ACTIVE_MODEL_ID)?.geometryResult?.meshes.length, 1);
      assert.strictEqual(state.models.get(EDITED_MODEL_ID)?.geometryResult, null);
    });

    it('refuses (drops the batch) rather than falling back to the active model for an unknown modelId', () => {
      seedTwoModels();
      state.appendGeometryBatch('some-unregistered-model', [createMockMesh(9)] as any);

      // Must NOT have been silently filed under the active model — that is
      // the exact defect #4922 reports.
      assert.strictEqual(state.geometryResult, null);
      assert.strictEqual(state.models.get(ACTIVE_MODEL_ID)?.geometryResult, null);
      assert.strictEqual(state.models.get(EDITED_MODEL_ID)?.geometryResult, null);
    });

    it('warns on the refused, unknown-modelId path (observable proof the refuse branch actually ran)', () => {
      // Dropping the batch is otherwise unobservable from state alone — the
      // "create new geometryResult" path below the refuse guard produces an
      // object that would just get discarded either way. The console.warn is
      // the one side effect that only fires if the guard is actually there,
      // so it's what a mutation that deletes the guard shows up in.
      seedTwoModels();
      const originalWarn = console.warn;
      const calls: unknown[][] = [];
      console.warn = (...args: unknown[]) => { calls.push(args); };
      try {
        state.appendGeometryBatch('some-unregistered-model', [createMockMesh(9)] as any);
      } finally {
        console.warn = originalWarn;
      }

      assert.strictEqual(calls.length, 1);
      assert.match(String(calls[0][0]), /some-unregistered-model/);
    });

    it('preserves the non-active model\'s other FederatedModel fields (name, ifcDataStore, visible, loadState) when appending', () => {
      // A model whose only meaningful field were `geometryResult` couldn't
      // catch `next.set(modelId, { geometryResult })` dropping the `...model`
      // spread — both mutated and correct code would look identical. So this
      // seeds fields that are actually load-bearing elsewhere in the app.
      const ifcDataStoreSentinel = { tables: 'sentinel' };
      const models = new Map<string, any>([
        [ACTIVE_MODEL_ID, { id: ACTIVE_MODEL_ID, geometryResult: null }],
        [
          EDITED_MODEL_ID,
          {
            id: EDITED_MODEL_ID,
            name: 'edited-model.ifc',
            ifcDataStore: ifcDataStoreSentinel,
            visible: false,
            loadState: 'complete',
            geometryResult: null,
          },
        ],
      ]);
      state = { ...state, activeModelId: ACTIVE_MODEL_ID, models: models as any };

      state.appendGeometryBatch(EDITED_MODEL_ID, [createMockMesh(301)] as any);

      const editedModel = state.models.get(EDITED_MODEL_ID);
      assert.strictEqual(editedModel?.geometryResult?.meshes.length, 1);
      // The rest of the model's fields must survive the update untouched.
      assert.strictEqual(editedModel?.name, 'edited-model.ifc');
      assert.strictEqual(editedModel?.ifcDataStore, ifcDataStoreSentinel);
      assert.strictEqual(editedModel?.visible, false);
      assert.strictEqual(editedModel?.loadState, 'complete');
    });

    it('preserves an existing non-zero coordinateInfo when a later batch is appended without one', () => {
      // A zeroed/default coordinateInfo fixture can't distinguish "preserved"
      // from "overwritten with the default" — both look the same. This seeds
      // a real, non-zero originShift/bounds so only preservation passes.
      const seededCoordinateInfo = {
        originShift: { x: 12345.6, y: -789.1, z: 42 },
        originalBounds: { min: { x: 1, y: 2, z: 3 }, max: { x: 100, y: 200, z: 300 } },
        shiftedBounds: { min: { x: -1, y: -2, z: -3 }, max: { x: 50, y: 60, z: 70 } },
        hasLargeCoordinates: true,
      };
      const models = new Map<string, any>([
        [ACTIVE_MODEL_ID, { id: ACTIVE_MODEL_ID, geometryResult: null }],
        [
          EDITED_MODEL_ID,
          {
            id: EDITED_MODEL_ID,
            geometryResult: {
              meshes: [createMockMesh(400)],
              totalTriangles: 1,
              totalVertices: 3,
              coordinateInfo: seededCoordinateInfo,
            },
          },
        ],
      ]);
      state = { ...state, activeModelId: ACTIVE_MODEL_ID, models: models as any };

      // Append WITHOUT coordinateInfo, mirroring the loader's throttled
      // mid-stream batches and mutationSlice's split/clone/addWall calls.
      state.appendGeometryBatch(EDITED_MODEL_ID, [createMockMesh(401)] as any);

      const editedModel = state.models.get(EDITED_MODEL_ID);
      assert.strictEqual(editedModel?.geometryResult?.meshes.length, 2);
      assert.deepStrictEqual(editedModel?.geometryResult?.coordinateInfo, seededCoordinateInfo);
    });
  });

  describe('pruneGeometryMeshes', () => {
    // Mirrors what a wall/slab split does: the source mesh is tombstoned and
    // two new halves land via appendGeometryBatch, then the drain prunes the
    // source out from under pendingMeshRemovals.
    const seedSplit = () => {
      const source = createSizedMesh(1, 3, 1); // 3 verts, 1 triangle
      const left = createSizedMesh(2, 4, 2); // 4 verts, 2 triangles
      const right = createSizedMesh(3, 5, 3); // 5 verts, 3 triangles
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [source, left, right] as any);
    };

    it('drops the pruned mesh out of geometryResult.meshes and subtracts only its counts', () => {
      seedSplit();
      assert.strictEqual(state.geometryResult?.totalTriangles, 6); // 1+2+3
      assert.strictEqual(state.geometryResult?.totalVertices, 12); // 3+4+5

      state.pruneGeometryMeshes(new Set([1]));

      const ids = state.geometryResult?.meshes.map((m) => m.expressId);
      assert.deepStrictEqual(ids, [2, 3]);
      // Only the source's counts came off — not a wrong field, not the
      // wrong divisor, not the whole batch.
      assert.strictEqual(state.geometryResult?.totalTriangles, 5); // 2+3
      assert.strictEqual(state.geometryResult?.totalVertices, 9); // 4+5
    });

    it('is idempotent: draining an id twice does not double-subtract or go negative', () => {
      seedSplit();
      state.pruneGeometryMeshes(new Set([1]));
      state.pruneGeometryMeshes(new Set([1]));

      assert.strictEqual(state.geometryResult?.meshes.length, 2);
      assert.strictEqual(state.geometryResult?.totalTriangles, 5);
      assert.strictEqual(state.geometryResult?.totalVertices, 9);
    });

    it('leaves totals untouched when the id names no mesh', () => {
      seedSplit();
      state.pruneGeometryMeshes(new Set([999]));

      assert.strictEqual(state.geometryResult?.meshes.length, 3);
      assert.strictEqual(state.geometryResult?.totalTriangles, 6);
      assert.strictEqual(state.geometryResult?.totalVertices, 12);
    });

    // Bounded mode empties a mesh's buffers after GPU upload but keeps the mesh
    // and its share of the totals; a later split/delete prune must subtract
    // what the mesh contributed, not the zero its empty buffers now report.
    it('subtracts the pre-release counts for a mesh released in bounded mode', () => {
      state.setBoundedGeometryMode(true);
      seedSplit();
      state.releaseGeometryMemory();
      assert.strictEqual(state.geometryResult?.meshes[0].indices.length, 0, 'buffers were released (fixture can fail)');
      assert.strictEqual(state.geometryResult?.totalTriangles, 6);

      state.pruneGeometryMeshes(new Set([1]));

      assert.deepStrictEqual(state.geometryResult?.meshes.map((m) => m.expressId), [2, 3]);
      assert.strictEqual(state.geometryResult?.totalTriangles, 5); // 2+3
      assert.strictEqual(state.geometryResult?.totalVertices, 9); // 4+5
    });

    // The queue carries global ids with no model id, and a split/delete can act
    // on a federated model that is not active (3D picking does not switch it).
    it('prunes the owning model even when it is not the active model', () => {
      const asModel = (id: string, geometryResult: unknown) => ({ id, geometryResult }) as unknown as FederatedModel;
      const activeGeometry = {
        meshes: [createSizedMesh(1, 3, 1), createSizedMesh(2, 4, 2)],
        totalTriangles: 3, totalVertices: 7, coordinateInfo: state.geometryResult?.coordinateInfo,
      } as unknown as GeometryResult;
      const otherGeometry = {
        meshes: [createSizedMesh(1001, 5, 3), createSizedMesh(1002, 6, 4)],
        totalTriangles: 7, totalVertices: 11, coordinateInfo: activeGeometry.coordinateInfo,
      } as unknown as GeometryResult;
      state = {
        ...state,
        activeModelId: 'A',
        geometryResult: activeGeometry,
        models: new Map([['A', asModel('A', activeGeometry)], ['B', asModel('B', otherGeometry)]]),
      };

      state.pruneGeometryMeshes(new Set([1001]));

      const b = state.models.get('B')?.geometryResult;
      assert.deepStrictEqual(b?.meshes.map((m) => m.expressId), [1002]);
      assert.strictEqual(b?.totalTriangles, 4);
      assert.strictEqual(b?.totalVertices, 6);
      assert.strictEqual(state.geometryResult, activeGeometry, 'the active model is untouched');
      assert.strictEqual(state.models.get('A')?.geometryResult, activeGeometry);

      // Control: an active-model id prunes the mirror and its record to one object.
      state.pruneGeometryMeshes(new Set([2]));
      assert.deepStrictEqual(state.geometryResult?.meshes.map((m) => m.expressId), [1]);
      assert.strictEqual(state.geometryResult?.totalTriangles, 1);
      assert.strictEqual(state.models.get('A')?.geometryResult, state.geometryResult);
    });

    // Renderer parity: Scene.removeMeshesForEntity keeps a colour-merged mesh
    // (it hosts other entities) and tombstones an instanced-only entity.
    it('keeps colour-merged meshes and drops instanced-only metadata, like the renderer', () => {
      const merged = { ...createSizedMesh(1, 3, 1), entityIds: new Uint32Array([1, 1, 7]) };
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [merged, createSizedMesh(2, 4, 2)] as any);
      const geometry = state.geometryResult!;
      state.geometryResult = {
        ...geometry,
        instancedGeometryHashes: new Map([[50, 5n], [51, 6n]]),
        instancedGeometryAabbs: new Map([[50, { min: [0, 0, 0], max: [1, 1, 1] }]]) as GeometryResult['instancedGeometryAabbs'],
        instancedGeometryVolumes: new Map([[50, 2], [51, 3]]),
      };

      state.pruneGeometryMeshes(new Set([1]));
      assert.strictEqual(state.geometryResult?.meshes.length, 2, 'a colour-merged mesh stays');
      assert.strictEqual(state.geometryResult?.totalTriangles, 3);

      state.pruneGeometryMeshes(new Set([50]));
      assert.deepStrictEqual([...state.geometryResult!.instancedGeometryHashes!.keys()], [51]);
      assert.strictEqual(state.geometryResult?.instancedGeometryAabbs?.size, 0);
      assert.deepStrictEqual([...state.geometryResult!.instancedGeometryVolumes!.keys()], [51]);
      assert.strictEqual(state.geometryResult?.meshes.length, 2);
      assert.strictEqual(state.geometryResult?.totalTriangles, 3, 'an instanced-only prune leaves mesh totals alone');
    });

    // An authored element (addElementMeshes) carries per-vertex entityIds that
    // name only its own id; wall split only accepts such walls, so its source
    // must be pruned. A mesh whose entityIds name other entities stays.
    it('prunes an authored mesh whose entityIds hold only its own id, and keeps a colour-merged one', () => {
      const authored = { ...createSizedMesh(5, 4, 2), entityIds: new Uint32Array(4).fill(5) };
      const merged = { ...createSizedMesh(6, 3, 1), entityIds: new Uint32Array([6, 6, 8]) };
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [authored, merged, createSizedMesh(7, 5, 3)] as any);
      assert.strictEqual(state.geometryResult?.totalTriangles, 6);

      state.pruneGeometryMeshes(new Set([5, 6]));

      assert.deepStrictEqual(state.geometryResult?.meshes.map((m) => m.expressId), [6, 7]);
      assert.strictEqual(state.geometryResult?.totalTriangles, 4); // 1+3
      assert.strictEqual(state.geometryResult?.totalVertices, 8); // 3+5
    });

    // updateMeshColors replaces a released mesh with `{ ...mesh, color }`; the
    // copy must still subtract the counts retained at release.
    it('subtracts released counts for a mesh recoloured after release', () => {
      state.setBoundedGeometryMode(true);
      seedSplit();
      state.releaseGeometryMemory();
      state.updateMeshColors(new Map([[1, [0, 1, 0, 1]]]));
      assert.notStrictEqual(state.geometryResult?.meshes[0].color[0], 1, 'recolour replaced the mesh (fixture can fail)');

      state.pruneGeometryMeshes(new Set([1]));

      assert.strictEqual(state.geometryResult?.totalTriangles, 5); // 2+3
      assert.strictEqual(state.geometryResult?.totalVertices, 9); // 4+5
    });

    // restorePreAlignment writes snapshot slots back BY INDEX, so a pruned mesh
    // must take its slot with it or the next mesh gets its predecessor's vertices.
    it('drops the pruned mesh\'s preAlignment slot so a later restore stays aligned', () => {
      const meshes = [createSizedMesh(1, 3, 1), createSizedMesh(2, 4, 2), createSizedMesh(3, 5, 3)];
      const geometry = { meshes, totalTriangles: 6, totalVertices: 12, coordinateInfo: state.geometryResult?.coordinateInfo,
        instancedGeometryAabbs: new Map([[2, { min: [0, 0, 0], max: [1, 1, 1] }], [9, { min: [0, 0, 0], max: [2, 2, 2] }]]) } as unknown as GeometryResult;
      const snapshot = capturePreAlignment(geometry);
      snapshot.positions = meshes.map((m) => new Float32Array(m.positions.length).fill(m.expressId));
      const model = { id: 'A', geometryResult: geometry, preAlignment: snapshot } as unknown as FederatedModel;
      state = { ...state, activeModelId: 'A', geometryResult: geometry, models: new Map([['A', model]]) };

      state.pruneGeometryMeshes(new Set([2]));

      const next = state.models.get('A')!;
      assert.strictEqual(next.preAlignment?.positions.length, 2);
      assert.deepStrictEqual([...next.preAlignment!.instancedGeometryAabbs!.keys()], [9]);
      restorePreAlignment(next.geometryResult!, next.preAlignment!);
      assert.deepStrictEqual(next.geometryResult!.meshes.map((m) => m.positions[0]), [1, 3]);
    });

    it('is a no-op when there is no geometryResult yet', () => {
      assert.doesNotThrow(() => state.pruneGeometryMeshes(new Set([1])));
      assert.strictEqual(state.geometryResult, null);
    });
  });

  describe('updateMeshColors', () => {
    it('should update mesh colors', () => {
      const mesh = createMockMesh(1, [1, 0, 0, 1]);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [0, 1, 0, 1]); // Change to green

      state.updateMeshColors(updates);

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0, 1, 0, 1]);
      assert.strictEqual(state.pendingColorUpdates, null);
      assert.deepStrictEqual(state.pendingMeshColorUpdates?.get(1), [0, 1, 0, 1]);
    });

    it('should clone updates and avoid mutating state from external map writes', () => {
      const mesh = createMockMesh(1);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [0, 1, 0, 1]);

      state.updateMeshColors(updates);

      // Mutate the original map
      updates.set(1, [1, 1, 1, 1]);

      // State should not be affected
      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0, 1, 0, 1]);
      assert.strictEqual(state.pendingColorUpdates, null);
      assert.deepStrictEqual(state.pendingMeshColorUpdates?.get(1), [0, 1, 0, 1]);
    });

    it('should skip mesh mutation but still set pendingMeshColorUpdates when no geometry result', () => {
      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [0, 1, 0, 1]);

      state.updateMeshColors(updates);

      assert.strictEqual(state.geometryResult, null);
      assert.strictEqual(state.pendingColorUpdates, null);
      assert.deepStrictEqual(state.pendingMeshColorUpdates?.get(1), [0, 1, 0, 1]);
    });

    it('should preserve unaffected meshes', () => {
      const mesh1 = createMockMesh(1, [1, 0, 0, 1]);
      const mesh2 = createMockMesh(2, [0, 0, 1, 1]);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh1, mesh2] as any);

      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [0, 1, 0, 1]); // Only update mesh 1

      state.updateMeshColors(updates);

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0, 1, 0, 1]);
      assert.deepStrictEqual(state.geometryResult?.meshes[1].color, [0, 0, 1, 1]);
    });
  });

  describe('clearPendingColorUpdates', () => {
    it('should clear pending color updates', () => {
      const mesh = createMockMesh(1);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [0, 1, 0, 1]);
      state.setPendingColorUpdates(updates);

      state.clearPendingColorUpdates();

      assert.strictEqual(state.pendingColorUpdates, null);
    });
  });

  describe('clearPendingMeshColorUpdates', () => {
    it('should clear pending mesh color updates', () => {
      const mesh = createMockMesh(1);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [0, 1, 0, 1]);
      state.updateMeshColors(updates);

      state.clearPendingMeshColorUpdates();

      assert.strictEqual(state.pendingMeshColorUpdates, null);
    });
  });

  /**
   * `resetMeshColors` is what the embed API's `RESET_COLORS` undoes
   * `SET_COLORS` with (#2934). It used to call `clearPendingColorUpdates`,
   * which is a DIFFERENT channel: `SET_COLORS` bakes into
   * `geometryResult.meshes[].color`, while `pendingColorUpdates` belongs to the
   * lens / IDS / clash / schedule overlays. So the reset both failed to undo
   * the override and destroyed a claim it did not own — the two directions
   * asserted separately below.
   */
  describe('resetMeshColors', () => {
    it('restores the pre-override mesh color and re-queues it for the renderer', () => {
      const mesh = createMockMesh(1, [1, 0, 0, 1]); // original: red
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      const updates = new Map<number, [number, number, number, number]>([[1, [0, 1, 0, 1]]]);
      state.updateMeshColors(updates, { override: true }); // SET_COLORS: green
      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0, 1, 0, 1]);

      state.resetMeshColors();

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [1, 0, 0, 1]);
      assert.deepStrictEqual(state.pendingMeshColorUpdates?.get(1), [1, 0, 0, 1]);
      assert.strictEqual(state.meshColorBackup, null);
    });

    it('restores the ORIGINAL color across repeated overrides, not the last one', () => {
      const mesh = createMockMesh(1, [1, 0, 0, 1]); // original: red
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      state.updateMeshColors(new Map([[1, [0, 1, 0, 1] as [number, number, number, number]]]), { override: true });
      state.updateMeshColors(new Map([[1, [0, 0, 1, 1] as [number, number, number, number]]]), { override: true });

      state.resetMeshColors();

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [1, 0, 0, 1]);
    });

    it('leaves the loader\'s IFC style colors alone — they are the model, not an override', () => {
      // The deferred style/material pass in useIfcLoader goes through
      // updateMeshColors WITHOUT `override`. If it were backed up, a host's
      // RESET_COLORS would strip the model's own IFC colors back to the
      // pre-style default.
      const mesh = createMockMesh(1, [0.5, 0.5, 0.5, 1]); // pre-style default
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      state.updateMeshColors(new Map([[1, [0.8, 0.6, 0.4, 1] as [number, number, number, number]]]));

      state.resetMeshColors();

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0.8, 0.6, 0.4, 1]);
      assert.strictEqual(state.meshColorBackup, null);
    });

    it('restores to the IFC style color, not to the pre-style default', () => {
      const mesh = createMockMesh(1, [0.5, 0.5, 0.5, 1]);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);
      // Load-time style pass, then a host override on top of it.
      state.updateMeshColors(new Map([[1, [0.8, 0.6, 0.4, 1] as [number, number, number, number]]]));
      state.updateMeshColors(new Map([[1, [1, 0, 0, 1] as [number, number, number, number]]]), { override: true });

      state.resetMeshColors();

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0.8, 0.6, 0.4, 1]);
    });

    it('does not touch pendingColorUpdates — the lens/IDS/clash overlay channel', () => {
      const mesh = createMockMesh(1, [1, 0, 0, 1]);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      // Another subsystem's claim on the overlay channel.
      state.setPendingColorUpdates(new Map([[1, [1, 1, 0, 1] as [number, number, number, number]]]));
      state.updateMeshColors(new Map([[1, [0, 1, 0, 1] as [number, number, number, number]]]), { override: true });

      state.resetMeshColors();

      assert.deepStrictEqual(state.pendingColorUpdates?.get(1), [1, 1, 0, 1]);
    });

    it('is a no-op when nothing was ever overridden', () => {
      const mesh = createMockMesh(1, [1, 0, 0, 1]);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);
      // A load-time style bake still queued for the renderer must survive: a
      // reset that clears it would drop the model's colors mid-load.
      state.updateMeshColors(new Map([[1, [0.8, 0.6, 0.4, 1] as [number, number, number, number]]]));

      state.resetMeshColors();

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0.8, 0.6, 0.4, 1]);
      assert.deepStrictEqual(state.pendingMeshColorUpdates?.get(1), [0.8, 0.6, 0.4, 1]);
    });
  });

  describe('setPendingColorUpdates', () => {
    it('should clone pending color updates map', () => {
      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [0, 1, 0, 1]);
      state.setPendingColorUpdates(updates);

      updates.set(1, [1, 1, 1, 1]);
      assert.notStrictEqual(state.pendingColorUpdates, updates);
      assert.deepStrictEqual(state.pendingColorUpdates?.get(1), [0, 1, 0, 1]);
    });

    it('should not mutate persisted geometry colors', () => {
      const mesh = createMockMesh(1, [0.2, 0.2, 0.2, 1]);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);
      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [1, 0, 1, 0.5]);

      state.setPendingColorUpdates(updates);

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0.2, 0.2, 0.2, 1]);
      assert.deepStrictEqual(state.pendingColorUpdates?.get(1), [1, 0, 1, 0.5]);
    });
  });

  describe('updateCoordinateInfo', () => {
    it('should update coordinate info', () => {
      const mesh = createMockMesh(1);
      state.appendGeometryBatch(ACTIVE_MODEL_ID, [mesh] as any);

      const newCoordInfo = {
        originShift: { x: 100, y: 200, z: 300 },
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 50 } },
        shiftedBounds: { min: { x: -100, y: -200, z: -300 }, max: { x: -50, y: -150, z: -250 } },
        hasLargeCoordinates: true,
      };

      state.updateCoordinateInfo(newCoordInfo);

      assert.deepStrictEqual(state.geometryResult?.coordinateInfo, newCoordInfo);
    });

    it('should not update when no geometry result', () => {
      const newCoordInfo = {
        originShift: { x: 100, y: 200, z: 300 },
        originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 50 } },
        shiftedBounds: { min: { x: -100, y: -200, z: -300 }, max: { x: -50, y: -150, z: -250 } },
        hasLargeCoordinates: true,
      };

      state.updateCoordinateInfo(newCoordInfo);

      assert.strictEqual(state.geometryResult, null);
    });
  });
});
