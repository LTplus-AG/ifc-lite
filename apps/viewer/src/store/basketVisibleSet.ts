/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  IfcTypeEnum,
  isSpaceLikeSpatialTypeName,
  isSpatialStructureTypeName,
  isStoreyLikeSpatialTypeName,
  type SpatialNode,
  type SpatialHierarchy,
} from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { EntityRef } from './types.js';
import { entityRefToString, stringToEntityRef } from './types.js';
import type { ViewerState } from './index.js';
import { getViewerState } from './viewerStoreHandle.js';
import { toGlobalIdFromModels } from './globalId.js';
import { resolveViewHiddenEntities, retypedClasses } from '../lib/visibility/structural-view';
import { isMeshTypeVisible, isTypeVisible } from './typeVisibilityFilter.js';
import { instancedPassDrawn } from '../lib/visibility/visible-bounds';
import { getGlobalRenderer, readInstancedSceneRevision } from '../lib/renderer-ref.js';
import { collectAggregatedDescendants, type AggregationRelationships } from '../utils/aggregation.js';
import { effectiveSpatialMembers } from '../lib/effective-spatial-members.js';
import { objectIdentity } from '../utils/objectIdentity.js';

type ViewerStateSnapshot = ViewerState;

type BasketVisibleStats = {
  visibleCount: number;
  addCount: number;
  removeCount: number;
  basketCount: number;
};

export type BasketInputSource = 'selection' | 'hierarchy' | 'visible' | 'empty';

type CacheEntry = { key: string; refs: EntityRef[] };
let _visibleCache: CacheEntry | null = null;

