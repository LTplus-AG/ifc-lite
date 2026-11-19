/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo and redo publish to the collab room exactly what the forward edit published (#10695).
 *
 * The store's own property and attribute actions mirror each edit into the room; commands that write through a
 * draft editor (modelling, roofs) publish on their own terms, or not at all. So history replay cannot mirror every
 * step it applies: it would republish writes a command never shared, and bypass a command's own rollback. Instead
 * the forward action records what it published, with the value types the room needs, and an undo or redo of that
 * mutation publishes its inverse in kind. A mutation with no record replays locally, as before. An attribute undo
 * needs the prior value the edit recorded; without one it replays locally and the user gets the room notice. A move
 * records its element and delta, since its mutation is the placement point's.
 */

import { PropertyValueType } from '@ifc-lite/data';
import type { Mutation, MutablePropertyView } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';
import { roomSlotFor } from '@/lib/collab/room-model-target.js';

interface ValueTypes { type: PropertyValueType; dataType?: string }
type Session = NonNullable<ViewerState['collabSession']>;
interface PublishedEdit {
  /** The session the edit went to: after leaving it (even to rejoin the same room), its undo is local only. A token,
   * so history never keeps a left session's document alive. */
  session: symbol;
  /** The value types the forward edit published, which a redo publishes again. */
  forward?: ValueTypes;
  /** The property's types before the edit, which an undo restores. Absent when it did not exist or was not loaded. */
  inverse?: ValueTypes;
  /** The attribute's value before the edit, which an undo publishes: null when it was unset. Absent when the caller
   * did not know it. */
  attributePrior?: string | null;
  /** A move's element and IFC-frame delta (metres), which an undo publishes reversed and a redo again. */
  placement?: { entityId: number; delta: readonly [number, number, number] };
}

const published = new WeakMap<Mutation, PublishedEdit>();
const sessionTokens = new WeakMap<Session, symbol>();
function tokenOf(session: Session): symbol {
  let token = sessionTokens.get(session);
  if (!token) sessionTokens.set(session, token = Symbol('collab-session'));
  return token;
}

/** The live session `modelId`'s edits are mirrored to, or null when they stay local. */
export function mirroredSession(state: ViewerState, modelId: string): Session | null {
  return state.collabRoomId && state.collabSession && roomSlotFor(state, modelId) ? state.collabSession : null;
}

/** The effective property row before an edit, for the types its undo must restore. */
export function propertyBefore(view: MutablePropertyView, entityId: number, psetName: string, propName: string): ValueTypes | undefined {
  const row = view.getForEntity(entityId).find(set => set.name === psetName)?.properties.find(property => property.name === propName);
  return row && { type: row.type, dataType: row.dataType };
}

/** Record that `mutation` was mirrored into `session`, so its undo and redo are too. */
export function rememberPublishedEdit(mutation: Mutation, session: Session, types: Omit<PublishedEdit, 'session'> = {}): void {
  published.set(mutation, { session: tokenOf(session), ...types });
}

/** Mirror a move into the room and record it against its mutation, so its undo and redo move the room's copy too. */
export function publishMove(state: ViewerState, modelId: string, mutation: Mutation | null | undefined,
  entityId: number, delta: readonly [number, number, number]): void {
  state.mirrorPlacementEdit(modelId, entityId, [delta[0], delta[1], delta[2]]);
  const session = mirroredSession(state, modelId);
  // History holds the committed copy of an atomic edit's mutation, so the record goes on that one, found by id from
  // the stack's end, where a move just landed.
  const stack = state.undoStacks.get(modelId) ?? [];
  let committed = mutation;
  for (let index = stack.length - 1; mutation && index >= 0; index--) {
    if (stack[index].id === mutation.id) { committed = stack[index]; break; }
  }
  // A copy of the delta: the caller's array may be reused, as a drag's per-frame one is.
  if (session && committed) rememberPublishedEdit(committed, session, { placement: { entityId, delta: [delta[0], delta[1], delta[2]] } });
}

/** Send what an undo or redo step left, if it left anything; false when the room cannot be given the prior value. */
function publishStep(state: ViewerState, modelId: string, mutation: Mutation, edit: PublishedEdit, direction: 'undo' | 'redo'): boolean {
  const { entityId, psetName, propName, attributeName } = mutation;
  // A move's record sits on one mutation of its batch, whatever that mutation's own type.
  if (edit.placement) {
    const sign = direction === 'undo' ? -1 : 1, [x, y, z] = edit.placement.delta;
    state.mirrorPlacementEdit(modelId, edit.placement.entityId, [sign * x, sign * y, sign * z]);
    return true;
  }
  if (mutation.type === 'UPDATE_ATTRIBUTE') {
    if (!attributeName) return true;
    if (direction === 'redo') {
      if (mutation.newValue !== undefined) state.mirrorAttributeEdit(modelId, entityId, attributeName, mutation.newValue === null ? '$' : String(mutation.newValue));
      return true;
    }
    // An undo restores the prior value only when the forward caller recorded it: it is not known here for a created
    // entity's payload, a select or a reference slot. An unset prior publishes `$`, as clearing the attribute does.
    if (edit.attributePrior === undefined) return false;
    state.mirrorAttributeEdit(modelId, entityId, attributeName, edit.attributePrior ?? '$');
    return true;
  }
  if (!psetName || !propName) return true;
  if (direction === 'undo' ? mutation.type === 'CREATE_PROPERTY' : mutation.type === 'DELETE_PROPERTY') {
    state.mirrorPropertyDelete(modelId, entityId, psetName, propName);
    return true;
  }
  const value = direction === 'undo' ? mutation.oldValue : mutation.newValue;
  if (value === undefined) return true;
  const types = direction === 'undo' ? edit.inverse ?? edit.forward : edit.forward;
  state.mirrorPropertyEdit(modelId, entityId, psetName, propName, value, types?.type ?? PropertyValueType.String, types?.dataType);
  return true;
}

/**
 * Publish what an applied undo or redo step left, for a mutation the forward edit published to this same session.
 * Gated like the forward edit on the collab role. The local step has already happened, so a publication failure
 * (a value the room's type rejects) becomes a room notice, never an error thrown into the history replay.
 */
export function mirrorHistoryStep(get: () => ViewerState, set: (patch: Partial<ViewerState>) => void,
  modelId: string, mutation: Mutation, direction: 'undo' | 'redo'): void {
  const edit = published.get(mutation), state = get();
  if (!edit || !state.collabSession || edit.session !== tokenOf(state.collabSession) || !state.canCollabEdit()) return;
  let shared: boolean;
  try { shared = publishStep(state, modelId, mutation, edit, direction); }
  catch (error) {
    console.error(`[collab] ${direction} of #${mutation.entityId} was not published to the room`, error);
    shared = false;
  }
  if (!shared) set({ collabGeometryNotice: `Your ${direction} was applied locally, but could not be shared with the room.` });
}
