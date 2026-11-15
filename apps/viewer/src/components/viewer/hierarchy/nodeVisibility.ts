/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { EntityRef, FederatedModel, ViewerState } from '@/store';
import { collectIfcBuildingStoreyElementsWithIfcSpace, collectSpatialSubtreeElementsWithIfcSpace } from '@/store/basketVisibleSet';
import { ownedAggregationRelationships } from '@/utils/entity-ownership';
import { containerVisibilityTargets, ownStateRevision, setOwnState, type ContainerVisibilityPlan } from '@/lib/container-visibility';
import { toGlobalIdFromModels } from '@/store/globalId';
import { resolveTreeGlobalId } from './productTree';
import { effectiveRowType, overlayViewFor, type TreeOverlay } from './treeOverlay';
import type { TreeNode } from './types';

export type HierarchyVisibilityAction = 'show' | 'hide';

/** A mixed row offers Show, matching its toggle's existing reveal-all action.
 * Only a fully hidden row gets hidden styling. Assemblies use their drawable
 * parts: the shape-less owner's own id never determines visible appearance. */
export function hierarchyNodeVisibility(
  node: TreeNode,
  elements: readonly number[],
  hidden: ReadonlySet<number>,
  models?: Map<string, FederatedModel>,
): { nodeHidden: boolean; visibilityAction: HierarchyVisibilityAction } {
  const targets = node.assemblyChildGlobalIds?.length ? node.assemblyChildGlobalIds : elements;
  // A row with a container plan reads as hidden when nothing that comes back
  // with it is drawn, and offers Show while any of that is hidden.
  const comesBack = models ? planRowTargets(node, models, 'show') : null;
  return {
    nodeHidden: comesBack ? comesBack.every((id) => hidden.has(id)) : targets.length > 0 && targets.every((id) => hidden.has(id)),
    visibilityAction: (comesBack ?? elements).some((id) => hidden.has(id)) ? 'show' : 'hide',
  };
}

/** Global targets per plan, by model, action and row. Show targets depend on
 *  own states, so they reset with the plan's revision; hide targets do not. */
const planTargetCache = new WeakMap<ContainerVisibilityPlan, { revision: number; show: Map<string, number[]>; hide: Map<string, number[]> }>();

/** The plan of a single model's spatial or element row, when its model has
 *  one. The spatial rows are the `Ifc*` node types; grouping rows never follow a plan. */
function rowPlan(node: TreeNode, models: Map<string, FederatedModel>): ContainerVisibilityPlan | undefined {
  if (node.expressIds.length !== 1 || !(node.type === 'element' || node.type.startsWith('Ifc'))) return undefined;
  return models.get(node.modelIds[0])?.containerVisibility;
}

/** A row's subtree as global ids, when its model states how its containers
 *  hide and show (a Rhino layer, #10214); null for any other row. */
function planRowTargets(node: TreeNode, models: Map<string, FederatedModel>, action: HierarchyVisibilityAction): number[] | null {
  const plan = rowPlan(node, models);
  const row = node.expressIds[0];
  if (!plan?.rows.has(row)) return null;
  const modelId = node.modelIds[0];
  const revision = ownStateRevision(plan);
  let cache = planTargetCache.get(plan);
  if (!cache) planTargetCache.set(plan, cache = { revision, show: new Map(), hide: new Map() });
  if (cache.revision !== revision) { cache.revision = revision; cache.show = new Map(); }
  const key = `${modelId}\u0000${row}`;
  let targets = cache[action].get(key);
  if (!targets) {
    // A whole subtree at once: map through the models map, not resolveTreeGlobalId's store lookup per id.
    targets = containerVisibilityTargets(plan, row, action).map((id) => toGlobalIdFromModels(models, modelId, id));
    cache[action].set(key, targets);
  }
  // Nothing to bring back (a row that is an object hidden on its own, holding
  // nothing else that is on): the row's eye acts on that row alone.
  return targets.length > 0 ? targets : [toGlobalIdFromModels(models, modelId, row)];
}

/** The global ids a row's eye acts on. A row of a model that states how its
 *  containers hide and show (a Rhino layer, #10214) acts on its subtree: all of
 *  it on hide, what comes back with it on show. Any other row acts on
 *  `elements`, what it holds directly. */
export function hierarchyToggleTargets(
  node: TreeNode,
  elements: readonly number[],
  action: HierarchyVisibilityAction,
  models: Map<string, FederatedModel>,
): number[] {
  const targets = planRowTargets(node, models, action);
  if (!targets) return [...elements];
  return action === 'hide' ? [...new Set([...elements, ...targets])] : [...targets];
}

/** After a row's eye: the toggled row or object keeps that as its own state,
 *  so a later toggle of its parent respects it, as in Rhino. A no-op for a row
 *  whose model has no plan. */
export function recordHierarchyOwnState(
  node: TreeNode,
  action: HierarchyVisibilityAction,
  models: Map<string, FederatedModel>,
): void {
  const plan = rowPlan(node, models);
  if (plan) setOwnState(plan, node.expressIds[0], action === 'show');
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
  models?: Map<string, FederatedModel>,
): { nodeHidden: boolean; visibilityAction: HierarchyVisibilityAction; outsideIsolation: boolean } {
  let outsideIsolation = isolation !== null && elements.every((id) => !isolation.has(id));
  if (outsideIsolation && isolation) {
    const subtree = spatialSubtree(node);
    outsideIsolation = elements.length + subtree.length > 0 && subtree.every((id) => !isolation.has(id));
  }
  return { ...hierarchyNodeVisibility(node, elements, hidden, models), outsideIsolation };
}

/** A subgroup is a container, never a product whose id shares its prefix. */
export function isLayerSubgroup(node: TreeNode): boolean {
  return node.type === 'type-group' && node.id.startsWith('presentation-layer-');
}

/** #9272: only explicit container Isolate enables default-hidden spatial types. */
export function revealMembershipSpatialTypes(
  node: TreeNode, elements: readonly number[],
  state: Pick<ViewerState, 'models' | 'ifcDataStore' | 'mutationViews' | 'typeVisibility' | 'toggleTypeVisibility'>,
  resolve: (globalId: number) => EntityRef | null,
): void {
  if (node.type !== 'group' && node.type !== 'presentation-layer' && !isLayerSubgroup(node)) return;
  const memberTypes = new Set<string>();
  for (const globalId of new Set([...(node.memberGlobalIds ?? []), ...elements])) {
    const ref = resolve(globalId);
    if (!ref) continue;
    const store = state.models.get(ref.modelId)?.ifcDataStore ?? state.ifcDataStore;
    if (!store) continue;
    const view = overlayViewFor((id) => state.mutationViews.get(id), ref.modelId);
    const type = effectiveRowType(store, view, ref.expressId);
    if (type) memberTypes.add(type);
  }
  if (!state.typeVisibility.spaces && memberTypes.has('IfcSpace')) state.toggleTypeVisibility('spaces');
  if (!state.typeVisibility.spatialZones && memberTypes.has('IfcSpatialZone')) state.toggleTypeVisibility('spatialZones');
}
