/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which model does a collab room's edits belong to?
 *
 * Every edit that crosses the room boundary — inbound (a peer's edit replayed
 * into a local `MutablePropertyView`) and outbound (a local edit mirrored into
 * the CRDT) — carries an expressId in the ROOM's id space. It is only
 * meaningful against the room's model. The edit paths resolved that model as
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
 *     entityId from the room's id space. That lands in `undoStacks`,
 *     `dirtyModels` and the export path, so it survives a reload and ships in
 *     their exported IFC;
 *   - the user's edits on their PRIVATE model were mirrored into the shared
 *     room and applied to whatever entity the id resolved to there, corrupting
 *     the owner's model for everyone.
 *
 * This module is the single place that answers the question, so the inbound
 * and outbound paths cannot drift apart again — they were two expressions of
 * the same rule, and that is what let one of them be wrong.
 *
 * The room model is an observation, not a policy: for an owner it is the model
 * that was seeded into the room (the one active when they pressed Share), for
 * a recipient it is the reconstructed `room:<roomId>`. Nothing here decides
 * what *should* happen when a user opens a second file mid-session, and
 * nothing here changes which model is active.
 *
 * Addressing follows `room-model-apply.ts`: name the room model by id, and use
 * the active-model value only as the pre-session fallback.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FederatedModel } from '@/store/types';

/** The slice fields this resolution needs (a narrow view of the viewer store). */
export interface RoomModelTargetState {
  /**
   * The room's model id, fixed for the session in `startCollab`. `null` when
   * there is no session — or when an owner shared a bare legacy store that has
   * no model record at all, in which case there is no id to address and the
   * pre-existing active-model behaviour is the only thing available.
   */
  collabRoomModelId: string | null;
  activeModelId: string | null;
  models: Map<string, FederatedModel>;
  ifcDataStore: IfcDataStore | null;
  mutationViews: Map<string, MutablePropertyView>;
}

/**
 * The id of the model a room's edits belong to.
 *
 * Falls back to `activeModelId` only when no room model id was recorded, which
 * is exactly the no-session / no-model-record case: off a session this reduces
 * to the behaviour every caller had before, so single-model sessions are
 * unaffected.
 */
export function roomModelIdOf(state: RoomModelTargetState): string | null {
  return state.collabRoomModelId ?? state.activeModelId;
}

/** True when `modelId` is the room's model — the gate for mirroring outbound. */
export function isRoomModel(state: RoomModelTargetState, modelId: string): boolean {
  const target = roomModelIdOf(state);
  return target !== null && modelId === target;
}

/**
 * The store an inbound room edit must be resolved against (path ↔ expressId).
 *
 * Deliberately does NOT fall back to the top-level `ifcDataStore` when the room
 * model is known but not registered yet — a recipient's `room:<roomId>` does
 * not exist until the first reconstruct completes. Falling back there is the
 * defect: it resolves a room-id-space path against the user's own file. Until
 * the room model exists the correct answer is "no store", and the caller drops
 * the event; the next reconstruct rebuilds the whole model from the CRDT
 * anyway, so nothing is lost.
 */
export function roomStore(state: RoomModelTargetState): IfcDataStore | null {
  const id = state.collabRoomModelId;
  if (id === null) return state.ifcDataStore;
  return state.models.get(id)?.ifcDataStore ?? null;
}

/**
 * The store an OUTBOUND room edit must be resolved against — the room's, but
 * only when `modelId` IS the room's model. `null` means "do not mirror".
 *
 * Store selection and the room gate are one decision, and this is the call that
 * makes them inseparable. Splitting them is worse than the bug they replace:
 * resolving a foreign expressId against the user's OWN store yields a path in
 * their own id space, which the room's document does not contain, so
 * `mirrorPlacement` fails closed on `hasEntity` and the edit is a silent
 * no-op. Resolving that same id against the ROOM's store yields a REAL path of
 * the shared model — the room's `idToPath` is dense over its own ids — so the
 * write lands on an unrelated peer's entity, for everyone. A caller that picks
 * the right store and forgets the subject is armed, not fixed.
 *
 * See `room-model-gate.test.ts`, which runs both halves against the real
 * document.
 */
export function roomStoreFor(
  state: RoomModelTargetState,
  modelId: string,
): IfcDataStore | null {
  if (!isRoomModel(state, modelId)) return null;
  return roomStore(state);
}

/**
 * The editable view an inbound room edit must be written through, or
 * `undefined` when the room model has none registered yet (a view is created
 * when a model is selected). Dropping the edit is correct: the alternative is
 * writing it into another model.
 */
export function roomMutationView(state: RoomModelTargetState): MutablePropertyView | undefined {
  const id = roomModelIdOf(state);
  return id === null ? undefined : state.mutationViews.get(id);
}
