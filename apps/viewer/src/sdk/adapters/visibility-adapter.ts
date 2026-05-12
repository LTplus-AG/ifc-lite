/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EntityRef, VisibilityBackendMethods } from '@ifc-lite/sdk';
import type { StoreApi } from './types.js';
import { getModelForRef, type ModelLike } from './model-compat.js';
import { collectSpatialSubtreeElementsWithIfcSpace } from '../../store/basketVisibleSet.js';
import { toGlobalIdForRef, toGlobalIdFromModels } from '../../store/globalId.js';
import { isSpaceLikeSpatialTypeName, isSpatialStructureTypeName, type SpatialNode } from '@ifc-lite/data';

function findDescendantNode(root: SpatialNode, expressId: number): SpatialNode | null {
  const stack: SpatialNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.expressId === expressId) return node;
    for (const child of node.children) {
      stack.push(child);
    }
  }
  return null;
}

/**
 * If `ref` points to a spatial structure element (storey, building, etc.),
 * expand it to the local expressIds of all contained elements.
 * Otherwise return the original expressId as-is.
 */
function expandSpatialRef(ref: EntityRef, model: ModelLike): number[] {
  const dataStore = model.ifcDataStore;
  // Native-metadata-only models have no parsed data store — visibility
  // expansion isn't possible, fall back to the single ref.
  if (!dataStore) return [ref.expressId];
  const typeName = dataStore.entities.getTypeName(ref.expressId) || '';
  if (!isSpatialStructureTypeName(typeName) || isSpaceLikeSpatialTypeName(typeName)) {
    return [ref.expressId];
  }

  const hierarchy = dataStore.spatialHierarchy;
  if (!hierarchy) return [ref.expressId];
  const startNode = findDescendantNode(hierarchy.project, ref.expressId);
  if (!startNode) return [ref.expressId];

  const ids = collectSpatialSubtreeElementsWithIfcSpace(hierarchy, ref.expressId);
  return ids && ids.length > 0 ? ids : [ref.expressId];
}

export function createVisibilityAdapter(store: StoreApi): VisibilityBackendMethods {
  return {
    hide(refs: EntityRef[]) {
      const state = store.getState();
      // Convert EntityRef to global IDs — the renderer subscribes to the flat
      // hiddenEntities set (global IDs), not hiddenEntitiesByModel.
      const globalIds: number[] = [];
      for (const ref of refs) {
        if (!getModelForRef(state, ref.modelId)) continue;
        globalIds.push(toGlobalIdForRef(state.models, ref));
      }
      if (globalIds.length > 0) {
        state.hideEntities(globalIds);
      }
      return undefined;
    },
    show(refs: EntityRef[]) {
      const state = store.getState();
      const globalIds: number[] = [];
      for (const ref of refs) {
        if (!getModelForRef(state, ref.modelId)) continue;
        globalIds.push(toGlobalIdForRef(state.models, ref));
      }
      if (globalIds.length > 0) {
        state.showEntities(globalIds);
      }
      return undefined;
    },
    isolate(refs: EntityRef[]) {
      const state = store.getState();
      const globalIds: number[] = [];
      for (const ref of refs) {
        const model = getModelForRef(state, ref.modelId);
        if (model) {
          const expanded = expandSpatialRef(ref, model);
          for (const id of expanded) {
            globalIds.push(toGlobalIdFromModels(state.models, ref.modelId, id));
          }
        }
      }
      if (globalIds.length > 0) {
        state.isolateEntities?.(globalIds);
      }
      return undefined;
    },
    reset() {
      const state = store.getState();
      state.showAllInAllModels?.();
      return undefined;
    },
  };
}
