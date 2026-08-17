/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression: a peer's edit must never overwrite another model's geometry.
 *
 * The recipient path in `collabSlice` re-derives the shared model from the CRDT
 * on every peer edit. It writes the result through the store, and the store's
 * `setIfcDataStore` / `setGeometryResult` target `activeModelId` — so when the
 * active model was NOT the room model (recipient loaded their own file, or
 * selected another federated model in the hierarchy), the room's store and
 * meshes landed on the user's model and their geometry was gone.
 *
 * These tests drive the real `modelSlice` + `dataSlice` actions, so they
 * exercise the actual active-model targeting rather than a re-implementation.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { createModelSlice, type ModelSlice, type ModelCrossSliceState } from '../../store/slices/modelSlice.js';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from '../../store/slices/dataSlice.js';
import type { FederatedModel } from '../../store/types.js';
import { applyRoomModelData } from './room-model-apply.js';

type TestState = ModelSlice & ModelCrossSliceState & DataSlice & DataCrossSliceState;

/** A marker store/geometry pair per model — identity is all the test compares. */
function markerStore(tag: string): IfcDataStore {
  return { __tag: tag } as unknown as IfcDataStore;
}
function markerGeometry(tag: string): GeometryResult {
  return { __tag: tag, meshes: [], totalTriangles: 0, totalVertices: 0 } as unknown as GeometryResult;
}

function model(id: string, tag: string): FederatedModel {
  return {
    id,
    name: id,
    ifcDataStore: markerStore(tag),
    geometryResult: markerGeometry(tag),
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset: 0,
    maxExpressId: 0,
  };
}

const ROOM_MODEL_ID = 'room:r1';

describe('applyRoomModelData', () => {
  let state: TestState;

  beforeEach(() => {
    const setState = (partial: unknown) => {
      const updates =
        typeof partial === 'function'
          ? (partial as (s: TestState) => Partial<TestState>)(state)
          : (partial as Partial<TestState>);
      state = { ...state, ...updates };
    };
    const getState = () => state;

    const modelSlice = createModelSlice(
      setState as Parameters<typeof createModelSlice>[0],
      getState as Parameters<typeof createModelSlice>[1],
      undefined as unknown as Parameters<typeof createModelSlice>[2],
    );
    const dataSlice = createDataSlice(
      setState as Parameters<typeof createDataSlice>[0],
      getState as Parameters<typeof createDataSlice>[1],
      undefined as unknown as Parameters<typeof createDataSlice>[2],
    );
    state = { ...modelSlice, ...dataSlice } as TestState;
  });

  it('leaves the user\'s active model untouched when the room model is not active', () => {
    // The user has their own file open and selected; the room model exists
    // alongside it (recipient joined a share link, then loaded/selected their
    // own model in the hierarchy).
    state.addModel(model('local', 'local'));
    state.upsertModel(model(ROOM_MODEL_ID, 'room-v1'));
    state.setActiveModel('local');
    const localStore = state.models.get('local')!.ifcDataStore;
    const localGeometry = state.models.get('local')!.geometryResult;

    // A peer edits: the recipient re-derives the room model and applies it.
    applyRoomModelData(state, ROOM_MODEL_ID, {
      ifcDataStore: markerStore('room-v2'),
      geometryResult: markerGeometry('room-v2'),
    });

    // The user's model must be byte-for-byte the same object it was.
    assert.strictEqual(state.models.get('local')!.ifcDataStore, localStore);
    assert.strictEqual(state.models.get('local')!.geometryResult, localGeometry);
    assert.strictEqual(state.ifcDataStore, localStore);
    assert.strictEqual(state.geometryResult, localGeometry);

    // …and the room model did receive the update.
    assert.strictEqual(
      (state.models.get(ROOM_MODEL_ID)!.ifcDataStore as unknown as { __tag: string }).__tag,
      'room-v2',
    );
    assert.strictEqual(
      (state.models.get(ROOM_MODEL_ID)!.geometryResult as unknown as { __tag: string }).__tag,
      'room-v2',
    );
  });

  it('routes through the active-model setters when the room model IS active', () => {
    // The ordinary recipient case: the room model is the only model and is
    // active, so the top-level `ifcDataStore` (read by the outbound mutation
    // mirror) and the renderer's geometry tick must still be updated.
    state.addModel(model(ROOM_MODEL_ID, 'room-v1'));
    assert.strictEqual(state.activeModelId, ROOM_MODEL_ID);
    const tickBefore = state.geometryUpdateTick;

    const nextStore = markerStore('room-v2');
    const nextGeometry = markerGeometry('room-v2');
    applyRoomModelData(state, ROOM_MODEL_ID, {
      ifcDataStore: nextStore,
      geometryResult: nextGeometry,
    });

    assert.strictEqual(state.models.get(ROOM_MODEL_ID)!.ifcDataStore, nextStore);
    assert.strictEqual(state.models.get(ROOM_MODEL_ID)!.geometryResult, nextGeometry);
    assert.strictEqual(state.ifcDataStore, nextStore);
    assert.strictEqual(state.geometryResult, nextGeometry);
    assert.ok(state.geometryUpdateTick > tickBefore, 'renderer geometry tick must be bumped');
  });

  it('applies only the fields present in the patch', () => {
    state.addModel(model('local', 'local'));
    state.upsertModel(model(ROOM_MODEL_ID, 'room-v1'));
    state.setActiveModel('local');

    applyRoomModelData(state, ROOM_MODEL_ID, { geometryResult: markerGeometry('room-v2') });

    assert.strictEqual(
      (state.models.get(ROOM_MODEL_ID)!.ifcDataStore as unknown as { __tag: string }).__tag,
      'room-v1',
    );
    assert.strictEqual(
      (state.models.get(ROOM_MODEL_ID)!.geometryResult as unknown as { __tag: string }).__tag,
      'room-v2',
    );
  });
});