/** Murmur3 finalizer: a plain sum and xor of ids repeats across different sets (#10247). */
const mixId = (n: number): number => {
  let h = Math.imul(n ^ (n >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
};

function digestNumberSet(values: Iterable<number>): string {
  let count = 0, xor = 0, sum = 0;
  for (const v of values) {
    const mixed = mixId(Number.isFinite(v) ? (v | 0) : 0);
    count++; xor ^= mixed; sum = (sum + mixed) >>> 0;
  }
  return `${count}:${xor >>> 0}:${sum >>> 0}`;
}

export function visibilityFingerprint(state: ViewerStateSnapshot): string {
  // Per model: visible flag, mesh count (streaming growth), and geometry and
  // store identity (both are replaced, e.g. by a collab reconstruct).
  const modelParts: string[] = [];
  for (const [modelId, model] of state.models) {
    modelParts.push(`${modelId}:${model.visible ? 1 : 0}:${model.geometryResult?.meshes?.length ?? 0}:${objectIdentity(model.geometryResult)}:${objectIdentity(model.ifcDataStore)}`);
  }
  modelParts.sort();

  return [
    digestNumberSet(state.hiddenEntities),
    state.isolatedEntities ? digestNumberSet(state.isolatedEntities) : 'none',
    state.classFilter ? digestNumberSet(state.classFilter.ids) : 'none',
    digestNumberSet(state.lensHiddenIds),
    digestNumberSet(state.selectedStoreys),
    JSON.stringify(state.typeVisibility), state.structuralViewMode, instancedPassDrawn(state) ? readInstancedSceneRevision() : '',
    state.mutationVersion,
    // The structural mask, storey isolation and candidates read these objects
    // themselves; a collab reconstruct replaces them without a version bump.
    // The top-level store and geometry are read only in single-model mode.
    objectIdentity(state.mutationViews),
    state.models.size === 0 ? `${objectIdentity(state.ifcDataStore)}.${objectIdentity(state.geometryResult)}` : '-',
    state.models.size,
    modelParts.join(';'),
    state.geometryResult?.meshes?.length ?? 0,
    state.activeBasketViewId ?? 'none',
  ].join(':');
}

export function invalidateVisibleBasketCache(): void {
  _visibleCache = null;
}

function dedupeRefs(refs: EntityRef[]): EntityRef[] {
  const out: EntityRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = entityRefToString(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function getDataStoreForModel(state: ViewerStateSnapshot, modelId: string): IfcDataStore | null {
  if (modelId === 'legacy') {
    return state.ifcDataStore;
  }
  return state.models.get(modelId)?.ifcDataStore ?? null;
}

function getEntityTypeName(state: ViewerStateSnapshot, ref: EntityRef): string {
  const dataStore = getDataStoreForModel(state, ref.modelId);
  if (!dataStore) return '';
  return dataStore.entities.getTypeName(ref.expressId) || '';
}

function findSpatialNode(root: SpatialNode, expressId: number): SpatialNode | null {
  const stack: SpatialNode[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.expressId === expressId) {
      return current;
    }
    for (const child of current.children || []) {
      stack.push(child);
    }
  }
  return null;
}

function getContainerElementIds(dataStore: IfcDataStore, containerExpressId: number): number[] {
  return collectSpatialSubtreeElementsWithIfcSpace(
    dataStore.spatialHierarchy,
    containerExpressId,
    dataStore.relationships as AggregationRelationships | undefined
  ) ?? [];
}

function expandRefToElements(state: ViewerStateSnapshot, ref: EntityRef): EntityRef[] {
  const dataStore = getDataStoreForModel(state, ref.modelId);
  if (!dataStore) return [ref];

  const entityType = dataStore.entities.getTypeName(ref.expressId) || '';
  if (isSpatialStructureTypeName(entityType) && !isSpaceLikeSpatialTypeName(entityType)) {
    const localIds = getContainerElementIds(dataStore, ref.expressId);
    const ids = localIds.includes(ref.expressId)
      ? localIds
      : [ref.expressId, ...localIds];
    return ids.map((expressId) => ({ modelId: ref.modelId, expressId }));
  }

  return [ref];
}

function toGlobalId(modelId: string, expressId: number, state: ViewerStateSnapshot): number {
  return toGlobalIdFromModels(state.models, modelId, expressId);
}

function globalIdToRef(state: ViewerStateSnapshot, globalId: number): EntityRef | null {
  const resolved = state.resolveGlobalIdFromModels(globalId);
  if (resolved) {
    return { modelId: resolved.modelId, expressId: resolved.expressId };
  }

  if (state.models.size > 0) return null;

  if (state.ifcDataStore) {
    return { modelId: 'legacy', expressId: globalId };
  }

  return null;
}

function basketToGlobalIds(state: ViewerStateSnapshot): Set<number> {
  const ids = new Set<number>();
  for (const str of state.pinboardEntities) {
    const ref = stringToEntityRef(str);
    ids.add(toGlobalId(ref.modelId, ref.expressId, state));
  }
  return ids;
}

function getSelectedStoreyElementRefs(state: ViewerStateSnapshot): EntityRef[] {
  if (state.selectedStoreys.size === 0) return [];

  const refs: EntityRef[] = [];
  if (state.models.size > 0) {
    for (const [modelId, model] of state.models) {
      const modelStore = model.ifcDataStore;
      const hierarchy = modelStore?.spatialHierarchy;
      if (!modelStore || !hierarchy) continue;
      const offset = model.idOffset ?? 0;
      for (const storeyId of state.selectedStoreys) {
        const localStoreyId = hierarchy.byStorey.has(storeyId) ? storeyId : storeyId - offset;
        const storeyElementIds = effectiveSpatialMembers(modelStore, state.mutationViews.get(modelId), localStoreyId);
        for (const localId of storeyElementIds) {
          refs.push({ modelId, expressId: localId });
        }
      }
    }
  } else if (state.ifcDataStore?.spatialHierarchy) {
    for (const storeyId of state.selectedStoreys) {
      const storeyElementIds = effectiveSpatialMembers(state.ifcDataStore, state.getMutationView('legacy') ?? undefined, storeyId);
      for (const id of storeyElementIds) {
        refs.push({ modelId: 'legacy', expressId: id });
      }
    }
  }

  return dedupeRefs(refs);
}

/** Canonical selection resolver: model-local refs, `modelId === 'legacy'` = single-model store. */
export function getSelectionBaseRefs(state: ViewerStateSnapshot): EntityRef[] {
  const refs: EntityRef[] = [];

  if (state.selectedEntitiesSet.size > 0) {
    for (const str of state.selectedEntitiesSet) {
      refs.push(stringToEntityRef(str));
    }
    return refs;
  }

  if (state.selectedEntityIds.size > 0) {
    for (const globalId of state.selectedEntityIds) {
      const resolved = globalIdToRef(state, globalId);
      if (resolved) refs.push(resolved);
    }
    return refs;
  }

  if (state.selectedEntities.length > 0) {
    return [...state.selectedEntities];
  }

  if (state.selectedEntity) {
    return [state.selectedEntity];
  }

  if (state.selectedEntityId !== null) {
    const resolved = globalIdToRef(state, state.selectedEntityId);
    if (resolved) refs.push(resolved);
  }

  return refs;
}

function getExpandedSelectionRefs(state: ViewerStateSnapshot): EntityRef[] {
  const baseRefs = getSelectionBaseRefs(state);
  if (baseRefs.length === 0) return [];
  return dedupeRefs(baseRefs.flatMap((ref) => expandRefToElements(state, ref)));
}

/**
 * Collect all element IDs for an IfcBuildingStorey, including elements
 * contained in descendant IfcSpace nodes and the space geometry itself.
 */
export function collectIfcBuildingStoreyElementsWithIfcSpace(
  hierarchy: SpatialHierarchy,
  storeyId: number,
  relationships?: AggregationRelationships
): number[] | null {
  if (!hierarchy.byStorey.has(storeyId)) return null;
  return collectSpatialSubtreeElementsWithIfcSpace(hierarchy, storeyId, relationships);
}

export function collectSpatialSubtreeElementsWithIfcSpace(
  hierarchy: SpatialHierarchy | undefined,
  expressId: number,
  relationships?: AggregationRelationships
): number[] | null {
  if (!hierarchy?.project) return null;

  const startNode = findSpatialNode(hierarchy.project, expressId);
  if (!startNode) return null;

  const combined: number[] = [];
  const seen = new Set<number>();
  const add = (id: number) => {
    if (seen.has(id)) return;
    seen.add(id);
    combined.push(id);
  };
  const stack: SpatialNode[] = [startNode];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === IfcTypeEnum.IfcSpace) {
      add(current.expressId);
    }
    for (const elementId of current.elements || []) {
      add(elementId);
      // A decomposing assembly (IfcElementAssembly, IfcStair-as-container, …)
      // keeps its parts off the spatial tree, so without this they have no
      // storey assignment and storey isolation would drop the stair flights /
      // railings / landing slabs / virtual clearance volumes (#1133).
      if (relationships) {
        for (const descId of collectAggregatedDescendants(relationships, elementId)) {
          add(descId);
        }
      }
    }
    for (const child of current.children || []) {
      stack.push(child);
    }
  }

  return combined;
}

function computeStoreyIsolation(state: ViewerStateSnapshot): Set<number> | null {
  if (state.selectedStoreys.size === 0) return null;

  const ids = new Set<number>();

  if (state.models.size > 0) {
    for (const [, model] of state.models) {
      const hierarchy = model.ifcDataStore?.spatialHierarchy;
      if (!hierarchy) continue;
      const relationships = model.ifcDataStore?.relationships as AggregationRelationships | undefined;
      const offset = model.idOffset ?? 0;
      for (const storeyId of state.selectedStoreys) {
        const localStoreyId = hierarchy.byStorey.has(storeyId) ? storeyId : storeyId - offset;
        const storeyElementIds = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, localStoreyId, relationships);
        if (!storeyElementIds) continue;
        for (const localId of storeyElementIds) {
          ids.add(toGlobalIdFromModels(state.models, model.id, localId));
        }
      }
    }
  } else if (state.ifcDataStore?.spatialHierarchy) {
    const hierarchy = state.ifcDataStore.spatialHierarchy;
    const relationships = state.ifcDataStore.relationships as AggregationRelationships | undefined;
    for (const storeyId of state.selectedStoreys) {
      const storeyElementIds = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, storeyId, relationships);
      if (!storeyElementIds) continue;
      for (const id of storeyElementIds) {
        ids.add(id);
      }
    }
  }

  return ids.size > 0 ? ids : null;
}

