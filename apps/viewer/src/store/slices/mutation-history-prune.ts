/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Mutation } from '@ifc-lite/mutations';

export interface MutationMeshTranslation {
  globalId: number;
  rendererDelta: [number, number, number];
}

export interface PrunedMutationHistory {
  undoStacks: Map<string, Mutation[]>;
  redoStacks: Map<string, Mutation[]>;
  mutationBatchTags: Map<string, string>;
  mutationMeshTranslations: Map<string, MutationMeshTranslation>;
}

/** Removes one model's replay stacks and their mutation-keyed side channels. */
export function pruneMutationHistory(
  modelId: string,
  undoStacks: Map<string, Mutation[]>,
  redoStacks: Map<string, Mutation[]>,
  batchTags: Map<string, string>,
  meshTranslations: Map<string, MutationMeshTranslation>,
): PrunedMutationHistory {
  const discarded = new Set([
    ...(undoStacks.get(modelId) ?? []),
    ...(redoStacks.get(modelId) ?? []),
  ].map((mutation) => mutation.id));
  const nextUndoStacks = new Map(undoStacks);
  const nextRedoStacks = new Map(redoStacks);
  const nextBatchTags = new Map(batchTags);
  const nextMeshTranslations = new Map(meshTranslations);
  nextUndoStacks.delete(modelId);
  nextRedoStacks.delete(modelId);
  for (const mutationId of discarded) {
    nextBatchTags.delete(mutationId);
    nextMeshTranslations.delete(mutationId);
  }
  return {
    undoStacks: nextUndoStacks,
    redoStacks: nextRedoStacks,
    mutationBatchTags: nextBatchTags,
    mutationMeshTranslations: nextMeshTranslations,
  };
}
