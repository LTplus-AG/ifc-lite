/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState, useCallback, useEffect } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import type { TreeNode, UnifiedStorey, HierarchySortMode, ExpansionLookup } from './types';
import { HIERARCHY_SORT_MODES, DEFAULT_HIERARCHY_SORT } from './types';
import {
  buildUnifiedStoreys,
  getUnifiedStoreyElements as getUnifiedStoreyElementsFn,
  buildTreeData,
  buildTypeTree,
  buildIfcTypeTree,
  buildMaterialTree,
  buildGroupTree,
  filterNodes,
  splitNodes,
  type AuthoredProduct,
  type GroupSubFilter,
} from './treeDataBuilder';
import {
  buildGeometricIdSet,
  collectAnnotationEntityIds,
  collectGeometryReadyModelIds,
} from './hierarchyGeometry';

export type { HierarchyMode } from '@/store';

const SORT_STORAGE_KEY = 'hierarchy-sort';
const EXPAND_ALL: ExpansionLookup = { has: () => true };

/** Read the persisted sort mode, falling back to the default for missing or
 *  stale (e.g. renamed) localStorage values. Reads can throw (private mode,
 *  opaque origin), so guard and fall back rather than break the panel mount. */
function readStoredSortMode(): HierarchySortMode {
  if (typeof window === 'undefined') return DEFAULT_HIERARCHY_SORT;
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY);
    return stored && (HIERARCHY_SORT_MODES as readonly string[]).includes(stored)
      ? (stored as HierarchySortMode)
      : DEFAULT_HIERARCHY_SORT;
  } catch {
    return DEFAULT_HIERARCHY_SORT;
  }
}

interface UseHierarchyTreeParams {
  models: Map<string, FederatedModel>;
  ifcDataStore: IfcDataStore | null | undefined;
  isMultiModel: boolean;
  geometryResult?: GeometryResult | null;
}

