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
import type { EntityRef } from './types.js';
import { entityRefToString, stringToEntityRef } from './types.js';
import { useViewerStore } from './index.js';
import { toGlobalIdFromModels } from './globalId.js';

type ViewerStateSnapshot = ReturnType<typeof useViewerStore.getState>;

type VisibleCandidate = {
  globalId: number;
  modelId: string;
  expressId: number;
  ifcType?: string;
};

type BasketVisibleStats = {
  visibleCount: number;
  addCount: number;
  removeCount: number;
  basketCount: number;
};

export type BasketInputSource = 'selection' | 'hierarchy' | 'visible' | 'empty';

type CacheEntry = { key: string; refs: EntityRef[] };
let _visibleCache: CacheEntry | null = null;

function digestNumberSet(values: Iterable<number>): string {
  let count = 0;
  let xor = 0;
  let sum = 0;
  for (const v of values) {
    const n = Number.isFinite(v) ? (v | 0) : 0;
    count++;
    xor ^= n;
    sum = (sum + (n >>> 0)) >>> 0;
  }
  return `${count}:${xor >>> 0}:${sum >>> 0}`;
}

function digestModelEntityMap(map: Map<string, Set<number>>): string {
  if (map.size === 0) return '0';
  const parts: string[] = [];
  for (const [modelId, ids] of map) {
    parts.push(`${modelId}:${digestNumberSet(ids)}`);
  }
  parts.sort();
  return parts.join('|');
}

function visibilityFingerprint(state: ViewerStateSnapshot): string {
  const tv = state.typeVisibility;

  // Include per-model visible flag and geometry mesh count so the cache
  // invalidates when model visibility is toggled or geometry finishes loading.
  const modelParts: string[] = [];
  for (const [modelId, model] of state.models) {
    modelParts.push(`${modelId}:${model.visible ? 1 : 0}:${model.geometryResult?.meshes?.length ?? 0}`);
  }
  modelParts.sort();

  return [
    digestNumberSet(state.hiddenEntities),
    state.isolatedEntities ? digestNumberSet(state.isolatedEntities) : 'none',
    state.classFilter ? digestNumberSet(state.classFilter.ids) : 'none',
    digestNumberSet(state.lensHiddenIds),
    digestModelEntityMap(state.hiddenEntitiesByModel),
    digestModelEntityMap(state.isolatedEntitiesByModel),
    digestNumberSet(state.selectedStoreys),
    tv.spaces ? 1 : 0,
    tv.openings ? 1 : 0,
    tv.site ? 1 : 0,
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

function matchesTypeVisibility(ifcType: string | undefined, typeVisibility: ViewerStateSnapshot['typeVisibility']): boolean {
  if (ifcType === 'IfcSpace' && !typeVisibility.spaces) return false;
  if (ifcType === 'IfcOpeningElement' && !typeVisibility.openings) return false;
  if (ifcType === 'IfcSite' && !typeVisibility.site) return false;
  return true;
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
  return collectSpatialSubtreeElementsWithIfcSpace(dataStore.spatialHierarchy, containerExpressId) ?? [];
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
      const hierarchy = model.ifcDataStore?.spatialHierarchy;
      if (!hierarchy) continue;
      const offset = model.idOffset ?? 0;
      for (const storeyId of state.selectedStoreys) {
        const storeyElementIds = hierarchy.byStorey.get(storeyId) || hierarchy.byStorey.get(storeyId - offset);
        if (!storeyElementIds) continue;
        for (const localId of storeyElementIds) {
          refs.push({ modelId, expressId: localId });
        }
      }
    }
  } else if (state.ifcDataStore?.spatialHierarchy) {
    for (const storeyId of state.selectedStoreys) {
      const storeyElementIds = state.ifcDataStore.spatialHierarchy.byStorey.get(storeyId);
      if (!storeyElementIds) continue;
      for (const id of storeyElementIds) {
        refs.push({ modelId: 'legacy', expressId: id });
      }
    }
  }

  return dedupeRefs(refs);
}

function getSelectionBaseRefs(state: ViewerStateSnapshot): EntityRef[] {
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
  storeyId: number
): number[] | null {
  if (!hierarchy.byStorey.has(storeyId)) return null;
  return collectSpatialSubtreeElementsWithIfcSpace(hierarchy, storeyId);
}

