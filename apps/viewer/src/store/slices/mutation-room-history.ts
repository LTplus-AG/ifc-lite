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

interface PublishedEdit {
  /** The new value's types, as the forward edit published them. */
  valueType?: PropertyValueType;
  dataType?: string;
  /** The property's types before the edit, which an undo restores. Absent when it did not exist or was not loaded. */
  previousType?: PropertyValueType;
  previousDataType?: string;
}

const published = new WeakMap<Mutation, PublishedEdit>();

/** The effective property row before an edit, for the types its undo must restore. */
export function propertyBefore(view: MutablePropertyView, entityId: number, psetName: string, propName: string): { type: PropertyValueType; dataType?: string } | undefined {
  return view.getForEntity(entityId).find(set => set.name === psetName)?.properties.find(property => property.name === propName);
}

/** Record that `mutation` was mirrored into the room, so its undo and redo are too. */
export function rememberPublishedEdit(mutation: Mutation, edit: PublishedEdit = {}): void {
  published.set(mutation, edit);
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
  if (!edit || !state.canCollabEdit()) return;
  const { entityId, psetName, propName, attributeName } = mutation;
  if (mutation.type === 'UPDATE_ATTRIBUTE') {
    if (!attributeName) return;
    const value = direction === 'redo' ? mutation.newValue
      : mutation.oldValue !== undefined && mutation.oldValue !== null ? mutation.oldValue
        : sourceAttributeValue(state, modelId, entityId, attributeName);
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
  const restoring = direction === 'undo' && edit.previousType !== undefined;
  state.mirrorPropertyEdit(modelId, entityId, psetName, propName, value,
    (restoring ? edit.previousType : edit.valueType) ?? PropertyValueType.String,
    restoring ? edit.previousDataType : edit.dataType);
}
