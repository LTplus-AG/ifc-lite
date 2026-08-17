/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression: a collab room's edits must target the ROOM's model in BOTH
 * directions, not whatever model happens to be active.
 *
 * Reachable in two clicks. `upsertModel` keeps the existing `activeModelId`
 * rather than switching to the model it creates, so a user who joins a room and
 * then loads and selects their own file has a different model active. From
 * there the edit paths, which resolved the room's model as "the active one",
 * did this:
 *
 *   - inbound: a peer's edit — an expressId in the ROOM's id space — was
 *     written into the USER'S OWN model's `MutablePropertyView`, landing in
 *     that view's overlay and append-only `mutationHistory` (not in
 *     `undoStacks` / `dirtyModels`, which only `mutationSlice` writes). The
 *     exporter and `getModifiedEntityCount` read it, so it survives a reload
 *     and ships in their exported IFC.
 *   - outbound: an edit on the user's PRIVATE model was mirrored into the
 *     shared room and applied to whatever entity the id resolved to there,
 *     corrupting the owner's model for everyone.
 *
 * The active-model tracking these tests turn on is the REAL thing: state is
 * built from `createModelSlice` + `createDataSlice` and driven through
 * `upsertModel` / `setActiveModel` / `setIfcDataStore`, so what is exercised is
 * the store's actual focus behaviour rather than a re-statement of it.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createModelSlice, type ModelSlice, type ModelCrossSliceState } from '../../store/slices/modelSlice.js';
import { createDataSlice, type DataSlice, type DataCrossSliceState } from '../../store/slices/dataSlice.js';
import type { FederatedModel } from '../../store/types.js';
import {
  isRoomModel,
  roomMeshes,
  roomModelIdOf,
  roomMutationView,
  roomStore,
  type RoomModelTargetState,
} from './room-model-target.js';
import { toGlobalIdFromModels } from '../../store/globalId.js';
import { getEntityCenter } from '../../utils/viewportUtils.js';
import { buildGeometryResultFromMeshes } from './geometry-sync.js';
import type { MeshData } from '@ifc-lite/geometry';

type TestState = ModelSlice & ModelCrossSliceState & DataSlice & DataCrossSliceState & {
  collabRoomModelId: string | null;
  mutationViews: Map<string, MutablePropertyView>;
};

/** A marker store per model — identity is all these tests compare. */
function markerStore(tag: string): IfcDataStore {
  return { __tag: tag } as unknown as IfcDataStore;
}
function markerView(tag: string): MutablePropertyView {
  return { __tag: tag } as unknown as MutablePropertyView;
}

