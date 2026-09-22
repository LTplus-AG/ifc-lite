/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo-batch tagging. `mutationBatchTags` maps mutationId → batchId; the
 * undo / redo handlers tail-recurse while the next stack top shares the
 * batchId, so one Ctrl+Z reverts a whole batch. Both the positional-batch
 * action and the SDK's `bim.mutate.batch()` (via the mutate adapter's
 * `batchBegin` / `batchEnd`) tag through these helpers.
 */

import type { Mutation } from '@ifc-lite/mutations';

export function newMutationBatchId(): string {
  return `batch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** A copy of `tags` with every id in `mutationIds` tagged `batchId`. */
export function withMutationBatchTags(
  tags: ReadonlyMap<string, string>,
  mutationIds: Iterable<string>,
  batchId: string,
): Map<string, string> {
  const next = new Map(tags);
  for (const id of mutationIds) next.set(id, batchId);
  return next;
}

/**
 * Ids of the mutations pushed onto any model's undo stack since a
 * snapshot of stack lengths was taken — what an SDK batch encloses.
 */
export function mutationsSince(
  undoStacks: ReadonlyMap<string, readonly Mutation[]>,
  lengthsAtBegin: ReadonlyMap<string, number>,
): string[] {
  const ids: string[] = [];
  for (const [modelId, stack] of undoStacks) {
    const from = lengthsAtBegin.get(modelId) ?? 0;
    for (let i = from; i < stack.length; i += 1) ids.push(stack[i].id);
  }
  return ids;
}

export function undoStackLengths(undoStacks: ReadonlyMap<string, readonly Mutation[]>): Map<string, number> {
  return new Map([...undoStacks].map(([modelId, stack]) => [modelId, stack.length]));
}
