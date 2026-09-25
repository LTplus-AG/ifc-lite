/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Undo / redo stack bookkeeping, and the one way a set of mutations that
 * were written straight to a `MutablePropertyView` becomes ONE undo step.
 *
 * Replay is iterative: one Ctrl+Z pops the top mutation and keeps popping
 * while the next top carries the same batch id (`mutation-batch-tags.ts`).
 * The popped run is committed to the stacks in a single store update, because
 * each store update costs ~0.4 ms of subscriber work, and the recursion this
 * replaces overflowed the call stack at ~10k mutations (#5861). Appearance
 * commands and georeference edits keep their own one-step handlers; the run
 * pending before one of them is committed first, so each sees its own
 * mutation on top of the stack.
 */

import type { StoreApi } from 'zustand';
import type { Mutation } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';
import { hasAppearanceHistoryEntry, replayAppearanceHistory } from '@/lib/appearance/history.js';
import { applyRedoToView, applyUndoToView } from './mutation-history-apply.js';
import { newMutationBatchId, withMutationBatchTags } from './mutation-batch-tags.js';

type Get = () => ViewerState;
type Set = (partial: Partial<ViewerState> | ((s: ViewerState) => Partial<ViewerState>)) => void;
type Direction = 'undo' | 'redo';
type StackKey = 'undoStacks' | 'redoStacks';

function stackKeys(direction: Direction): { source: StackKey; destination: StackKey } {
  return direction === 'undo'
    ? { source: 'undoStacks', destination: 'redoStacks' }
    : { source: 'redoStacks', destination: 'undoStacks' };
}

function isGeorefMutation(mutation: Mutation): boolean {
  return mutation.type === 'UPDATE_ATTRIBUTE' && (mutation.attributeName?.startsWith('georef.') ?? false);
}

/** Move `moved` (popped top-first) from the source stack to the destination stack. */
function moveTop(s: ViewerState, direction: Direction, modelId: string, moved: readonly Mutation[]): Partial<ViewerState> {
  const { source, destination } = stackKeys(direction);
  const from = new Map(s[source]);
  from.set(modelId, (from.get(modelId) ?? []).slice(0, -moved.length));
  const to = new Map(s[destination]);
  to.set(modelId, [...(to.get(modelId) ?? []), ...moved]);
  return { [source]: from, [destination]: to, mutationVersion: s.mutationVersion + 1 };
}

/** Georeference edits live in `georefMutations`, not in the view. */
function replayGeorefStep(set: Set, modelId: string, mutation: Mutation, direction: Direction): void {
  const [, entityKey, field] = mutation.attributeName!.split('.');
  const entity = entityKey as 'projectedCRS' | 'mapConversion';
  const value = direction === 'undo' ? mutation.oldValue : mutation.newValue;
  set((s) => {
    const georefMutations = new Map(s.georefMutations);
    const modelMuts = { ...georefMutations.get(modelId) };
    const entityMuts = { ...modelMuts[entity] } as Record<string, unknown>;
    if (value !== undefined && value !== null) entityMuts[field] = value;
    else delete entityMuts[field];
    if (Object.keys(entityMuts).length === 0) delete modelMuts[entity];
    else modelMuts[entity] = entityMuts as typeof modelMuts[typeof entity];
    if (Object.keys(modelMuts).length === 0) georefMutations.delete(modelId);
    else georefMutations.set(modelId, modelMuts);
    return { ...moveTop(s, direction, modelId, [mutation]), georefMutations };
  });
}

/** One undo or redo: the top mutation, or the whole batch it belongs to. */
export function replayHistory(get: Get, set: Set, api: StoreApi<ViewerState>, modelId: string, direction: Direction): void {
  const { source } = stackKeys(direction);
  const moved: Mutation[] = [];
  const flush = () => {
    if (moved.length === 0) return;
    const run = moved.splice(0);
    set((s) => moveTop(s, direction, modelId, run));
  };

  let batchId: string | undefined;
  for (let first = true; ; first = false) {
    const stack = get()[source].get(modelId) ?? [];
    const mutation = stack[stack.length - 1 - moved.length];
    if (!mutation) break;
    const tag = get().mutationBatchTags.get(mutation.id);
    if (!first && (batchId === undefined || tag !== batchId)) break;
    batchId = tag;

    if (hasAppearanceHistoryEntry(api, mutation.id)) {
      flush();
      if (replayAppearanceHistory(api, modelId, direction)) continue;
    }
    if (isGeorefMutation(mutation)) {
      flush();
      replayGeorefStep(set, modelId, mutation, direction);
      continue;
    }
    const view = get().mutationViews.get(modelId);
    if (!view) break;
    if (direction === 'undo') applyUndoToView(get, set, modelId, view, mutation);
    else applyRedoToView(get, set, modelId, view, mutation);
    moved.push(mutation);
  }
  flush();
}

/**
 * Record mutations a bulk writer already applied to `modelId`'s view (Bulk
 * editor, CSV import) as ONE undo step: push them, tag them with one batch
 * id, clear the redo branch, mark the model dirty and bump `mutationVersion`,
 * all in a single store update. Returns the batch id, or null when empty.
 *
 * A chunked writer records each chunk as it is applied, passing the id the
 * first chunk returned, so the run stays one undo step while an edit that
 * lands during one of its yields keeps its place in commit order instead of
 * sitting below the whole run (#5958). See `recordRun` in
 * `lib/model-placement/history.ts`.
 */
export function recordMutationBatch(
  set: Set,
  modelId: string,
  mutations: readonly Mutation[],
  continuing?: string,
): string | null {
  if (mutations.length === 0) return null;
  const batchId = continuing ?? newMutationBatchId();
  set((s) => {
    // The stack is always copied: `withPlacementHistory` tells a new operation
    // from a replayed one by comparing the new top against the PREVIOUS
    // stack, so appending in place would hide this chunk from it.
    const undoStacks = new Map(s.undoStacks);
    undoStacks.set(modelId, [...(undoStacks.get(modelId) ?? []), ...mutations]);
    const redoStacks = new Map(s.redoStacks);
    redoStacks.set(modelId, []);
    let tags = s.mutationBatchTags;
    if (continuing !== undefined && batchOwned.get(tags) === batchId) for (const m of mutations) tags.set(m.id, batchId);
    else batchOwned.set(tags = withMutationBatchTags(tags, mutations.map((m) => m.id), batchId), batchId);
    return {
      undoStacks,
      redoStacks,
      dirtyModels: new Set(s.dirtyModels).add(modelId),
      mutationBatchTags: tags,
      mutationVersion: s.mutationVersion + 1,
    };
  });
  return batchId;
}

/**
 * The tag map this module copied for a batch that later chunks may extend.
 * A later chunk of that batch adds to it in place instead of copying every
 * tag of the session again (a 100k-entity Bulk run is 200 chunks). Every
 * other writer replaces the map, which ends the ownership, and nothing
 * compares tag maps by reference.
 */
const batchOwned = new WeakMap<Map<string, string>, string>();
