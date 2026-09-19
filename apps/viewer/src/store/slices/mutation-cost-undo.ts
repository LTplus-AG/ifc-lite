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
 * registration or renderer-frame mesh — a cost entity has no geometry and no
 * storey, so neither applies. The adapter mirrors its overlay delta separately.
 */

import type { Mutation, NewEntity } from '@ifc-lite/mutations';
import type { MeshData } from '@ifc-lite/geometry';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import type { ViewerState } from '../index.js';
import { normalizeMutationModelId } from '../../sdk/adapters/mutation-view.js';

type SetState = (partial: Partial<ViewerState> | ((state: ViewerState) => Partial<ViewerState>)) => void;
const costEntityRoomKeys = new WeakMap<NewEntity, string>();

/** Retain the collision-safe room identity on the exact entity object stashed for redo. */
export function rememberCostEntityRoomKey(entity: NewEntity, roomKey: string): void {
  costEntityRoomKeys.set(entity, roomKey);
}

export function mirrorCreateEntityRedo(
  state: ViewerState,
  modelId: string,
  entity: NewEntity,
  mesh: MeshData | null = null,
): void {
  const names = getAttributeNamesAcrossSchemas(entity.type);
  const guid = names[0] === 'GlobalId' && typeof entity.attributes[0] === 'string'
    ? entity.attributes[0]
    : costEntityRoomKeys.get(entity) ?? null;
  state.mirrorEntityCreate(modelId, entity.expressId, entity.type, guid, mesh);
  entity.attributes.forEach((value, index) => {
    const name = names[index];
    if (name) state.mirrorAttributeEdit(modelId, entity.expressId, name, value);
  });
}

/**
 * `modelId` is normalised the same way `getOrCreateMutationView` normalises
 * it before REGISTERING the `MutablePropertyView` (`__legacy__` for a
 * single-model / no-real-id session) — both the push here and the undo/redo
 * apply path's `state.mutationViews.get(modelId)` lookup have to agree on
 * that key, or a legacy-session create pushes an undo entry the apply path
 * can never find the matching view for and silently no-ops.
 */
export function pushCreateEntityUndo(
  set: SetState,
  modelId: string,
  entityId: number,
  ifcType: string,
): void {
  set((s) => {
    const normalizedModelId = normalizeMutationModelId(s, modelId);
    const newUndoStacks = new Map(s.undoStacks);
    const stack = newUndoStacks.get(normalizedModelId) || [];
    const mutation: Mutation = {
      id: `mut_${ifcType.toLowerCase()}_${entityId}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      type: 'CREATE_ENTITY',
      timestamp: Date.now(),
      modelId: normalizedModelId,
      entityId,
      attributeName: ifcType,
    };
    newUndoStacks.set(normalizedModelId, [...stack, mutation]);

    const newRedoStacks = new Map(s.redoStacks);
    newRedoStacks.set(normalizedModelId, []);

    const newDirty = new Set(s.dirtyModels);
    newDirty.add(normalizedModelId);

    return {
      undoStacks: newUndoStacks,
      redoStacks: newRedoStacks,
      dirtyModels: newDirty,
      mutationVersion: s.mutationVersion + 1,
    };
  });
}

/**
 * `nestCostItems` / `assignCostItemsToSchedule` / `assignToCostItem` /
 * `setCostItemValues` / `removeCostEntity` (#4857 PR A review) each rewrite
 * or remove one or more EXISTING relationships — not a single new entity —
 * so they cannot be represented as one `CREATE_ENTITY` undo entry the way
 * `pushCreateEntityUndo` does; recording a faithful COMPOUND inverse for
 * "detach these ids from these rels, tombstone this one if it emptied,
 * cascade-delete these values" is real future work, not done here.
 *
 * Until it is, marks the model dirty (so these are never invisible to the
 * unsaved-changes indicator, which was the concrete first-order bug) and
 * CLEARS the undo/redo stacks — the blunt but safe way to satisfy "undo must
 * never cross an untracked write": with nothing left to pop past this
 * operation, `Ctrl+Z` cannot delete an earlier CREATE_ENTITY while this
 * write's `IfcRel*` still references it. The cost is losing undo history for
 * whatever this session edited BEFORE the cost write, which is honest and
 * visible (the toolbar's undo button simply goes inactive) rather than a
 * silent dangling reference.
 */
export function markCostRelationshipMutation(set: SetState, modelId: string): void {
  set((s) => {
    const normalizedModelId = normalizeMutationModelId(s, modelId);
    const newUndoStacks = new Map(s.undoStacks);
    newUndoStacks.set(normalizedModelId, []);
    const newRedoStacks = new Map(s.redoStacks);
    newRedoStacks.set(normalizedModelId, []);
    const newDirty = new Set(s.dirtyModels);
    newDirty.add(normalizedModelId);
    return {
      undoStacks: newUndoStacks,
      redoStacks: newRedoStacks,
      dirtyModels: newDirty,
      mutationVersion: s.mutationVersion + 1,
    };
  });
}

/** The two methods above, as `MutationSlice`'s public surface for them — kept
 *  here (not declared inline in `mutationSlice.ts`) via `interface X extends
 *  CostUndoMethods`, so a module at its own recorded size budget never has to
 *  grow to expose this pair. */
export interface CostUndoMethods {
  pushCreateEntityUndo: (modelId: string, entityId: number, ifcType: string) => void;
  markCostRelationshipMutation: (modelId: string) => void;
}

/** Bind both methods to one `set`, for a single `...createCostUndoMutations(set)` spread. */
export function createCostUndoMutations(set: SetState): CostUndoMethods {
  return {
    pushCreateEntityUndo: (modelId, entityId, ifcType) => pushCreateEntityUndo(set, modelId, entityId, ifcType),
    markCostRelationshipMutation: (modelId) => markCostRelationshipMutation(set, modelId),
  };
}
