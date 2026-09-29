/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mutation, MutablePropertyView } from '@ifc-lite/mutations';
import type { MutationMeshTranslation } from './mutation-history-prune.js';

/** Peer edits invalidate conflicting history by entity or metadata namespace.
 * A queued undo is just as capable of overwriting a peer's write as redo. */
export function invalidateHistoryPatch(
  undoStacks: Map<string, Mutation[]>, redoStacks: Map<string, Mutation[]>,
  batchTags: Map<string, string>, meshTranslations: Map<string, MutationMeshTranslation>,
  modelId: string, target: number | ((mutation: Mutation) => boolean),
  notice = 'A collaborator changed an element. Its local undo and redo history was cleared.',
) {
  const matches = typeof target === 'number' ? (m: Mutation) => m.entityId === target : target;
  const undo = undoStacks.get(modelId) ?? [];
  const redo = redoStacks.get(modelId) ?? [];
  const nextUndo = undo.filter((m) => !matches(m));
  const nextRedo = redo.filter((m) => !matches(m));
  if (nextUndo.length === undo.length && nextRedo.length === redo.length) return {};

  const removed = [...undo, ...redo].filter(matches);
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
    collabGeometryNotice: notice,
  };
}

/** Lifecycle mutations are allowed to cross a tombstone; other writes are not. */
export function isTargetTombstoned(view: MutablePropertyView, mutation: Mutation): boolean {
  return mutation.type !== 'CREATE_ENTITY'
    && mutation.type !== 'DELETE_ENTITY'
    && view.isDeleted(mutation.entityId);
}
