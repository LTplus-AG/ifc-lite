/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store';
import { collectIfcBuildingStoreyElementsWithIfcSpace, collectSpatialSubtreeElementsWithIfcSpace } from '@/store/basketVisibleSet';
import { ownedAggregationRelationships } from '@/utils/entity-ownership';
import { resolveTreeGlobalId } from './productTree';
import { overlayViewFor, type TreeOverlay } from './treeOverlay';
import type { TreeNode } from './types';

export type HierarchyVisibilityAction = 'show' | 'hide';

/** A mixed row offers Show, matching its toggle's existing reveal-all action.
 * Only a fully hidden row gets hidden styling. Assemblies use their drawable
 * parts: the shape-less owner's own id never determines visible appearance. */
export function hierarchyNodeVisibility(
  node: TreeNode,
  elements: readonly number[],
  hidden: ReadonlySet<number>,
): { nodeHidden: boolean; visibilityAction: HierarchyVisibilityAction } {
  const targets = node.assemblyChildGlobalIds?.length ? node.assemblyChildGlobalIds : elements;
  return {
    nodeHidden: targets.length > 0 && targets.every((id) => hidden.has(id)),
    visibilityAction: elements.some((id) => hidden.has(id)) ? 'show' : 'hide',
  };
}

/** Storey rows: a single storey, a unified storey across models, and one
 *  model's contribution header inside a unified storey. Each pairs its
 *  `expressIds[i]` (model-local storey id) with `modelIds[i]`. */
function isStoreyRow(node: TreeNode): boolean {
  return node.type === 'IfcBuildingStorey' || node.type === 'unified-storey'
    || (node.type === 'model-header' && node.id.startsWith('contrib-'));
}

const NO_IDS: readonly number[] = [];

/** Resolves storey, IfcSpace and IfcSpatialZone rows' spatial subtrees as
 *  global ids, including space geometry and aggregated parts (#8802). Storey
 *  rows use the same set as storey isolation. Other rows resolve to nothing.
 *  Cached per row for the lifetime of the given models. */
export function createSpatialSubtreeResolver(
  models: Map<string, FederatedModel>,
  ifcDataStore: IfcDataStore | null | undefined,
  overlay?: TreeOverlay,
): (node: TreeNode) => readonly number[] {
  const cache = new Map<string, readonly number[]>();
  return (node) => {
    const isRoomRow = node.type === 'IfcSpace' || node.type === 'IfcSpatialZone';
    if (!isStoreyRow(node) && !isRoomRow) return NO_IDS;
    const cached = cache.get(node.id);
    if (cached) return cached;
    const collect = isRoomRow ? collectSpatialSubtreeElementsWithIfcSpace : collectIfcBuildingStoreyElementsWithIfcSpace;
    const ids: number[] = [];
    node.expressIds.forEach((spatialId, i) => {
      const modelId = node.modelIds[i];
      const store = models.get(modelId)?.ifcDataStore ?? (modelId === 'legacy' ? ifcDataStore : null);
      if (!store?.spatialHierarchy) return;
      const relationships = ownedAggregationRelationships(store, overlayViewFor(overlay, modelId));
      for (const id of collect(store.spatialHierarchy, spatialId, relationships) ?? []) {
        ids.push(resolveTreeGlobalId(modelId, id, models));
      }
    });
    cache.set(node.id, ids);
    return ids;
  };
}

/** A row's hidden styling, toggle action and isolation dim in one pass.
 * `outsideIsolation` is true when a row's elements are all outside the
 * viewport's isolation allowlist, so the tree dims what the viewport does not
 * draw (#8802). `isolation` must be the renderer's effective set
 * (`useVisibilityIsolation`): storey Solo rides `selectedStoreys`, not
 * `isolatedEntities`, so the store's manual isolation alone left Solo's other
 * storeys undimmed. Containers of an isolated element stay normal; `null`
 * means nothing is isolated. A storey, IfcSpace or IfcSpatialZone row also counts its spatial subtree,
 * resolved only when its direct members alone would dim it. */
export function hierarchyNodeAppearance(
  node: TreeNode,
  elements: readonly number[],
  hidden: ReadonlySet<number>,
  isolation: ReadonlySet<number> | null,
  spatialSubtree: (node: TreeNode) => readonly number[],
): { nodeHidden: boolean; visibilityAction: HierarchyVisibilityAction; outsideIsolation: boolean } {
  let outsideIsolation = isolation !== null && elements.every((id) => !isolation.has(id));
  if (outsideIsolation && isolation) {
    const subtree = spatialSubtree(node);
    outsideIsolation = elements.length + subtree.length > 0 && subtree.every((id) => !isolation.has(id));
  }
  return { ...hierarchyNodeVisibility(node, elements, hidden), outsideIsolation };
}
