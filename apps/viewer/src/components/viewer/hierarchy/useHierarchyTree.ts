/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useMemo, useState, useCallback, useEffect } from 'react';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import type { TreeNode, UnifiedStorey, HierarchySortMode } from './types';
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

export type GroupingMode = 'spatial' | 'type' | 'ifc-type' | 'material' | 'groups';

const SORT_STORAGE_KEY = 'hierarchy-sort';

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

/**
 * Build a stable Set of global IDs that have geometry.
 * Only rebuilds when the actual set of IDs changes, NOT when mesh colors change.
 */
function buildGeometricIdSet(
  models: Map<string, FederatedModel>,
  legacyGeometry: GeometryResult | null | undefined,
): Set<number> {
  const ids = new Set<number>();
  if (models.size > 0) {
    for (const [, model] of models) {
      if (model.geometryResult) {
        for (const mesh of model.geometryResult.meshes) {
          ids.add(mesh.expressId);
        }
      }
    }
  } else if (legacyGeometry) {
    for (const mesh of legacyGeometry.meshes) {
      ids.add(mesh.expressId);
    }
  }
  return ids;
}

/**
 * Global IDs of `IfcAnnotation` entities. Their 2D curves (plot boundaries,
 * "Model Lines", leaders) render through the symbolic overlay, not the mesh
 * pipeline, so they never enter `buildGeometricIdSet` and were absent from the
 * "By Class" tree — the user could see them in 3D but not select or hide them
 * (issue #1480). Folding them into the tree's inclusion set makes each an
 * ordinary, hideable row; the overlay honours that hide (see
 * `useSymbolicAnnotations`). Text annotations that carry a real brep mesh are
 * already in the geometric set, so the union is idempotent for them.
 */
function collectAnnotationEntityIds(
  models: Map<string, FederatedModel>,
  legacyStore: IfcDataStore | null | undefined,
): Set<number> {
  const ids = new Set<number>();
  const addFrom = (store: IfcDataStore | null | undefined, toGlobal: (localId: number) => number) => {
    // `getEntitiesByType` is a lazy accessor; guard for the rare
    // cache-restored store whose accessors have not been reattached yet.
    if (typeof store?.getEntitiesByType !== 'function') return;
    for (const ent of store.getEntitiesByType('IfcAnnotation')) {
      ids.add(toGlobal(ent.expressId));
    }
  };
  if (models.size > 0) {
    const state = useViewerStore.getState();
    for (const [modelId, model] of models) {
      // modelId comes straight from `models`, so it is always resolvable —
      // only the legacy sentinel needs the raw local id (matches the id the
      // tree builder assigns via `resolveTreeGlobalId`).
      addFrom(model.ifcDataStore, (localId) =>
        modelId === 'legacy' ? localId : state.toGlobalId(modelId, localId),
      );
    }
  } else {
    addFrom(legacyStore, (localId) => localId);
  }
  return ids;
}

export function useHierarchyTree({ models, ifcDataStore, isMultiModel, geometryResult }: UseHierarchyTreeParams) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [hasInitializedExpansion, setHasInitializedExpansion] = useState(false);
  const [groupingMode, setGroupingMode] = useState<GroupingMode>(() =>
    (typeof window !== 'undefined' && localStorage.getItem('hierarchy-grouping') as GroupingMode) || 'spatial'
  );
  const [sortMode, setSortMode] = useState<HierarchySortMode>(readStoredSortMode);
  // Groups-tab sub-filter (All / Systems / Zones / Other) — session-only state,
  // deliberately not persisted (#1622).
  const [groupFilter, setGroupFilter] = useState<GroupSubFilter>('all');

  // Build unified storey data for multi-model mode (moved before useEffect that depends on it)
  const unifiedStoreys = useMemo(
    (): UnifiedStorey[] => buildUnifiedStoreys(models, sortMode),
    [models, sortMode]
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

  // Build the tree data structure based on grouping mode
  // Note: hiddenEntities intentionally NOT in deps - visibility computed lazily for performance
  const treeData = useMemo(
    (): TreeNode[] => {
      if (groupingMode === 'type') {
        return buildTypeTree(models, ifcDataStore, expandedNodes, isMultiModel, classTreeIds, authoredProducts);
      }
      if (groupingMode === 'ifc-type') {
        return buildIfcTypeTree(models, ifcDataStore, expandedNodes, isMultiModel, geometricIds);
      }
      if (groupingMode === 'material') {
        return buildMaterialTree(models, ifcDataStore, expandedNodes, isMultiModel, geometricIds);
      }
      if (groupingMode === 'groups') {
        return buildGroupTree(models, ifcDataStore, expandedNodes, isMultiModel, geometricIds, groupFilter);
      }
      return buildTreeData(models, ifcDataStore, expandedNodes, isMultiModel, unifiedStoreys, sortMode);
    },
    [models, ifcDataStore, expandedNodes, isMultiModel, unifiedStoreys, sortMode, groupingMode, geometricIds, classTreeIds, authoredProducts, groupFilter]
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
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

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

  // Persist grouping mode preference
  const handleSetGroupingMode = useCallback((mode: GroupingMode) => {
    setGroupingMode(mode);
    if (typeof window !== 'undefined') {
      localStorage.setItem('hierarchy-grouping', mode);
    }
  }, []);

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
    setGroupingMode: handleSetGroupingMode,
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