/**
 * The isolation ALLOWLIST currently in force, in global-id space: storey
 * selection ∩ class filter ∩ manual isolation, or `null` when no isolation
 * channel is active at all.
 *
 * This is the same quantity `ViewportContainer` memoises as
 * `computedIsolatedIds` and hands the renderer as `isolatedIds`. It is exported
 * because that memo is prop-drilled through the viewport tree and is therefore
 * unreachable from the toolbar — where the to-scale PDF export lives (#2042).
 * An exporter that read only `isolatedEntities` would print every storey while
 * the screen shows one, which is the #2578 "the export disagrees with the
 * viewport" class; deriving it here instead of restating the intersection is
 * what stops a third copy appearing.
 */
export function computeIsolationFilterSet(state: ViewerStateSnapshot): Set<number> | null {
  // Collect all active filter sets and intersect them
  const filters: Set<number>[] = [];
  const storeyIsolation = computeStoreyIsolation(state);
  if (storeyIsolation !== null) filters.push(storeyIsolation);
  if (state.classFilter !== null) filters.push(state.classFilter.ids);
  if (state.isolatedEntities !== null) filters.push(state.isolatedEntities);

  if (filters.length === 0) return null;
  if (filters.length === 1) return filters[0];

  // Intersect all active filters — start from smallest for efficiency
  const sorted = filters.sort((a, b) => a.size - b.size);
  const intersection = new Set<number>();
  for (const id of sorted[0]) {
    if (sorted.every((s) => s.has(id))) {
      intersection.add(id);
    }
  }
  return intersection;
}

