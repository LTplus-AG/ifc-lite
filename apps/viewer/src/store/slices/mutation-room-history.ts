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

import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import type { Mutation, MutablePropertyView } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';
import { roomSlotFor } from '@/lib/collab/room-model-target.js';

interface ValueTypes { type: PropertyValueType; dataType?: string }
interface PublishedEdit {
  /** The room the edit went to: after a room change, its undo is local only. */
  roomId: string;
  /** The value types the forward edit published, which a redo publishes again. */
  forward?: ValueTypes;
  /** The property's types before the edit, which an undo restores. Absent when it did not exist or was not loaded. */
  inverse?: ValueTypes;
}

const published = new WeakMap<Mutation, PublishedEdit>();

/** The room `modelId`'s edits are mirrored to, or null when they stay local. */
export function mirroredRoom(state: ViewerState, modelId: string): string | null {
  return state.collabRoomId && roomSlotFor(state, modelId) ? state.collabRoomId : null;
}

/** The effective property row before an edit, for the types its undo must restore. */
export function propertyBefore(view: MutablePropertyView, entityId: number, psetName: string, propName: string): ValueTypes | undefined {
  const row = view.getForEntity(entityId).find(set => set.name === psetName)?.properties.find(property => property.name === propName);
  return row && { type: row.type, dataType: row.dataType };
}

/** Record that `mutation` was mirrored into `roomId`, so its undo and redo are too. */
export function rememberPublishedEdit(mutation: Mutation, roomId: string, types: Omit<PublishedEdit, 'roomId'> = {}): void {
  published.set(mutation, { roomId, ...types });
}

/** The source record's own value of `attrName`, which undoing an edit with no recorded prior value restores. */
function sourceAttributeValue(state: ViewerState, modelId: string, entityId: number, attrName: string): unknown {
  const entity = (state.models.get(modelId)?.ifcDataStore ?? state.ifcDataStore)?.getEntity?.(entityId);
  if (!entity) return undefined;
  const index = getAttributeNamesAcrossSchemas(entity.type).indexOf(attrName);
  return index < 0 ? undefined : entity.attributes[index] ?? null;
}

/**
 * Publish what an applied undo or redo step left, for a mutation the forward edit published. Gated like the forward
 * edit on the collab role; the mirrors themselves no-op outside a room and for any model but the room's.
 */
export function mirrorHistoryStep(get: () => ViewerState, modelId: string, mutation: Mutation, direction: 'undo' | 'redo'): void {
  const edit = published.get(mutation), state = get();
  if (!edit || edit.roomId !== state.collabRoomId || !state.canCollabEdit()) return;
  const { entityId, psetName, propName, attributeName } = mutation;
  if (mutation.type === 'UPDATE_ATTRIBUTE') {
    if (!attributeName) return;
    const value = direction === 'redo' ? mutation.newValue
      : mutation.oldValue ?? sourceAttributeValue(state, modelId, entityId, attributeName);
    if (value === undefined) return;
    state.mirrorAttributeEdit(modelId, entityId, attributeName, value === null ? null : String(value));
    return;
  }
  if (!psetName || !propName) return;
  const removed = direction === 'undo' ? mutation.type === 'CREATE_PROPERTY' : mutation.type === 'DELETE_PROPERTY';
  if (removed) {
    state.mirrorPropertyDelete(modelId, entityId, psetName, propName);
    return;
  }
  const value = direction === 'undo' ? mutation.oldValue : mutation.newValue;
  if (value === undefined) return;
  const types = direction === 'undo' ? edit.inverse ?? edit.forward : edit.forward;
  state.mirrorPropertyEdit(modelId, entityId, psetName, propName, value, types?.type ?? PropertyValueType.String, types?.dataType);
}