export function collectSpatialSubtreeElementsWithIfcSpace(
  hierarchy: SpatialHierarchy | undefined,
  expressId: number
): number[] | null {
  if (!hierarchy?.project) return null;

  const startNode = findSpatialNode(hierarchy.project, expressId);
  if (!startNode) return null;

  const combined: number[] = [];
  const seen = new Set<number>();
  const stack: SpatialNode[] = [startNode];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === IfcTypeEnum.IfcSpace && !seen.has(current.expressId)) {
      seen.add(current.expressId);
      combined.push(current.expressId);
    }
    for (const elementId of current.elements || []) {
      if (seen.has(elementId)) continue;
      seen.add(elementId);
      combined.push(elementId);
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
      const offset = model.idOffset ?? 0;
      for (const storeyId of state.selectedStoreys) {
        const localStoreyId = hierarchy.byStorey.has(storeyId) ? storeyId : storeyId - offset;
        const storeyElementIds = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, localStoreyId);
        if (!storeyElementIds) continue;
        for (const localId of storeyElementIds) {
          ids.add(toGlobalIdFromModels(state.models, model.id, localId));
        }
      }
    }
  } else if (state.ifcDataStore?.spatialHierarchy) {
    const hierarchy = state.ifcDataStore.spatialHierarchy;
    for (const storeyId of state.selectedStoreys) {
      const storeyElementIds = collectIfcBuildingStoreyElementsWithIfcSpace(hierarchy, storeyId);
      if (!storeyElementIds) continue;
      for (const id of storeyElementIds) {
        ids.add(id);
      }
    }
  }

  return ids.size > 0 ? ids : null;
}

function collectVisibleCandidates(state: ViewerStateSnapshot): VisibleCandidate[] {
  const candidates: VisibleCandidate[] = [];

  if (state.models.size > 0) {
    for (const [modelId, model] of state.models) {
      if (!model.visible) continue;
      // Native-metadata models have no parsed geometry result. Skip them
      // — they can't contribute mesh-level visible candidates.
      if (!model.geometryResult) continue;
      const offset = model.idOffset ?? 0;
      for (const mesh of model.geometryResult.meshes) {
        if (!matchesTypeVisibility(mesh.ifcType, state.typeVisibility)) continue;
        const globalId = mesh.expressId;
        candidates.push({
          globalId,
          modelId,
          expressId: globalId - offset,
          ifcType: mesh.ifcType,
        });
      }
    }
  } else if (state.geometryResult) {
    for (const mesh of state.geometryResult.meshes) {
      if (!matchesTypeVisibility(mesh.ifcType, state.typeVisibility)) continue;
      candidates.push({
        globalId: mesh.expressId,
        modelId: 'legacy',
        expressId: mesh.expressId,
        ifcType: mesh.ifcType,
      });
    }
  }

  return candidates;
}

function getVisibleGlobalIds(state: ViewerStateSnapshot): Set<number> {
  const candidates = collectVisibleCandidates(state);

  const globalHidden = new Set<number>(state.hiddenEntities);
  for (const id of state.lensHiddenIds) {
    globalHidden.add(id);
  }

  // Collect all active filter sets and intersect them
  const filters: Set<number>[] = [];
  const storeyIsolation = computeStoreyIsolation(state);
  if (storeyIsolation !== null) filters.push(storeyIsolation);
  if (state.classFilter !== null) filters.push(state.classFilter.ids);
  if (state.isolatedEntities !== null) filters.push(state.isolatedEntities);

  let globalIsolation: Set<number> | null = null;
  if (filters.length === 1) {
    globalIsolation = filters[0];
  } else if (filters.length > 1) {
    // Intersect all active filters — start from smallest for efficiency
    const sorted = filters.sort((a, b) => a.size - b.size);
    globalIsolation = new Set<number>();
    for (const id of sorted[0]) {
      if (sorted.every(s => s.has(id))) {
        globalIsolation.add(id);
      }
    }
  }

  const visible = new Set<number>();
  for (const candidate of candidates) {
    if (globalIsolation !== null && !globalIsolation.has(candidate.globalId)) continue;
    if (globalHidden.has(candidate.globalId)) continue;

    const modelHidden = state.hiddenEntitiesByModel.get(candidate.modelId);
    if (modelHidden?.has(candidate.expressId)) continue;

    const modelIsolated = state.isolatedEntitiesByModel.get(candidate.modelId);
    if (modelIsolated && !modelIsolated.has(candidate.expressId)) continue;

    visible.add(candidate.globalId);
  }

  return visible;
}

export function getVisibleBasketEntityRefsFromStore(): EntityRef[] {
  const state = useViewerStore.getState();
  const key = visibilityFingerprint(state);
  if (_visibleCache?.key === key) return _visibleCache.refs;

  const visibleIds = getVisibleGlobalIds(state);
  if (visibleIds.size === 0) {
    _visibleCache = { key, refs: [] };
    return [];
  }

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
export function getBasketSelectionRefsFromStore(): EntityRef[] {
  const state = useViewerStore.getState();

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
  const state = useViewerStore.getState();

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

export function isBasketIsolationActiveFromStore(): boolean {
  const state = useViewerStore.getState();
  if (state.pinboardEntities.size === 0 || state.isolatedEntities === null) return false;

  const basketIds = basketToGlobalIds(state);
  if (basketIds.size !== state.isolatedEntities.size) return false;
  for (const id of basketIds) {
    if (!state.isolatedEntities.has(id)) return false;
  }
  return true;
}

export function getVisibleBasketStatsFromStore(): BasketVisibleStats {
  const state = useViewerStore.getState();
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