/** A unit cube centred on `x`, tagged with the GLOBAL id it renders under. */
function cubeAt(globalId: number, x: number): MeshData {
  return {
    expressId: globalId,
    positions: new Float32Array([x - 1, -1, -1, x + 1, -1, -1, x + 1, 1, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  } as MeshData;
}

function model(id: string, idOffset = 0): FederatedModel {
  return {
    id,
    name: id,
    ifcDataStore: markerStore(id),
    geometryResult: null,
    visible: true,
    collapsed: false,
    schemaVersion: 'IFC4',
    loadedAt: 0,
    fileSize: 0,
    idOffset,
    maxExpressId: 0,
  } as unknown as FederatedModel;
}

const ROOM_MODEL_ID = 'room:r1';
const OWN_MODEL_ID = 'my-file.ifc';

describe('room-model-target', () => {
  let state: TestState;
  /** Narrowed to exactly what the resolvers read, as production passes it. */
  const target = (): RoomModelTargetState => state as unknown as RoomModelTargetState;

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
    state = {
      ...modelSlice,
      ...dataSlice,
      collabRoomModelId: null,
      mutationViews: new Map(),
    } as TestState;
  });

  /**
   * The two-click sequence: join a room (the reconstruct registers the room
   * model), then load and select your own file. Driven through the real slice
   * actions — including the `upsertModel` call whose refusal to switch focus is
   * what makes the room model and the active model diverge.
   */
  function joinRoomThenOpenOwnFile(): void {
    state.upsertModel(model(ROOM_MODEL_ID));
    state.collabRoomModelId = ROOM_MODEL_ID;
    state.mutationViews.set(ROOM_MODEL_ID, markerView(ROOM_MODEL_ID));

    state.upsertModel(model(OWN_MODEL_ID));
    state.mutationViews.set(OWN_MODEL_ID, markerView(OWN_MODEL_ID));
    state.setActiveModel(OWN_MODEL_ID);
  }

  it('the premise: opening your own file makes it active while the room model stays registered', () => {
    joinRoomThenOpenOwnFile();
    assert.equal(state.activeModelId, OWN_MODEL_ID);
    assert.notEqual(state.activeModelId, ROOM_MODEL_ID);
    // The store-wide handles now track the user's file — this is exactly what
    // the old code read.
    assert.equal((state.ifcDataStore as unknown as { __tag: string }).__tag, OWN_MODEL_ID);
    assert.ok(state.models.has(ROOM_MODEL_ID));
  });

  it('resolves the room model by id, not by focus', () => {
    joinRoomThenOpenOwnFile();
    assert.equal(roomModelIdOf(target()), ROOM_MODEL_ID);
  });

  it('inbound: a peer edit resolves against the ROOM store, never the active one', () => {
    joinRoomThenOpenOwnFile();
    const store = roomStore(target()) as unknown as { __tag: string } | null;
    assert.ok(store, 'room store must resolve');
    assert.equal(store.__tag, ROOM_MODEL_ID);
    assert.notEqual(store.__tag, OWN_MODEL_ID);
  });

  it('inbound: a peer edit is written through the ROOM view, never the active one', () => {
    joinRoomThenOpenOwnFile();
    const view = roomMutationView(target()) as unknown as { __tag: string } | undefined;
    assert.ok(view, 'room view must resolve');
    assert.equal(view.__tag, ROOM_MODEL_ID);
    assert.notEqual(view.__tag, OWN_MODEL_ID);
  });

  it('outbound: an edit on the user’s private model is not mirrored into the room', () => {
    joinRoomThenOpenOwnFile();
    assert.equal(isRoomModel(target(), OWN_MODEL_ID), false);
  });

  it('outbound: an edit on the room model IS mirrored even while another model is active', () => {
    joinRoomThenOpenOwnFile();
    assert.equal(isRoomModel(target(), ROOM_MODEL_ID), true);
  });

  /**
   * A recipient who already had a file open gets no reconstruct until the first
   * peer edit, so `room:<roomId>` is named but not yet registered. Falling back
   * to the top-level store here is the whole defect in miniature: it resolves a
   * room-id-space path against the user's own file.
   */
  it('inbound: no store (not the user’s) while the room model is unregistered', () => {
    state.upsertModel(model(OWN_MODEL_ID));
    state.mutationViews.set(OWN_MODEL_ID, markerView(OWN_MODEL_ID));
    state.collabRoomModelId = ROOM_MODEL_ID;

    assert.equal(state.activeModelId, OWN_MODEL_ID);
    assert.ok(state.ifcDataStore, 'the user’s store is loaded and would be the fallback');
    assert.equal(roomStore(target()), null);
    assert.equal(roomMutationView(target()), undefined);
    assert.equal(isRoomModel(target(), OWN_MODEL_ID), false);
  });

  /**
   * Off a session (and for an owner sharing a bare legacy store with no model
   * record) there is no id to address, so every resolver must reduce to the
   * behaviour the call sites had before — a single-model session must not
   * change at all.
   */
  it('with no room model id, reduces to the pre-existing active-model behaviour', () => {
    state.upsertModel(model(OWN_MODEL_ID));
    state.mutationViews.set(OWN_MODEL_ID, markerView(OWN_MODEL_ID));

    assert.equal(state.collabRoomModelId, null);
    assert.equal(roomModelIdOf(target()), state.activeModelId);
    assert.equal(roomStore(target()), state.ifcDataStore);
    assert.equal(
      (roomMutationView(target()) as unknown as { __tag: string }).__tag,
      OWN_MODEL_ID,
    );
    assert.equal(isRoomModel(target(), OWN_MODEL_ID), true);
  });

  /**
   * The ordinary recipient: no local file, so the reconstruct's `upsertModel`
   * makes the room model active. Room targeting and active targeting agree,
   * which is why the defect stayed invisible.
   */
  it('when the room model IS active, room targeting and active targeting agree', () => {
    state.upsertModel(model(ROOM_MODEL_ID));
    state.collabRoomModelId = ROOM_MODEL_ID;
    state.mutationViews.set(ROOM_MODEL_ID, markerView(ROOM_MODEL_ID));

    assert.equal(state.activeModelId, ROOM_MODEL_ID);
    assert.equal(roomStore(target()), state.ifcDataStore);
    assert.equal(isRoomModel(target(), ROOM_MODEL_ID), true);
  });

  /**
   * The same defect on the GEOMETRY side, which the first pass missed:
   * `reconcilePlacementMesh` moves a mesh addressed by `globalId` (=
   * `idOffset + expressId` of a NAMED model) and pivots it about that mesh's
   * bbox centre, and both reads went through the ACTIVE model.
   *
   * It is not a fail-closed miss. The recipient's reconstructed room model is
   * registered with `idOffset: 0` and their own file is offset above it, so a
   * peer's edit on room entity 7 resolved to global 1_000_007 — which, in a
   * federation, is a REAL mesh of the user's own file. The delivered edit moves
   * an unrelated element of a model that is not even in the room.
   */
  describe('placement reconcile: the mesh is addressed in the ROOM model’s id space', () => {
    const ENTITY_ID = 7;
    const OWN_OFFSET = 1_000_000;

    /** Room model + own file, each with a mesh at the id the other's offset produces. */
    function federateWithMeshes(): void {
      state.upsertModel(model(ROOM_MODEL_ID, 0));
      state.collabRoomModelId = ROOM_MODEL_ID;
      state.setGeometryResult(buildGeometryResultFromMeshes([cubeAt(ENTITY_ID, 10)]));

      state.upsertModel(model(OWN_MODEL_ID, OWN_OFFSET));
      state.setActiveModel(OWN_MODEL_ID);
      state.setGeometryResult(
        buildGeometryResultFromMeshes([cubeAt(OWN_OFFSET + ENTITY_ID, 500)]),
      );
    }

    it('the premise: the room model’s offset is 0 and the user’s own file’s is not', () => {
      federateWithMeshes();
      assert.equal(state.models.get(ROOM_MODEL_ID)?.idOffset, 0);
      assert.equal(state.models.get(OWN_MODEL_ID)?.idOffset, OWN_OFFSET);
      assert.equal(state.activeModelId, OWN_MODEL_ID);
    });

    it('resolves the moved mesh’s globalId off the room model', () => {
      federateWithMeshes();
      const globalId = toGlobalIdFromModels(
        state.models,
        roomModelIdOf(target()) ?? '',
        ENTITY_ID,
      );
      assert.equal(globalId, ENTITY_ID);
    });

    it('the active-model spelling names a real mesh of a model that is not in the room', () => {
      federateWithMeshes();
      const wrong = toGlobalIdFromModels(state.models, state.activeModelId ?? '', ENTITY_ID);
      assert.equal(wrong, OWN_OFFSET + ENTITY_ID);
      assert.notEqual(wrong, ENTITY_ID);
      // Not a silent no-op: it hits geometry, so the edit is applied to the
      // wrong element rather than dropped.
      const hit = getEntityCenter(state.geometryResult?.meshes ?? null, wrong);
      assert.ok(hit, 'the wrong id resolves to a real mesh of the user’s own file');
      assert.equal(hit.x, 500);
    });

    it('takes the rotate pivot from the ROOM model’s meshes, not the active one’s', () => {
      federateWithMeshes();
      const globalId = toGlobalIdFromModels(
        state.models,
        roomModelIdOf(target()) ?? '',
        ENTITY_ID,
      );
      const centre = getEntityCenter(roomMeshes(target()), globalId);
      assert.ok(centre, 'the room mesh must resolve');
      assert.equal(centre.x, 10);
      // What the old read returned for that same id: nothing, so every rotate
      // a peer sent was dropped on the floor.
      assert.equal(getEntityCenter(state.geometryResult?.meshes ?? null, globalId), null);
    });

    it('with no room model id, reduces to the active model’s meshes', () => {
      state.upsertModel(model(OWN_MODEL_ID, OWN_OFFSET));
      state.setGeometryResult(buildGeometryResultFromMeshes([cubeAt(OWN_OFFSET + ENTITY_ID, 500)]));
      assert.equal(state.collabRoomModelId, null);
      assert.equal(roomMeshes(target()), state.geometryResult?.meshes);
    });

    it('yields no meshes (not the user’s) while the room model is unregistered', () => {
      state.upsertModel(model(OWN_MODEL_ID, OWN_OFFSET));
      state.setGeometryResult(buildGeometryResultFromMeshes([cubeAt(OWN_OFFSET + ENTITY_ID, 500)]));
      state.collabRoomModelId = ROOM_MODEL_ID;
      assert.ok(state.geometryResult?.meshes.length, 'the user’s meshes would be the fallback');
      assert.equal(roomMeshes(target()), null);
    });
  });
});
