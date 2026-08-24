/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from './dataSlice.js';
import { DATA_DEFAULTS } from '../constants.js';

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

type TestSetState = (
  partial:
    | Partial<DataTestState>
    | ((state: DataTestState) => Partial<DataTestState>),
) => void;
type TestGetState = () => DataTestState;

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
    state = { ...slice, activeModelId: null, models: new Map() };
  });

  describe('appendGeometryBatch', () => {
    it('should create new geometry result when none exists', () => {
      const meshes = [createMockMesh(1), createMockMesh(2)];
      state.appendGeometryBatch(meshes as any);

      assert.notStrictEqual(state.geometryResult, null);
      assert.strictEqual(state.geometryResult?.meshes.length, 2);
    });

    it('should append meshes to existing result', () => {
      const mesh1 = createMockMesh(1);
      const mesh2 = createMockMesh(2);

      state.appendGeometryBatch([mesh1] as any);
      state.appendGeometryBatch([mesh2] as any);

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

      state.appendGeometryBatch(meshes as any, coordInfo);

      assert.deepStrictEqual(state.geometryResult?.coordinateInfo.originShift, { x: 10, y: 20, z: 30 });
      assert.strictEqual(state.geometryResult?.coordinateInfo.hasLargeCoordinates, true);
    });

    it('should use default coordinate info when not provided', () => {
      const meshes = [createMockMesh(1)];
      state.appendGeometryBatch(meshes as any);

      // Should have fresh copies, not shared references
      assert.deepStrictEqual(state.geometryResult?.coordinateInfo.originShift, DATA_DEFAULTS.ORIGIN_SHIFT);
      assert.strictEqual(state.geometryResult?.coordinateInfo.hasLargeCoordinates, DATA_DEFAULTS.HAS_LARGE_COORDINATES);
    });

    it('should create fresh coordinate info copies (not shared references)', () => {
      const meshes = [createMockMesh(1)];
      state.appendGeometryBatch(meshes as any);

      // Mutate the result's coordinate info
      state.geometryResult!.coordinateInfo.originShift.x = 999;

      // DATA_DEFAULTS should not be affected
      assert.strictEqual(DATA_DEFAULTS.ORIGIN_SHIFT.x, 0);
    });
  });

  describe('updateMeshColors', () => {
    it('should update mesh colors', () => {
      const mesh = createMockMesh(1, [1, 0, 0, 1]);
      state.appendGeometryBatch([mesh] as any);

      const updates = new Map<number, [number, number, number, number]>();
      updates.set(1, [0, 1, 0, 1]); // Change to green

      state.updateMeshColors(updates);

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0, 1, 0, 1]);
      assert.strictEqual(state.pendingColorUpdates, null);
      assert.deepStrictEqual(state.pendingMeshColorUpdates?.get(1), [0, 1, 0, 1]);
    });

    it('should clone updates and avoid mutating state from external map writes', () => {
      const mesh = createMockMesh(1);
      state.appendGeometryBatch([mesh] as any);

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
      state.appendGeometryBatch([mesh1, mesh2] as any);

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
      state.appendGeometryBatch([mesh] as any);

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
      state.appendGeometryBatch([mesh] as any);

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
      state.appendGeometryBatch([mesh] as any);

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
      state.appendGeometryBatch([mesh] as any);

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
      state.appendGeometryBatch([mesh] as any);

      state.updateMeshColors(new Map([[1, [0.8, 0.6, 0.4, 1] as [number, number, number, number]]]));

      state.resetMeshColors();

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0.8, 0.6, 0.4, 1]);
      assert.strictEqual(state.meshColorBackup, null);
    });

    it('restores to the IFC style color, not to the pre-style default', () => {
      const mesh = createMockMesh(1, [0.5, 0.5, 0.5, 1]);
      state.appendGeometryBatch([mesh] as any);
      // Load-time style pass, then a host override on top of it.
      state.updateMeshColors(new Map([[1, [0.8, 0.6, 0.4, 1] as [number, number, number, number]]]));
      state.updateMeshColors(new Map([[1, [1, 0, 0, 1] as [number, number, number, number]]]), { override: true });

      state.resetMeshColors();

      assert.deepStrictEqual(state.geometryResult?.meshes[0].color, [0.8, 0.6, 0.4, 1]);
    });

    it('does not touch pendingColorUpdates — the lens/IDS/clash overlay channel', () => {
      const mesh = createMockMesh(1, [1, 0, 0, 1]);
      state.appendGeometryBatch([mesh] as any);

      // Another subsystem's claim on the overlay channel.
      state.setPendingColorUpdates(new Map([[1, [1, 1, 0, 1] as [number, number, number, number]]]));
      state.updateMeshColors(new Map([[1, [0, 1, 0, 1] as [number, number, number, number]]]), { override: true });

      state.resetMeshColors();

      assert.deepStrictEqual(state.pendingColorUpdates?.get(1), [1, 1, 0, 1]);
    });

    it('is a no-op when nothing was ever overridden', () => {
      const mesh = createMockMesh(1, [1, 0, 0, 1]);
      state.appendGeometryBatch([mesh] as any);
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
      state.appendGeometryBatch([mesh] as any);
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
      state.appendGeometryBatch([mesh] as any);

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