function getVisibleGlobalIds(state: ViewerStateSnapshot): Set<number> {
  const globalHidden = new Set<number>(resolveViewHiddenEntities(state));
  for (const id of state.lensHiddenIds) {
    globalHidden.add(id);
  }

  const globalIsolation = computeIsolationFilterSet(state);
  const retyped = retypedClasses(state);
  const visible = new Set<number>();
  const addVisible = (id: number) => {
    if (!globalHidden.has(id) && (globalIsolation === null || globalIsolation.has(id))) visible.add(id);
  };
  const collect = (geometry: GeometryResult | null | undefined) => {
    if (!geometry) return;
    for (const mesh of geometry.meshes) {
      if (isMeshTypeVisible(mesh, state.typeVisibility, state.structuralViewMode, retyped)) addVisible(mesh.expressId);
    }
  };
  if (state.models.size === 0) {
    collect(state.geometryResult);
  } else {
    for (const model of state.models.values()) {
      if (model.visible) collect(model.geometryResult);
    }
  }
  if (instancedPassDrawn(state)) {
    // Fully instanced occurrences have no flat mesh. Use the renderer's global
    // ids, which include occurrences loaded from cache.
    const scene = getGlobalRenderer()?.getScene?.();
    for (const id of scene?.getInstancedEntityIds?.() ?? []) {
      let dataStore = state.ifcDataStore;
      let expressId = id;
      if (state.models.size > 0) {
        const owner = state.resolveGlobalIdFromModels(id);
        if (!owner) continue;
        const model = state.models.get(owner.modelId);
        if (!model?.visible) continue;
        dataStore = model.ifcDataStore;
        expressId = owner.expressId;
      }
      const ifcType = retyped.get(id) ?? dataStore?.entities?.getTypeName(expressId);
      if (isTypeVisible(ifcType, state.typeVisibility, state.structuralViewMode)) addVisible(id);
    }
  }

  return visible;
}

