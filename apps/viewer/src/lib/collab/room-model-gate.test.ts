/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression: resolving a room edit against a ROOM model's store is only safe
 * when the edit is ON that room model. Store selection and the room gate are
 * one decision, not two.
 *
 * `room-model-target.test.ts` pins the first half — the resolvers must name
 * the room's models rather than the active one. This file pins the half that
 * makes that safe, because getting the store right and the subject wrong is
 * *worse* than the bug it replaced:
 *
 *   - resolving against the user's OWN store yields a path in their own id
 *     space (`/MyWindow`). That path does not exist in the room's document, so
 *     `mirrorPlacement` fails closed on `hasEntity` and the edit is a silent
 *     no-op — wrong, but harmless.
 *   - resolving against the ROOM's store yields a REAL path of the shared model
 *     (`/OwnerWallB`) for that same expressId, because the room's `idToPath` is
 *     dense over its own ids. `hasEntity` now says yes, and an edit the user
 *     made on their PRIVATE model is written onto an unrelated peer's entity,
 *     for everyone.
 *
 * So every path that resolves a room store must first establish that the
 * model being edited IS a room model — which is what `roomStoreFor` does, as a
 * single call the caller cannot half-perform. Inbound, the same property holds
 * one step earlier: `roomEntityTargetForPath` names the model from the path's
 * slot and returns no store for a path outside the room's slots (#4444).
 *
 * The mechanism is exercised against the real collab document and the real
 * `mutation-bridge` (`pathForEntity`, `mirrorPlacement`), not a re-statement of
 * them, so what these tests turn on is the actual write path.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  createCollabDoc,
  createEntity,
  hasEntity,
  setEntityPlacement,
  getEntityPlacement,
  deleteEntity,
  setPropertyValue,
  deletePropertyValue,
  setAttribute,
  matrixToPlacement,
  USD_XFORMOP,
  PROPERTY_TYPE_NAMES,
} from '@ifc-lite/collab';
import type { CollabSession, ModelSlotRef } from '@ifc-lite/collab';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { mirrorPlacement, type CollabDocApi } from './mutation-bridge.js';
import { pathForEntity, registerEntityMaps } from './entity-paths.js';
import { roomEntityTargetForPath, roomStoreFor, type RoomModelTargetState } from './room-model-target.js';
import type { FederatedModel } from '../../store/types.js';

/** Minimal CollabDocApi over the real doc helpers, as `collabSlice` wires it. */
const api: CollabDocApi = {
  hasEntity: (doc, path) => hasEntity(doc, path),
  setPropertyValue: (doc, path, pset, prop, value) =>
    setPropertyValue(doc, path, pset, prop, {
      type: value.type,
      value: value.value,
      source: value.source,
    }),
  deletePropertyValue: (doc, path, pset, prop) => deletePropertyValue(doc, path, pset, prop),
  setAttribute: (doc, path, name, value) => setAttribute(doc, path, name, value),
  setEntityPlacement: (doc, path, placement) => setEntityPlacement(doc, path, placement),
  deleteEntity: (doc, path) => deleteEntity(doc, path),
  createEntity: (doc, path, options) => {
    createEntity(doc, path, options);
  },
  XFORMOP_KEY: USD_XFORMOP,
  placementFromXformOp: (value) => {
    const xform = value as { transform?: number[][] } | undefined;
    if (!xform || !Array.isArray(xform.transform)) return null;
    return matrixToPlacement(xform.transform);
  },
  PROPERTY_TYPE_NAMES,
};

function fakeSession(doc: ReturnType<typeof createCollabDoc>): CollabSession {
  return { doc, transact: (fn: () => void) => doc.transact(fn) } as unknown as CollabSession;
}

/** A store whose expressId↔path maps are the injected ones (an IFCX-origin store). */
function storeWithPaths(idToPath: Map<number, string>): IfcDataStore {
  const store = {} as IfcDataStore;
  const pathToId = new Map<string, number>();
  for (const [id, path] of idToPath) pathToId.set(path, id);
  registerEntityMaps(store, idToPath, pathToId);
  return store;
}