export function useHierarchyTree({ models, ifcDataStore, isMultiModel, geometryResult }: UseHierarchyTreeParams) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [hasInitializedExpansion, setHasInitializedExpansion] = useState(false);
  const groupingMode = useViewerStore((state) => state.hierarchyMode);
  const setGroupingMode = useViewerStore((state) => state.setHierarchyMode);
  const [sortMode, setSortMode] = useState<HierarchySortMode>(readStoredSortMode);
  // Groups-tab sub-filter (All / Systems / Zones / Other) — session-only state,
  // deliberately not persisted (#1622).
  const [groupFilter, setGroupFilter] = useState<GroupSubFilter>('all');

  // Stable mesh count — only changes when models are added/removed, not on color updates.
  // Used as a dep proxy so the geometric ID set doesn't rebuild on every color change.
  const meshCount = useMemo(() => {
    if (models.size > 0) {
      let count = 0;
      for (const [, model] of models) {
        count += model.geometryResult?.meshes.length ?? 0;
      }
      return count;
    }
    return geometryResult?.meshes.length ?? 0;
  }, [models, geometryResult?.meshes.length]);

  // Pre-computed set of global IDs with geometry — stable across color changes.
  // PERF: Skip when no geometry source exists (during initial streaming before
  // any data is ready). Gate on models OR ifcDataStore so federated scenarios
  // (models.size > 0 but ifcDataStore is null) still build the set correctly.
  const hasGeometrySource = models.size > 0 || !!ifcDataStore;
  const geometricIds = useMemo(
    () => hasGeometrySource ? buildGeometricIdSet(models, geometryResult) : new Set<number>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- meshCount is a stable proxy; hasGeometrySource gates streaming
    [models, hasGeometrySource ? meshCount : 0]
  );

  // Geometry readiness is per model: one streamed federation member must not
  // make an unstreamed sibling look known-empty. A completed model with zero
  // meshes is still known, so its physical-object count legitimately becomes 0.
  const geometryReadyModelIds = useMemo(
    () => collectGeometryReadyModelIds(models, geometryResult),
    [models, geometryResult],
  );

  const georefMutations = useViewerStore((state) => state.georefMutations); // storey badges only (#4843)

  // Build unified storey data for multi-model mode (moved before useEffect that depends on it)
  const unifiedStoreys = useMemo(
    (): UnifiedStorey[] => buildUnifiedStoreys(models, sortMode, geometricIds, geometryReadyModelIds, georefMutations),
    [models, sortMode, geometricIds, geometryReadyModelIds, georefMutations]
  );

  // Auto-expand nodes on initial load based on model count
  useEffect(() => {
    // Only run once when data is first loaded
    if (hasInitializedExpansion) return;

    const newExpanded = new Set<string>();

    if (models.size === 1) {
      // Single model in federation: expand full hierarchy to show all storeys
      const [, model] = Array.from(models.entries())[0];
      const hierarchy = model.ifcDataStore?.spatialHierarchy;

      // Wait until spatial hierarchy is computed before initializing
      if (!hierarchy?.project) {
        return; // Don't mark as initialized - will retry when hierarchy is ready
      }

      // Expand Project -> Site -> Building to reveal storeys
      const project = hierarchy.project;
      const projectNodeId = `root-${project.expressId}`;
      newExpanded.add(projectNodeId);

      for (const site of project.children || []) {
        const siteNodeId = `${projectNodeId}-${site.expressId}`;
        newExpanded.add(siteNodeId);

        for (const building of site.children || []) {
          const buildingNodeId = `${siteNodeId}-${building.expressId}`;
          newExpanded.add(buildingNodeId);
        }
      }
    } else if (models.size > 1) {
      // Multi-model: expand all model entries in Models section
      // But collapse if there are too many items (rough estimate based on viewport)
      const totalItems = unifiedStoreys.length + models.size;
      const estimatedRowHeight = 36;
      const availableHeight = window.innerHeight * 0.6; // Estimate panel takes ~60% of viewport
      const maxVisibleItems = Math.floor(availableHeight / estimatedRowHeight);

      if (totalItems <= maxVisibleItems) {
        // Enough space - expand all model entries
        for (const [modelId] of models) {
          newExpanded.add(`model-${modelId}`);
        }
      }
      // If not enough space, leave collapsed (newExpanded stays empty for models)
    } else if (models.size === 0 && ifcDataStore?.spatialHierarchy?.project) {
      // Legacy single-model mode (loaded via loadFile, not in models Map)
      const hierarchy = ifcDataStore.spatialHierarchy;
      const project = hierarchy.project;
      const projectNodeId = `root-${project.expressId}`;
      newExpanded.add(projectNodeId);

      for (const site of project.children || []) {
        const siteNodeId = `${projectNodeId}-${site.expressId}`;
        newExpanded.add(siteNodeId);

        for (const building of site.children || []) {
          const buildingNodeId = `${siteNodeId}-${building.expressId}`;
          newExpanded.add(buildingNodeId);
        }
      }
    } else {
      // No data loaded yet
      return;
    }

    if (newExpanded.size > 0) {
      setExpandedNodes(newExpanded);
    }
    setHasInitializedExpansion(true);
  }, [models, ifcDataStore, hasInitializedExpansion, unifiedStoreys.length]);

  // Reset expansion state when all data is cleared
  useEffect(() => {
    if (models.size === 0 && !ifcDataStore) {
      setHasInitializedExpansion(false);
      setExpandedNodes(new Set());
    }
  }, [models.size, ifcDataStore]);

  // Get all element IDs for a unified storey (as global IDs)
  const getUnifiedStoreyElements = useCallback(
    (unifiedStorey: UnifiedStorey): number[] => getUnifiedStoreyElementsFn(unifiedStorey, models),
    [models]
  );

  // `IfcAnnotation` entities are a fixed set per loaded model (independent of
  // streaming mesh count), so this is keyed on model identity only. Unioned
  // into the "By Class" inclusion set so curve-only annotations appear as
  // selectable / hideable rows (issue #1480).
  const annotationEntityIds = useMemo(
    () => hasGeometrySource ? collectAnnotationEntityIds(models, ifcDataStore) : new Set<number>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- static per model; toGlobalId reads live store
    [models, ifcDataStore, hasGeometrySource]
  );
  const classTreeIds = useMemo(() => {
    if (annotationEntityIds.size === 0) return geometricIds;
    const merged = new Set(geometricIds);
    for (const id of annotationEntityIds) merged.add(id);
    return merged;
  }, [geometricIds, annotationEntityIds]);

  const toGlobalIdsForModel = useCallback((modelId: string, expressIds: number[]): number[] => {
    if (modelId === 'legacy') return expressIds;
    const state = useViewerStore.getState();
    return expressIds.map((expressId) => state.toGlobalId(modelId, expressId));
  }, []);

  // Authored (overlay) products with geometry. They live in the mutation overlay,
  // not the columnar parse the class/type builders scan, so a baked IfcSpace was
  // absent from the "By Class" tree. Filtering by geometricIds keeps it to real
  // products (the space has a mesh; its helper points/placements/solids don't).
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const authoredProducts = useMemo<AuthoredProduct[]>(() => {
    const out: AuthoredProduct[] = [];
    const state = useViewerStore.getState();
    for (const [modelId, view] of mutationViews) {
      const getNew = (view as { getNewEntities?: () => Iterable<{ expressId: number; type: string; attributes: unknown[] }> }).getNewEntities;
      if (typeof getNew !== 'function') continue;
      for (const ent of getNew.call(view)) {
        const globalId = modelId === 'legacy' || !models.has(modelId)
          ? ent.expressId
          : state.toGlobalId(modelId, ent.expressId);
        if (!geometricIds.has(globalId)) continue;
        const rawName = ent.attributes?.[2];
        out.push({
          modelId,
          expressId: ent.expressId,
          globalId,
          ifcType: ent.type,
          name: typeof rawName === 'string' && rawName ? rawName : `${ent.type} #${ent.expressId}`,
        });
      }
    }
    return out;
    // mutationVersion bumps on every authoring edit; geometricIds tracks the mesh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutationViews, models, geometricIds, mutationVersion]);
  const searchExpansion = searchQuery.trim() ? EXPAND_ALL : expandedNodes;
  // hiddenEntities intentionally NOT in deps - visibility computed lazily
  const treeData = useMemo(
    (): TreeNode[] => {
      const treeOverlay = (modelId: string) => mutationViews.get(modelId); // deletes/retypes, re-run per mutationVersion (#5249)
      if (groupingMode === 'type') {
        return buildTypeTree(
          models,
          ifcDataStore,
          searchExpansion,
          isMultiModel,
          classTreeIds,
          authoredProducts,
          geometryReadyModelIds,
          treeOverlay,
        );
      }
      if (groupingMode === 'ifc-type') {
        return buildIfcTypeTree(models, ifcDataStore, searchExpansion, isMultiModel, geometricIds, geometryReadyModelIds, treeOverlay);
      }
      if (groupingMode === 'material') {
        return buildMaterialTree(models, ifcDataStore, searchExpansion, isMultiModel, geometricIds, geometryReadyModelIds);
      }
      if (groupingMode === 'groups') {
        return buildGroupTree(models, ifcDataStore, searchExpansion, isMultiModel, geometricIds, groupFilter, treeOverlay);
      }
      return buildTreeData(
        models,
        ifcDataStore,
        searchExpansion,
        isMultiModel,
        unifiedStoreys,
        sortMode,
        geometricIds,
        geometryReadyModelIds, georefMutations,
      );
    },
    [models, ifcDataStore, searchExpansion, isMultiModel, unifiedStoreys, sortMode, groupingMode, geometricIds, classTreeIds, authoredProducts, groupFilter, geometryReadyModelIds, georefMutations, mutationViews, mutationVersion]
  );

  // Filter nodes based on search
  const filteredNodes = useMemo(
    () => filterNodes(treeData, searchQuery),
    [treeData, searchQuery]
  );

  // Split filtered nodes into storeys and models sections (for multi-model mode)
  const { storeysNodes, modelsNodes } = useMemo(
    () => splitNodes(filteredNodes, isMultiModel),
    [filteredNodes, isMultiModel]
  );

  const toggleExpand = useCallback((nodeId: string) => {
    if (searchQuery.trim()) return;
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, [searchQuery]);

  // Get all elements for a node (handles type groups, ifc-type, unified storeys, single storeys, model contributions, and elements)
  const getNodeElements = useCallback((node: TreeNode): number[] => {
    if (node.type === 'type-group' || node.type === 'ifc-type' || node.type === 'material-group' ||
        node.type === 'group' || node.type === 'group-member') {
      // GlobalIds are pre-stored on the node during tree construction — O(1).
      // For 'group' rows these are the RESOLVED member geometry ids (#1622).
      return node.globalIds;
    }
    if (node.type === 'unified-storey') {
      // Get all elements from all models for this unified storey
      const unified = unifiedStoreys.find(u => `unified-${u.key}` === node.id);
      if (unified) {
        return getUnifiedStoreyElements(unified);
      }
    } else if (node.type === 'model-header' && node.id.startsWith('contrib-')) {
      // Model contribution header inside a unified storey - get elements for this model's storey
      const storeyId = node.expressIds[0];
      const modelId = node.modelIds[0];
      const model = models.get(modelId);
      if (model?.ifcDataStore?.spatialHierarchy) {
        const localIds = (model.ifcDataStore.spatialHierarchy.byStorey.get(storeyId) as number[]) || [];
        return toGlobalIdsForModel(modelId, localIds);
      }
    } else if (node.type === 'IfcBuildingStorey') {
      // Get storey elements
      const storeyId = node.expressIds[0];
      const modelId = node.modelIds[0];

      if (modelId === 'legacy' && ifcDataStore?.spatialHierarchy) {
        const elements = ifcDataStore.spatialHierarchy.byStorey.get(storeyId);
        if (elements) return elements as number[];
      }

      const model = models.get(modelId);
      if (model?.ifcDataStore?.spatialHierarchy) {
        const localIds = (model.ifcDataStore.spatialHierarchy.byStorey.get(storeyId) as number[]) || [];
        return toGlobalIdsForModel(modelId, localIds);
      }
    } else if (node.type === 'IfcSpace' || node.type === 'IfcSpatialZone') {
      const spaceId = node.expressIds[0];
      const modelId = node.modelIds[0];

      if (modelId === 'legacy' && ifcDataStore?.spatialHierarchy) {
        const elements = ifcDataStore.spatialHierarchy.bySpace.get(spaceId) ?? [];
        return [spaceId, ...(elements as number[])];
      }

      const model = models.get(modelId);
      if (model?.ifcDataStore?.spatialHierarchy) {
        const localIds = (model.ifcDataStore.spatialHierarchy.bySpace.get(spaceId) as number[]) || [];
        return [...node.globalIds, ...toGlobalIdsForModel(modelId, localIds)];
      }
    } else if (node.type === 'element') {
      // A decomposing assembly folds in its IfcRelAggregates parts so the eye
      // toggle / isolate / basket act on the whole assembly at once (#1133).
      return node.assemblyChildGlobalIds && node.assemblyChildGlobalIds.length > 0
        ? [...node.globalIds, ...node.assemblyChildGlobalIds]
        : node.globalIds;
    }
    // Spatial containers (Project, Site, Building) and top-level models don't have direct element visibility toggle
    return [];
  }, [models, ifcDataStore, unifiedStoreys, getUnifiedStoreyElements, toGlobalIdsForModel]);

  // Persist storey sort-order preference (issue #1296)
  const handleSetSortMode = useCallback((mode: HierarchySortMode) => {
    setSortMode(mode);
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(SORT_STORAGE_KEY, mode);
      } catch {
        // Private mode / quota — keep the in-memory choice, just don't persist.
      }
    }
  }, []);

  return {
    searchQuery,
    setSearchQuery,
    groupingMode,
    setGroupingMode,
    sortMode,
    setSortMode: handleSetSortMode,
    groupFilter,
    setGroupFilter,
    unifiedStoreys,
    treeData,
    filteredNodes,
    storeysNodes,
    modelsNodes,
    toggleExpand,
    getNodeElements,
    getUnifiedStoreyElements,
  };
}