/** `ignoreIsolatedEntities`: as if `isolatedEntities` were unset, so a panel's own isolation does not filter its own rows (#6368). */
export function getVisibleBasketEntityRefsFromStore(ignoreIsolatedEntities = false, live = getViewerState()): EntityRef[] {
  const state = ignoreIsolatedEntities && live.isolatedEntities !== null ? { ...live, isolatedEntities: null } : live;
  const key = visibilityFingerprint(state);
  if (_visibleCache?.key === key) return _visibleCache.refs;

  const visibleIds = getVisibleGlobalIds(state);
  const refs: EntityRef[] = [];
  for (const globalId of visibleIds) {
    const resolved = state.resolveGlobalIdFromModels(globalId);
    if (resolved) {
      refs.push({ modelId: resolved.modelId, expressId: resolved.expressId });
    } else {
      refs.push({ modelId: 'legacy', expressId: globalId });
    }
  }
  const result = dedupeRefs(refs);
  _visibleCache = { key, refs: result };
  return result;
}

/**
 * Resolve active entity selection into basket refs.
 * Explicit selected entities are preferred; if empty, selected storeys are expanded.
 */
export function getBasketSelectionRefsFromStore(state = getViewerState()): EntityRef[] {

  const expandedSelection = getExpandedSelectionRefs(state);
  if (expandedSelection.length > 0) {
    return expandedSelection;
  }

  return getSelectedStoreyElementRefs(state);
}

/**
 * Resolve hierarchy-derived basket source.
 * Priority: explicit hierarchy source snapshot -> selected storeys -> selected hierarchy container/entity.
 */
export function getHierarchyBasketEntityRefsFromStore(): EntityRef[] {
  const state = getViewerState();

  if (state.hierarchyBasketSelection.size > 0) {
    const hierarchyRefs = Array.from(state.hierarchyBasketSelection).map((key) => stringToEntityRef(key));
    const expandedHierarchy = dedupeRefs(hierarchyRefs.flatMap((ref) => expandRefToElements(state, ref)));
    if (expandedHierarchy.length > 0) {
      return expandedHierarchy;
    }
  }

  const storeyRefs = getSelectedStoreyElementRefs(state);
  if (storeyRefs.length > 0) {
    return storeyRefs;
  }

  const selectionRefs = getExpandedSelectionRefs(state);
  if (selectionRefs.length > 0) {
    const hasContainer = selectionRefs.some((ref) => {
      const typeName = getEntityTypeName(state, ref);
      return isStoreyLikeSpatialTypeName(typeName) || (isSpatialStructureTypeName(typeName) && !isSpaceLikeSpatialTypeName(typeName));
    });
    if (hasContainer || getSelectionBaseRefs(state).length > 0) {
      return selectionRefs;
    }
  }

  return [];
}

export function getSmartBasketInputFromStore(): { refs: EntityRef[]; source: BasketInputSource } {
  const selectionRefs = getBasketSelectionRefsFromStore();
  if (selectionRefs.length > 0) {
    return { refs: selectionRefs, source: 'selection' };
  }

  const hierarchyRefs = getHierarchyBasketEntityRefsFromStore();
  if (hierarchyRefs.length > 0) {
    return { refs: hierarchyRefs, source: 'hierarchy' };
  }

  const visibleRefs = getVisibleBasketEntityRefsFromStore();
  if (visibleRefs.length > 0) {
    return { refs: visibleRefs, source: 'visible' };
  }

  return { refs: [], source: 'empty' };
}

/** "Is the basket shown?" — every basket element is isolated. A subset test, not equality: a basket that
 *  WIDENED a foreign isolation (#4527) is shown too, and "Show active basket" would evict the foreign ids. */
export function isBasketIsolationActiveFromStore(): boolean {
  const state = getViewerState();
  if (state.pinboardEntities.size === 0 || state.isolatedEntities === null) return false;
  for (const id of basketToGlobalIds(state)) {
    if (!state.isolatedEntities.has(id)) return false;
  }
  return true;
}

export function getVisibleBasketStatsFromStore(): BasketVisibleStats {
  const state = getViewerState();
  const visibleRefs = getVisibleBasketEntityRefsFromStore();
  const visibleKeys = new Set<string>(visibleRefs.map(entityRefToString));
  let removeCount = 0;
  for (const key of state.pinboardEntities) {
    if (visibleKeys.has(key)) removeCount++;
  }

  return {
    visibleCount: visibleKeys.size,
    addCount: Math.max(0, visibleKeys.size - removeCount),
    removeCount,
    basketCount: state.pinboardEntities.size,
  };
}
