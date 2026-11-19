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
 * mutation publishes its inverse in kind. A mutation with no record replays locally, as before.
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

/** Send what an undo or redo step left, if it left anything to send. */
function publishStep(state: ViewerState, modelId: string, mutation: Mutation, edit: PublishedEdit, direction: 'undo' | 'redo'): void {
  const { entityId, psetName, propName, attributeName } = mutation;
  if (mutation.type === 'UPDATE_ATTRIBUTE') {
    // An undo restores a prior value only when the edit recorded one. Without it the original is not known here (a
    // created entity's payload, a select, a reference slot), so the step stays local: see #10695 follow-ups.
    const value = direction === 'redo' ? mutation.newValue : mutation.oldValue;
    if (attributeName && value !== undefined && value !== null) state.mirrorAttributeEdit(modelId, entityId, attributeName, String(value));
    return;
  }
  if (!psetName || !propName) return;
  if (direction === 'undo' ? mutation.type === 'CREATE_PROPERTY' : mutation.type === 'DELETE_PROPERTY') {
    state.mirrorPropertyDelete(modelId, entityId, psetName, propName);
    return;
  }
  const value = direction === 'undo' ? mutation.oldValue : mutation.newValue;
  if (value === undefined) return;
  const types = direction === 'undo' ? edit.inverse ?? edit.forward : edit.forward;
  state.mirrorPropertyEdit(modelId, entityId, psetName, propName, value, types?.type ?? PropertyValueType.String, types?.dataType);
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
  try { publishStep(state, modelId, mutation, edit, direction); }
  catch (error) {
    console.error(`[collab] ${direction} of #${mutation.entityId} was not published to the room`, error);
    set({ collabGeometryNotice: `Your ${direction} was applied locally, but could not be shared with the room.` });
  }
}
