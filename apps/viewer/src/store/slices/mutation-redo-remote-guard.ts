/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mutation, MutablePropertyView } from '@ifc-lite/mutations';
import type { MutationMeshTranslation } from './mutation-history-prune.js';

/** Peer edits invalidate local history for the same entity in both directions.
 * A queued undo is just as capable of overwriting a peer's write as redo. */
export function invalidateHistoryPatch(
  undoStacks: Map<string, Mutation[]>, redoStacks: Map<string, Mutation[]>,
  batchTags: Map<string, string>, meshTranslations: Map<string, MutationMeshTranslation>,
  modelId: string, entityId: number,
) {
  const undo = undoStacks.get(modelId) ?? [];
  const redo = redoStacks.get(modelId) ?? [];
  const nextUndo = undo.filter((m) => m.entityId !== entityId);
  const nextRedo = redo.filter((m) => m.entityId !== entityId);
  if (nextUndo.length === undo.length && nextRedo.length === redo.length) return {};

  const removed = [...undo, ...redo].filter((m) => m.entityId === entityId);
  const nextTags = new Map(batchTags);
  const nextTranslations = new Map(meshTranslations);
  for (const mutation of removed) {
    nextTags.delete(mutation.id);
    nextTranslations.delete(mutation.id);
  }
  return {
    undoStacks: new Map(undoStacks).set(modelId, nextUndo),
    redoStacks: new Map(redoStacks).set(modelId, nextRedo),
    mutationBatchTags: nextTags,
    mutationMeshTranslations: nextTranslations,
    collabGeometryNotice: 'A collaborator changed an element. Its local undo and redo history was cleared.',
  };
}

/** Lifecycle mutations are allowed to cross a tombstone; other writes are not. */
export function isTargetTombstoned(view: MutablePropertyView, mutation: Mutation): boolean {
  return mutation.type !== 'CREATE_ENTITY'
    && mutation.type !== 'DELETE_ENTITY'
    && view.isDeleted(mutation.entityId);
}
