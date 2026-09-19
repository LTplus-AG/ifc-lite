/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `pushCreateEntityUndo` — the undo/redo/dirty/version-bump tail every
 * `CREATE_ENTITY` mutation needs, extracted out of `mutationSlice.ts` (#4857
 * PR A review) so `bim.store.addCost*` (via `createCostStoreBackend`,
 * `store-adapter.ts`) can push the same undo entry `addColumn`/`addWall`/etc.
 * already do, without adding the whole block inline there too —
 * `mutationSlice.ts` is at its recorded module-size budget
 * (`scripts/module-size-allowlist.txt`), so new code for it lives here.
 *
 * Deliberately just the undo/redo/dirty/version slice of what
 * `runInStoreElementBuilder`/`addColumn` do: no spatial-hierarchy
 * registration, no renderer-frame mesh, no collab mirror — a cost entity has
 * no geometry and no storey, so none of those apply. A cost authoring action
 * is undoable and marks the model dirty; it does not yet appear in the
 * spatial tree or mirror to collab peers (unlike a geometric element).
 */

import type { Mutation } from '@ifc-lite/mutations';
import type { ViewerState } from '../index.js';

type SetState = (partial: Partial<ViewerState> | ((state: ViewerState) => Partial<ViewerState>)) => void;

export function pushCreateEntityUndo(
  set: SetState,
  modelId: string,
  entityId: number,
  ifcType: string,
): void {
  set((s) => {
    const newUndoStacks = new Map(s.undoStacks);
    const stack = newUndoStacks.get(modelId) || [];
    const mutation: Mutation = {
      id: `mut_${ifcType.toLowerCase()}_${entityId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'CREATE_ENTITY',
      timestamp: Date.now(),
      modelId,
      entityId,
      attributeName: ifcType,
    };
    newUndoStacks.set(modelId, [...stack, mutation]);

    const newRedoStacks = new Map(s.redoStacks);
    newRedoStacks.set(modelId, []);

    const newDirty = new Set(s.dirtyModels);
    newDirty.add(modelId);

    return {
      undoStacks: newUndoStacks,
      redoStacks: newRedoStacks,
      dirtyModels: newDirty,
      mutationVersion: s.mutationVersion + 1,
    };
  });
}