function model(id: string, store: IfcDataStore): FederatedModel {
  return { id, name: id, ifcDataStore: store } as unknown as FederatedModel;
}

const ROOM_MODEL_ID = 'room:r1:m0';
const OWN_MODEL_ID = 'my-file.ifc';
const SLOT_M0: ModelSlotRef = { slotId: 'm0', pathPrefix: '/m0' };
/** The one expressId that means something different in each model. */
const SHARED_ID = 2;
const ROOM_PATH = '/m0/OwnerWallB';
const OWN_PATH = '/MyWindow';

describe('room edits are gated on the room model, not just resolved against it', () => {
  let doc: ReturnType<typeof createCollabDoc>;
  let session: CollabSession;
  let roomModelStore: IfcDataStore;
  let ownModelStore: IfcDataStore;
  let state: RoomModelTargetState;

  beforeEach(() => {
    // The room's document holds the owner's model. `/MyWindow` is NOT in it.
    doc = createCollabDoc();
    createEntity(doc, ROOM_PATH, { ifcClass: 'IfcWall' });
    setEntityPlacement(doc, ROOM_PATH, { location: [0, 0, 0] });
    session = fakeSession(doc);

    // Same expressId, two id spaces: the room's maps are dense over the room's
    // own ids, so a foreign id still resolves — to the wrong entity.
    roomModelStore = storeWithPaths(new Map([[SHARED_ID, ROOM_PATH]]));
    ownModelStore = storeWithPaths(new Map([[SHARED_ID, OWN_PATH]]));

    // The two-click state: joined a room, then loaded and selected own file.
    state = {
      collabRoomModels: new Map([[ROOM_MODEL_ID, SLOT_M0]]),
      // A live session: `startCollab` sets this in the same `set()` call as
      // `collabRoomModels`, before any await — see room-model-target.ts.
      collabRoomId: 'r1',
      activeModelId: OWN_MODEL_ID,
      models: new Map([
        [ROOM_MODEL_ID, model(ROOM_MODEL_ID, roomModelStore)],
        [OWN_MODEL_ID, model(OWN_MODEL_ID, ownModelStore)],
      ]),
      ifcDataStore: ownModelStore,
      mutationViews: new Map<string, MutablePropertyView>(),
      // Not exercised here (these tests are about stores, not meshes); the
      // mesh-side addressing is pinned in `room-model-target.test.ts`.
      geometryResult: null,
    };
  });

  /**
   * The mechanism, stated as a fact about the two stores: one expressId, two
   * real paths, and only the room's is live ammunition against the room's doc.
   * This is why store selection cannot be made without the subject.
   */
  it('one expressId resolves to a REAL room path via the room store, and a dead one via the user’s', () => {
    assert.equal(pathForEntity(roomModelStore, SHARED_ID), ROOM_PATH);
    assert.equal(pathForEntity(ownModelStore, SHARED_ID), OWN_PATH);
    // The room's doc accepts one and rejects the other — `mirrorPlacement`'s
    // fail-closed `hasEntity` check is the only thing that made the old
    // (own-store) behaviour a harmless no-op.
    assert.equal(hasEntity(doc, ROOM_PATH), true);
    assert.equal(hasEntity(doc, OWN_PATH), false);
  });

  /**
   * The corruption, run for real: resolve the room store with no gate —
   * exactly what an ungated `collabTranslateEntity` / `collabRotateEntity` /
   * `readCollabPlacement` does — while the user edits their PRIVATE model.
   * A peer's wall moves.
   */
  it('ungated: an edit on the user’s private model overwrites a peer’s entity', () => {
    const ungated = state.models.get(ROOM_MODEL_ID)?.ifcDataStore;
    assert.ok(ungated, 'the room store resolves regardless of which model is edited');
    mirrorPlacement(api, session, ungated, SHARED_ID, { location: [9, 9, 9] });
    assert.deepEqual(
      getEntityPlacement(doc, ROOM_PATH)?.location,
      [9, 9, 9],
      'without a gate the shared model IS corrupted — this is the path being fixed',
    );
  });

  /**
   * The fix: store selection and the room gate are one call. Editing the user's
   * own model yields no store at all, so the mirror is never reached.
   */
  it('gated: an edit on the user’s private model resolves no store, and the room is untouched', () => {
    const store = roomStoreFor(state, OWN_MODEL_ID);
    assert.equal(store, null, 'the user’s own model is not a room model');
    // The caller returns here. Nothing is written.
    assert.deepEqual(getEntityPlacement(doc, ROOM_PATH)?.location, [0, 0, 0]);
  });

  it('gated: an edit on the ROOM model still resolves the room store and applies', () => {
    const store = roomStoreFor(state, ROOM_MODEL_ID);
    assert.equal(store, roomModelStore);
    mirrorPlacement(api, session, store!, SHARED_ID, { location: [1, 2, 3] });
    assert.deepEqual(getEntityPlacement(doc, ROOM_PATH)?.location, [1, 2, 3]);
  });

  /**
   * Inbound is gated one step earlier, by the path (#4444): a peer edit at a
   * room path names the room model; the user's own path names nothing.
   */
  it('inbound: a room path resolves the room model, a path outside every slot resolves nothing', () => {
    assert.deepEqual(roomEntityTargetForPath(state, ROOM_PATH), { modelId: ROOM_MODEL_ID, store: roomModelStore });
    assert.equal(roomEntityTargetForPath(state, OWN_PATH), null);
  });

  /**
   * Off a session there are no room models, so the gate must reduce to the
   * pre-existing behaviour: the active model is the subject and its store is
   * the top-level one. A single-model session must not change at all.
   */
  it('with no room models, reduces to the pre-existing active-model behaviour', () => {
    // OFF a session entirely — `collabRoomId: null` too — is what "no room
    // models" means pre-existing-behaviour-wise. See the next test for the
    // DIFFERENT (fail-closed) case: an empty map WHILE a session is live.
    const solo: RoomModelTargetState = { ...state, collabRoomModels: new Map(), collabRoomId: null };
    assert.equal(roomStoreFor(solo, OWN_MODEL_ID), ownModelStore);
    assert.equal(roomStoreFor(solo, ROOM_MODEL_ID), null);
  });

  /**
   * MAJOR (CodeRabbit CLI, PR #2706 review): `ShareDialog` awaits
   * `mintRoomToken()` and does not re-check cancellation before calling
   * `startCollab`. If the last model is removed during that await,
   * `startCollab` runs with nothing to seed and records an empty
   * `collabRoomModels` — WHILE `collabRoomId` is already set (a live
   * session). The old resolver could not tell this apart from "no session"
   * and fell back to `activeModelId`, which would target whatever the user
   * loads next. Must fail closed instead: no store, for any model, any path.
   */
  it('a live session with no room models (removed mid-mint) fails closed, never falls back to active', () => {
    const raced: RoomModelTargetState = { ...state, collabRoomModels: new Map(), collabRoomId: 'r1' };
    assert.equal(roomStoreFor(raced, OWN_MODEL_ID), null);
    assert.equal(roomStoreFor(raced, ROOM_MODEL_ID), null);
    assert.equal(roomEntityTargetForPath(raced, ROOM_PATH), null, 'must not silently resolve to the active model’s store');
    assert.equal(roomEntityTargetForPath(raced, OWN_PATH), null);
  });

  /**
   * A recipient whose `room:<roomId>:<slot>` is named but not yet
   * reconstructed: the gate says "a room model" but there is no store to
   * resolve. The answer must be "no store", never the user's own.
   */
  it('the room model is named but unregistered: no store, not the user’s', () => {
    const pending: RoomModelTargetState = { ...state, models: new Map() };
    assert.equal(roomStoreFor(pending, ROOM_MODEL_ID), null);
    assert.equal(roomStoreFor(pending, OWN_MODEL_ID), null);
    assert.equal(roomEntityTargetForPath(pending, ROOM_PATH), null);
  });
});
