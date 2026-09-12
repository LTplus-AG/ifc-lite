/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which model does a collab room's edit belong to?
 *
 * Every edit that crosses the room boundary — inbound (a peer's edit replayed
 * into a local `MutablePropertyView`) and outbound (a local edit mirrored into
 * the CRDT) — carries an expressId in ONE model's id space. It is only
 * meaningful against that model. The edit paths used to resolve the model as
 * "whatever is active": `activeModelId` for the inbound view and the outbound
 * gate, and the top-level `ifcDataStore` (which tracks the active model) for
 * path resolution.
 *
 * The active model is not the room model. `upsertModel` keeps the existing
 * `activeModelId` rather than switching to the model it creates
 * (modelSlice.ts), so a recipient who joins a room and then loads and selects
 * their own file — two clicks — has a different model active. From that point:
 *
 *   - a peer's edit was written into the USER'S OWN model's view, under an
 *     entityId from the room's id space. The inbound handlers call the view
 *     directly, so it does NOT reach `undoStacks` / `dirtyModels` (those are
 *     written only by `mutationSlice` actions). It lands in the view's overlay
 *     and its append-only `mutationHistory`, which is what the exporter and
 *     `getModifiedEntityCount` read — so it survives a reload, counts as a
 *     modified element and ships in their exported IFC;
 *   - the user's edits on their PRIVATE model were mirrored into the shared
 *     room and applied to whatever entity the id resolved to there, corrupting
 *     the owner's model for everyone.
 *
 * A room holds one model per SLOT (#4444): the owner can share every loaded
 * model, and a recipient reconstructs one viewer model per slot. So "the room
 * model" is a set, `collabRoomModels` (viewer model id → slot), and every
 * resolver here is keyed by the model an edit names — outbound by the edited
 * `modelId`, inbound by the entity path, whose slot prefix names the model.
 * This module is the single place that answers the question, so the inbound
 * and outbound paths cannot drift apart again — they were two expressions of
 * the same rule, and that is what let one of them be wrong.
 *
 * The room models are an observation, not a policy: for an owner they are the
 * models that were seeded into the room (the share scope chosen in the Share
 * dialog), for a recipient the reconstructed `room:<roomId>:<slotId>` models.
 * Nothing here decides what *should* happen when a user opens another file
 * mid-session, and nothing here changes which model is active.
 *
 * Addressing follows `room-model-apply.ts`: name the room model by id, and use
 * the active-model value only as the pre-session fallback.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { ModelSlotRef } from '@ifc-lite/collab';
import type { FederatedModel } from '@/store/types';
import type { RoomEntityTarget } from './mutation-bridge';

/** The slice fields this resolution needs (a narrow view of the viewer store). */
export interface RoomModelTargetState {
  /**
   * The models this room's edits belong to, viewer model id → room slot,
   * fixed for the session in `startCollab`. Empty when there is no session —
   * or when an owner pressed Share with nothing to seed (the last model was
   * removed during the token mint), in which case there is no id to address
   * and every resolver below fails closed for the life of the session.
   */
  collabRoomModels: ReadonlyMap<string, ModelSlotRef>;
  /**
   * `null` off a session, non-null the instant `startCollab` begins — set in
   * the SAME synchronous `set()` call as `collabRoomModels`, before any await,
   * so the two are never observed out of step. This is the "is a session live"
   * signal the resolvers below gate on: `ShareDialog` awaits `mintRoomToken()`
   * and does not re-check cancellation before calling `startCollab`, so if the
   * last model is removed during that await, `startCollab` runs with nothing
   * to seed and records an empty `collabRoomModels` — WHILE a session is live.
   * Falling back to `activeModelId` in that state would target whatever the
   * user loads next, which is exactly the corruption this module exists to
   * prevent. Off a session (`collabRoomId === null`) the active-model fallback
   * is safe: there is no room boundary yet for it to misaddress.
   */
  collabRoomId: string | null;
  activeModelId: string | null;
  models: Map<string, FederatedModel>;
  ifcDataStore: IfcDataStore | null;
  mutationViews: Map<string, MutablePropertyView>;
  /** Active model's meshes — the pre-session fallback for `roomMeshesFor` only. */
  geometryResult: GeometryResult | null;
}

/** Whether `startCollab` has run for the current session — see `collabRoomId` above. */
function sessionIsLive(state: RoomModelTargetState): boolean {
  return state.collabRoomId !== null;
}

/**
 * The room slot `modelId` is shared under, or `null` when it is not a room
 * model. Only meaningful DURING a session; off a session no model is in a
 * room. `null` off a session too — the pre-session fallbacks below are about
 * the active model, not about slots.
 */
export function roomSlotFor(state: RoomModelTargetState, modelId: string): ModelSlotRef | null {
  if (!sessionIsLive(state)) return null;
  return state.collabRoomModels.get(modelId) ?? null;
}

/** The ids of the room's models, in slot order (empty off a session). */
export function roomModelIds(state: RoomModelTargetState): string[] {
  if (!sessionIsLive(state)) return [];
  return Array.from(state.collabRoomModels.keys());
}

/**
 * True when `modelId` is one of the room's models — the gate for mirroring
 * outbound. Falls back to `activeModelId` only OFF A SESSION, which is exactly
 * the no-session case: this reduces to the behaviour every caller had before,
 * so single-model, non-collab use is unaffected. DURING a live session an
 * empty `collabRoomModels` is never guessed at — see the field doc on
 * `collabRoomId` for why guessing here is the bug, not a convenience.
 */
export function isRoomModel(state: RoomModelTargetState, modelId: string): boolean {
  if (sessionIsLive(state)) return state.collabRoomModels.has(modelId);
  return state.activeModelId !== null && modelId === state.activeModelId;
}

/**
 * The store an OUTBOUND room edit must be resolved against — the room's model
 * `modelId` is shared as, but only when `modelId` IS one of the room's models.
 * `null` means "do not mirror".
 *
 * Store selection and the room gate are one decision, and this is the call that
 * makes them inseparable. Splitting them is worse than the bug they replace:
 * resolving a foreign expressId against the user's OWN store yields a path in
 * their own id space, which the room's document does not contain, so
 * `mirrorPlacement` fails closed on `hasEntity` and the edit is a silent
 * no-op. Resolving that same id against a ROOM model's store yields a REAL
 * path of the shared model — the room's `idToPath` is dense over its own ids —
 * so the write lands on an unrelated peer's entity, for everyone. A caller that
 * picks the right store and forgets the subject is armed, not fixed.
 *
 * Deliberately does NOT fall back to the top-level `ifcDataStore` when the room
 * model is known but not registered yet — a recipient's `room:<roomId>:<slot>`
 * does not exist until the first reconstruct completes. Falling back there is
 * the defect: it resolves a room-id-space path against the user's own file.
 * Until the room model exists the correct answer is "no store", and the caller
 * drops the edit; the next reconstruct rebuilds the whole model from the CRDT
 * anyway, so nothing is lost. The `state.ifcDataStore` fallback below only
 * fires OFF a session.
 *
 * See `room-model-gate.test.ts`, which runs both halves against the real
 * document.
 */
export function roomStoreFor(state: RoomModelTargetState, modelId: string): IfcDataStore | null {
  if (!isRoomModel(state, modelId)) return null;
  if (!sessionIsLive(state)) return state.ifcDataStore;
  return state.models.get(modelId)?.ifcDataStore ?? null;
}

/**
 * The model an INBOUND room edit at `entityPath` belongs to, resolved by the
 * path's slot prefix: the room model registered for that slot, and its store.
 * `null` drops the event — the slot is unknown, the model is not registered
 * yet (recipient before the first reconstruct), or the path belongs to no
 * slot of this room. Same fail-closed rule as `roomStoreFor`: never the
 * active model, never the top-level store, during a live session.
 *
 * Off a session (`collabRoomId === null`) there is no room boundary and no
 * observer attached, so the active-model fallback keeps the resolver total
 * for the pre-session callers that used it.
 */
export function roomEntityTargetForPath(
  state: RoomModelTargetState,
  entityPath: string,
): RoomEntityTarget | null {
  if (!sessionIsLive(state)) {
    const modelId = state.activeModelId;
    return modelId !== null && state.ifcDataStore ? { modelId, store: state.ifcDataStore } : null;
  }
  for (const [modelId, slot] of state.collabRoomModels) {
    const inSlot = slot.pathPrefix === '' || entityPath.startsWith(`${slot.pathPrefix}/`);
    if (!inSlot) continue;
    const store = state.models.get(modelId)?.ifcDataStore ?? null;
    return store ? { modelId, store } : null;
  }
  return null;
}

/**
 * The meshes a room edit's *rendered* effect must be measured against.
 *
 * The companion to `roomStoreFor` on the geometry side. A placement edit is
 * applied to a mesh addressed by `globalId` (= the model's `idOffset` +
 * expressId) and pivoted about that mesh's bbox centre, so reading the centre
 * out of the ACTIVE model's meshes is the same defect one layer down: the id
 * names a different mesh, or none, in a model with another offset.
 *
 * Mirrors `roomStoreFor`'s addressing exactly — including deliberately NOT
 * falling back to the active model's meshes while the room model is known but
 * not yet registered.
 *
 * Reading the RECORD rather than the top-level `geometryResult` is current in
 * both directions, by two different mechanisms: `setGeometryResult` and
 * `appendGeometryBatch` write through to the active model's record
 * (dataSlice.ts), which covers an owner and a streaming load, and a
 * recipient's room model — the case this mainly exists for, since it is
 * usually NOT active — is kept current by `applyRoomModelData`'s `updateModel`
 * branch (room-model-apply.ts).
 */
export function roomMeshesFor(state: RoomModelTargetState, modelId: string): MeshData[] | null {
  if (!isRoomModel(state, modelId)) return null;
  if (!sessionIsLive(state)) return state.geometryResult?.meshes ?? null;
  return state.models.get(modelId)?.geometryResult?.meshes ?? null;
}

/**
 * The editable view an inbound room edit must be written through, or
 * `undefined` when `modelId` is not a room model or has no view registered
 * yet (a view is created when a model is selected). Dropping the edit is
 * correct: the alternative is writing it into another model.
 */
export function roomMutationViewFor(
  state: RoomModelTargetState,
  modelId: string,
): MutablePropertyView | undefined {
  if (!isRoomModel(state, modelId)) return undefined;
  return state.mutationViews.get(modelId);
}
