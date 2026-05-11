/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Search,
  Building2,
  Layers,
  LayoutTemplate,
  FileBox,
  GripHorizontal,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useViewerStore, resolveEntityRef } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useIfc } from '@/hooks/useIfc';
import { getNativeMetadataChildren, searchNativeMetadataEntities } from '@/services/desktop-native-metadata';

import type { TreeNode } from './hierarchy/types';
import { isSpatialContainer } from './hierarchy/types';
import { useHierarchyTree } from './hierarchy/useHierarchyTree';
import { HierarchyNode, SectionHeader } from './hierarchy/HierarchyNode';

export function HierarchyPanel() {
  const {
    ifcDataStore,
    geometryResult,
    models,
    activeModelId,
    setActiveModel,
    setModelVisibility,
    setModelCollapsed,
    removeModel,
  } = useIfc();
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntityIds = useViewerStore((s) => s.setSelectedEntityIds);
  const setSelectedEntity = useViewerStore((s) => s.setSelectedEntity);
  const setSelectedEntities = useViewerStore((s) => s.setSelectedEntities);
  const toGlobalId = useViewerStore((s) => s.toGlobalId);
  const setSelectedModelId = useViewerStore((s) => s.setSelectedModelId);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const setStoreySelection = useViewerStore((s) => s.setStoreySelection);
  const setStoreysSelection = useViewerStore((s) => s.setStoreysSelection);
  const clearStoreySelection = useViewerStore((s) => s.clearStoreySelection);
  const isolateEntities = useViewerStore((s) => s.isolateEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const clearIsolation = useViewerStore((s) => s.clearIsolation);
  const classFilter = useViewerStore((s) => s.classFilter);
  const setClassFilter = useViewerStore((s) => s.setClassFilter);
  const clearClassFilter = useViewerStore((s) => s.clearClassFilter);
  const clearAllFilters = useViewerStore((s) => s.clearAllFilters);
  const setHierarchyBasketSelection = useViewerStore((s) => s.setHierarchyBasketSelection);

  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const hideEntities = useViewerStore((s) => s.hideEntities);
  const showEntities = useViewerStore((s) => s.showEntities);
  const toggleEntityVisibility = useViewerStore((s) => s.toggleEntityVisibility);
  const clearSelection = useViewerStore((s) => s.clearSelection);

  // Derive label for type isolation (from Type tab) by checking mesh ifcType
  const typeIsolationLabel = useMemo(() => {
    if (!isolatedEntities || isolatedEntities.size === 0) return null;
    const sampleId = isolatedEntities.values().next().value!;
    for (const [, model] of models) {
      const gr = model.geometryResult;
      if (!gr?.meshes) continue;
      const mesh = gr.meshes.find((m: { expressId: number }) =>
        toGlobalIdFromModels(models, model.id, m.expressId) === sampleId,
      );
      if (mesh?.ifcType) return mesh.ifcType;
    }
    if (geometryResult?.meshes) {
      const mesh = geometryResult.meshes.find((m: { expressId: number }) => m.expressId === sampleId);
      if (mesh?.ifcType) return mesh.ifcType;
    }
    return `${isolatedEntities.size} elements`;
  }, [isolatedEntities, models, geometryResult]);

  const hasActiveFilters = selectedStoreys.size > 0 || isolatedEntities !== null || classFilter !== null;

  // Resizable panel split (percentage for storeys section, 0.5 = 50%)
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Check if we have multiple models loaded
  const isMultiModel = models.size > 1;
  const nativeLazyModel = useMemo(() => {
    if (models.size !== 1) return null;
    const [, model] = Array.from(models.entries())[0];
    if (!model.nativeMetadata) return null;
    return model.ifcDataStore?.spatialHierarchy ? null : model;
  }, [models]);
  const [nativeChildren, setNativeChildren] = useState<Record<number, Array<{
    expressId: number;
    type: string;
    name: string;
    globalId?: string | null;
    kind: 'spatial' | 'element';
    hasChildren: boolean;
    elementCount?: number;
    elevation?: number | null;
  }>>>({});
  const [nativeExpanded, setNativeExpanded] = useState<Set<number>>(new Set());
  const [nativeSearchResults, setNativeSearchResults] = useState<Array<{
    expressId: number;
    type: string;
    name: string;
    globalId?: string | null;
    kind: 'spatial' | 'element';
    hasChildren: boolean;
    elementCount?: number;
    elevation?: number | null;
  }>>([]);

  // Use extracted hook for tree data management
  const {
    searchQuery,
    setSearchQuery,
    groupingMode,
    setGroupingMode,
    unifiedStoreys,
    filteredNodes: rawFilteredNodes,
    storeysNodes: rawStoreysNodes,
    modelsNodes: rawModelsNodes,
    toggleExpand,
    getNodeElements,
  } = useHierarchyTree({ models, ifcDataStore, isMultiModel, geometryResult });

  // Issue #540: when the user has the merge-layers load setting on,
  // hide `IfcBuildingElementPart` rows from the tree — the Rust layer
  // suppresses their meshes, so leaving the rows visible would lead
  // to dead-clicks. Filter at the consumer (this panel) rather than
  // in `spatialHierarchy.ts` per the agent coordination plan.
  const mergeLayersHidesParts = useViewerStore((s) => s.mergeLayers);
  const PART_TYPE_KEY = 'ifcbuildingelementpart';
  const stripPartNodes = useCallback(
    (nodes: TreeNode[]): TreeNode[] => {
      if (!mergeLayersHidesParts) return nodes;
      return nodes.filter((node) => {
        // Only element rows carry an `ifcType` we can compare. Class
        // grouping ("IfcBuildingElementPart (N)") and ifc-type nodes
        // also expose an `ifcType`; we strip those too because they
        // would expand to empty groups after merge.
        const t = node.ifcType?.toLowerCase();
        if (!t) return true;
        return t !== PART_TYPE_KEY;
      });
    },
    [mergeLayersHidesParts],
  );
  const filteredNodes = useMemo(() => stripPartNodes(rawFilteredNodes), [stripPartNodes, rawFilteredNodes]);
  const storeysNodes = useMemo(() => stripPartNodes(rawStoreysNodes), [stripPartNodes, rawStoreysNodes]);
  const modelsNodes = useMemo(() => stripPartNodes(rawModelsNodes), [stripPartNodes, rawModelsNodes]);

  // Refs for both scroll areas
  const storeysRef = useRef<HTMLDivElement>(null);
  const modelsRef = useRef<HTMLDivElement>(null);
  const parentRef = useRef<HTMLDivElement>(null); // Legacy single-model mode


  // Virtualizers for both sections
  const storeysVirtualizer = useVirtualizer({
    count: storeysNodes.length,
    getScrollElement: () => storeysRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  const modelsVirtualizer = useVirtualizer({
    count: modelsNodes.length,
    getScrollElement: () => modelsRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  // Legacy virtualizer for single-model mode
  const virtualizer = useVirtualizer({
    count: filteredNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  // Resize handler for draggable divider
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const containerRect = containerRef.current.getBoundingClientRect();
      const relativeY = e.clientY - containerRect.top;
      // Account for the search header height (~70px)
      const headerHeight = 70;
      const availableHeight = containerRect.height - headerHeight;
      const newRatio = Math.max(0.15, Math.min(0.85, (relativeY - headerHeight) / availableHeight));
      setSplitRatio(newRatio);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    if (!nativeLazyModel?.nativeMetadata) {
      setNativeSearchResults([]);
      return;
    }
    const query = searchQuery.trim();
    if (!query) {
      setNativeSearchResults([]);
      return;
    }
    let cancelled = false;
    void searchNativeMetadataEntities(nativeLazyModel.nativeMetadata.cacheKey, query, 200)
      .then((results) => {
        if (!cancelled) setNativeSearchResults(results);
      })
      .catch(() => {
        if (!cancelled) setNativeSearchResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [nativeLazyModel, searchQuery]);

  // Toggle visibility for a node
  const handleVisibilityToggle = useCallback((node: TreeNode) => {
    const elements = getNodeElements(node);
    if (elements.length === 0) return;

    // Check if all elements are currently visible (not hidden)
    const allVisible = elements.every(id => !hiddenEntities.has(id));

    if (allVisible) {
      hideEntities(elements);
      if (selectedEntityId !== null && elements.includes(selectedEntityId)) {
        clearSelection();
      }
    } else {
      showEntities(elements);
    }
  }, [getNodeElements, hiddenEntities, hideEntities, showEntities, selectedEntityId, clearSelection]);

  // Handle model visibility toggle
  const handleModelVisibilityToggle = useCallback((modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const model = models.get(modelId);
    if (model) {
      setModelVisibility(modelId, !model.visible);
    }
  }, [models, setModelVisibility]);

  // Remove model
  const handleRemoveModel = useCallback((modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeModel(modelId);
  }, [removeModel]);

  // Handle model header click (select model + toggle expand)
  const handleModelHeaderClick = useCallback((modelId: string, nodeId: string, hasChildren: boolean) => {
    setSelectedModelId(modelId);
    if (hasChildren) toggleExpand(nodeId);
  }, [setSelectedModelId, toggleExpand]);

  // Handle node click - for selection/isolation or expand/collapse
  const handleNodeClick = useCallback((node: TreeNode, e: React.MouseEvent) => {
    if (node.type === 'model-header' && node.id !== 'models-header') {
      // Model header click handled by its own onClick (expand/collapse)
      return;
    }

    const hierarchyRefs: Array<{ modelId: string; expressId: number }> = [];
    for (const globalId of getNodeElements(node)) {
      const ref = resolveEntityRef(globalId);
      if (ref) hierarchyRefs.push(ref);
    }
    if (hierarchyRefs.length > 0) {
      setHierarchyBasketSelection(hierarchyRefs);
    } else if (isSpatialContainer(node.type) && node.expressIds.length > 0) {
      setHierarchyBasketSelection([{
        modelId: node.modelIds[0] || 'legacy',
        expressId: node.expressIds[0],
      }]);
    }

    // Type group nodes - click to filter/isolate entities, expand via chevron only
    if (node.type === 'type-group') {
      const elements = getNodeElements(node);
      if (elements.length > 0) {
        // Clear multi-selection highlight
        setSelectedEntityIds([]);
        setSelectedEntity(resolveEntityRef(elements[0]));
        if (groupingMode === 'type') {
          // Class tab → class filter (combinable with storey + type isolation)
          setClassFilter(elements, node.ifcType || node.name);
        } else {
          // Type tab → type isolation (combinable with storey + class filter)
          isolateEntities(elements);
        }
      }
      return;
    }

    // IFC type entity nodes (e.g. IfcWallType/W01) - select type entity for property panel + isolate instances
    if (node.type === 'ifc-type') {
      const modelId = node.modelIds[0];
      const typeExpressId = node.entityExpressId;
      if (!typeExpressId) return;

      // Clear multi-selection first (before setting new selection, since
      // setSelectedEntityIds([]) resets selectedEntityId to null)
      setSelectedEntityIds([]);

      if (modelId && modelId !== 'legacy') {
        setSelectedEntityId(toGlobalId(modelId, typeExpressId));
        setSelectedEntity({ modelId, expressId: typeExpressId });
        setActiveModel(modelId);
      } else {
        setSelectedEntityId(typeExpressId);
        setSelectedEntity({ modelId: 'legacy', expressId: typeExpressId });
      }

      // Isolate instances of this type
      const elements = getNodeElements(node);
      if (elements.length > 0) {
        isolateEntities(elements);
      }

      // Toggle expand
      if (node.hasChildren) {
        toggleExpand(node.id);
      }
      return;
    }

    // Spatial container nodes (IfcProject/IfcSite/IfcBuilding) - select for property panel + expand
    if (isSpatialContainer(node.type)) {
      const entityId = node.expressIds[0];
      const modelId = node.modelIds[0];

      if (modelId && modelId !== 'legacy') {
        // Multi-model: convert to globalId for renderer, set entity for property panel
        const globalId = toGlobalIdFromModels(models, modelId, entityId);
        setSelectedEntityId(globalId);
        setSelectedEntity({ modelId, expressId: entityId });
        setActiveModel(modelId);
      } else if (entityId) {
        // Legacy single-model
        setSelectedEntityId(entityId);
        setSelectedEntity({ modelId: 'legacy', expressId: entityId });
      }

      // Also toggle expand if has children
      if (node.hasChildren) {
        toggleExpand(node.id);
      }
      return;
    }

    if (node.type === 'unified-storey' || node.type === 'IfcBuildingStorey') {
      // Storey click - select/isolate (unified or single)
      const unified = node.type === 'unified-storey'
        ? unifiedStoreys.find(u => `unified-${u.key}` === node.id)
        : null;
      const storeyIds = unified
        ? unified.storeys.map(s => s.storeyId)
        : node.expressIds;

      // Set entity refs for property panel display
      if (unified && unified.storeys.length > 1) {
        // Multi-model unified storey: show all storeys combined in property panel
        const entityRefs = unified.storeys.map(s => ({
          modelId: s.modelId,
          expressId: s.storeyId,
        }));
        setSelectedEntities(entityRefs);
        // Clear single entity selection (property panel will use selectedEntities)
        setSelectedEntityId(null);
      } else {
        // Single storey: show in property panel like any entity
        const storeyId = storeyIds[0];
        const modelId = node.modelIds[0];
        if (modelId && modelId !== 'legacy') {
          const globalId = toGlobalIdFromModels(models, modelId, storeyId);
          setSelectedEntityId(globalId);
          setSelectedEntity({ modelId, expressId: storeyId });
        } else {
          setSelectedEntityId(storeyId);
          setSelectedEntity({ modelId: 'legacy', expressId: storeyId });
        }
      }

      if (e.ctrlKey || e.metaKey) {
        // Add to storey filter selection
        setStoreysSelection([...Array.from(selectedStoreys), ...storeyIds]);
      } else {
        // Single selection - toggle if already selected
        const allAlreadySelected = storeyIds.length > 0 &&
          storeyIds.every(id => selectedStoreys.has(id)) &&
          selectedStoreys.size === storeyIds.length;

        if (allAlreadySelected) {
          // Toggle off - clear selection to show all
          clearStoreySelection();
        } else {
          // Select this storey (replaces any existing selection)
          setStoreysSelection(storeyIds);
        }
      }
    } else if (node.type === 'IfcSpace') {
      const spaceId = node.expressIds[0];
      const modelId = node.modelIds[0];
      const globalId = node.globalIds[0] ?? spaceId;

      setSelectedEntityIds([]);

      if (modelId && modelId !== 'legacy') {
        setSelectedEntityId(globalId);
        setSelectedEntity({ modelId, expressId: spaceId });
        setActiveModel(modelId);
      } else {
        setSelectedEntityId(globalId);
        setSelectedEntity({ modelId: 'legacy', expressId: spaceId });
      }

      if (node.hasChildren) {
        toggleExpand(node.id);
      }
    } else if (node.type === 'element') {
      // Element click - select it
      const elementId = node.expressIds[0];
      const modelId = node.modelIds[0];
      const globalId = node.globalIds[0] ?? elementId;

      // Clear multi-selection (e.g. from a prior type-group click) so only
      // this single element is highlighted, matching Viewport pick behavior
      setSelectedEntityIds([]);

      if (modelId !== 'legacy') {
        setSelectedEntityId(globalId);
        setSelectedEntity({ modelId, expressId: elementId });
        setActiveModel(modelId);
      } else {
        setSelectedEntityId(globalId);
        setSelectedEntity(resolveEntityRef(globalId));
      }
    }
  }, [selectedStoreys, setStoreysSelection, clearStoreySelection, setSelectedEntityId, setSelectedEntityIds, setSelectedEntity, setSelectedEntities, setActiveModel, toggleExpand, unifiedStoreys, models, isolateEntities, getNodeElements, setHierarchyBasketSelection, toGlobalId, groupingMode, setClassFilter]);

  // Compute selection and visibility state for a node
  const computeNodeState = useCallback((node: TreeNode): { isSelected: boolean; nodeHidden: boolean; modelVisible?: boolean } => {
    // Determine if node is selected
    // For ifc-type nodes, check if the type entity itself is selected
    const isSelected = node.type === 'unified-storey'
      ? node.expressIds.some(id => selectedStoreys.has(id))
      : node.type === 'IfcBuildingStorey'
        ? selectedStoreys.has(node.expressIds[0])
        : node.type === 'IfcSpace' || node.type === 'element'
          ? selectedEntityId === (node.globalIds[0] ?? node.expressIds[0])
          : node.type === 'ifc-type'
            ? (() => {
                const typeExpressId = node.entityExpressId;
                if (!typeExpressId) return false;
                const mId = node.modelIds[0];
                const gId = mId && mId !== 'legacy'
                  ? toGlobalId(mId, typeExpressId)
                  : typeExpressId;
                return selectedEntityId === gId;
              })()
            : false;

    // Compute visibility inline - for elements check directly, for storeys use getNodeElements
    let nodeHidden = false;
    if (node.type === 'element') {
      nodeHidden = hiddenEntities.has(node.globalIds[0] ?? node.expressIds[0]);
    } else if (node.type === 'IfcBuildingStorey' || node.type === 'IfcSpace' || node.type === 'unified-storey' ||
               node.type === 'type-group' || node.type === 'ifc-type' ||
               (node.type === 'model-header' && node.id.startsWith('contrib-'))) {
      const elements = getNodeElements(node);
      nodeHidden = elements.length > 0 && elements.every(id => hiddenEntities.has(id));
    }

    // Model visibility for model-header nodes
    let modelVisible: boolean | undefined;
    if (node.type === 'model-header' && node.id.startsWith('model-')) {
      const model = models.get(node.modelIds[0]);
      modelVisible = model?.visible;
    }

    return { isSelected, nodeHidden, modelVisible };
  }, [selectedStoreys, selectedEntityId, hiddenEntities, getNodeElements, models, toGlobalId]);

  if (!ifcDataStore && models.size === 0) {
    return (
      <div className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
        <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">Hierarchy</h2>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-center p-6 bg-white dark:bg-black">
          <div className="w-16 h-16 border-2 border-dashed border-zinc-300 dark:border-zinc-800 flex items-center justify-center mb-4 bg-zinc-100 dark:bg-zinc-950">
            <LayoutTemplate className="h-8 w-8 text-zinc-400 dark:text-zinc-500" />
          </div>
          <p className="font-bold uppercase text-zinc-900 dark:text-zinc-100 mb-2">No Model</p>
          <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400 max-w-[150px]">
            Structure will appear here when loaded
          </p>
        </div>
      </div>
    );
  }

  const singleModel = models.size === 1 ? Array.from(models.values())[0] : null;
  if (!ifcDataStore && singleModel && !nativeLazyModel) {
    const metadataState = singleModel.metadataLoadState;
    const message = metadataState === 'error'
      ? (singleModel.loadError || 'Native metadata failed to load.')
      : metadataState === 'bootstrapping'
        ? 'Native spatial metadata is loading.'
        : 'Spatial metadata will appear once bootstrap completes.';
    return (
      <div className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
        <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">Hierarchy</h2>
        </div>
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <div className="max-w-[220px] text-xs text-zinc-500 dark:text-zinc-400">
            {message}
          </div>
        </div>
      </div>
    );
  }

  if (nativeLazyModel?.nativeMetadata) {
    const nativeMetadata = nativeLazyModel.nativeMetadata;
    const nativeSelectedGlobalId =
      selectedEntity?.modelId === nativeLazyModel.id
        ? toGlobalId(nativeLazyModel.id, selectedEntity.expressId)
        : null;

    const selectNativeEntity = (expressId: number) => {
      const globalId = toGlobalId(nativeLazyModel.id, expressId);
      setSelectedEntityIds([]);
      setSelectedEntityId(globalId);
      setSelectedEntity({
        modelId: nativeLazyModel.id,
        expressId,
      });
      setActiveModel(nativeLazyModel.id);
    };

    const toggleNativeNode = async (expressId: number) => {
      setNativeExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(expressId)) {
          next.delete(expressId);
        } else {
          next.add(expressId);
        }
        return next;
      });
      if (nativeChildren[expressId]) return;
      try {
        const children = await getNativeMetadataChildren(nativeMetadata.cacheKey, expressId);
        setNativeChildren((prev) => ({ ...prev, [expressId]: children }));
      } catch {
        setNativeChildren((prev) => ({ ...prev, [expressId]: [] }));
      }
    };

    const renderNativeSummary = (
      summary: {
        expressId: number;
        type: string;
        name: string;
        kind: 'spatial' | 'element';
        hasChildren: boolean;
        elementCount?: number;
      },
      depth: number,
    ): JSX.Element => {
      const expanded = nativeExpanded.has(summary.expressId);
      return (
        <div key={`${summary.kind}-${summary.expressId}`}>
          <button
            type="button"
            className={cn(
              'w-full flex items-center gap-2 px-3 py-2 text-left border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-950',
              nativeSelectedGlobalId === toGlobalId(nativeLazyModel.id, summary.expressId) && 'bg-primary/10 text-primary'
            )}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => selectNativeEntity(summary.expressId)}
          >
            {summary.hasChildren ? (
              <span
                className="w-4 text-center text-xs text-zinc-500"
                onClick={(event) => {
                  event.stopPropagation();
                  void toggleNativeNode(summary.expressId);
                }}
              >
                {expanded ? 'v' : '>'}
              </span>
            ) : (
              <span className="w-4" />
            )}
            <span className="truncate flex-1 text-sm">{summary.name || `${summary.type} #${summary.expressId}`}</span>
            <span className="text-[10px] uppercase tracking-wide text-zinc-500">{summary.type}</span>
            {typeof summary.elementCount === 'number' && summary.elementCount > 0 && (
              <span className="text-[10px] text-zinc-400">{summary.elementCount}</span>
            )}
          </button>
          {expanded && (nativeChildren[summary.expressId] ?? []).map((child) => renderNativeSummary(child, depth + 1))}
        </div>
      );
    };

    return (
      <div className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
        <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
          <Input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="h-4 w-4" />}
            className="h-9 text-sm rounded-none border-2 border-zinc-200 dark:border-zinc-800 focus:border-primary focus:ring-0 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
          />
        </div>
        <SectionHeader
          icon={Building2}
          title={searchQuery.trim() ? 'Search Results' : 'Hierarchy'}
          count={searchQuery.trim() ? nativeSearchResults.length : 1}
        />
        <div className="flex-1 overflow-auto scrollbar-thin bg-white dark:bg-black">
          {searchQuery.trim()
            ? nativeSearchResults.map((result) => renderNativeSummary(result, 0))
            : nativeMetadata.spatialTree
              ? renderNativeSummary(nativeMetadata.spatialTree, 0)
              : (
                <div className="p-4 text-xs text-zinc-500">
                  {nativeLazyModel.metadataLoadState === 'error'
                    ? (nativeLazyModel.loadError || 'Native spatial metadata is unavailable for this model.')
                    : nativeLazyModel.metadataLoadState === 'bootstrapping'
                      ? 'Native spatial metadata is still loading.'
                      : 'Native spatial metadata tree is unavailable for this model.'}
                </div>
              )}
        </div>
        <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500 text-center bg-zinc-50 dark:bg-black font-mono">
          On-demand desktop metadata
        </div>
      </div>
    );
  }

  // Helper to render a node via the extracted HierarchyNode component
  const renderNode = (node: TreeNode, virtualRow: { index: number; size: number; start: number }) => {
    const { isSelected, nodeHidden, modelVisible } = computeNodeState(node);

    return (
      <HierarchyNode
        key={node.id}
        node={node}
        virtualRow={virtualRow}
        isSelected={isSelected}
        nodeHidden={nodeHidden}
        isMultiModel={isMultiModel}
        modelsCount={models.size}
        modelVisible={modelVisible}
        onNodeClick={handleNodeClick}
        onToggleExpand={toggleExpand}
        onVisibilityToggle={handleVisibilityToggle}
        onModelVisibilityToggle={handleModelVisibilityToggle}
        onRemoveModel={handleRemoveModel}
        onModelHeaderClick={handleModelHeaderClick}
      />
    );
  };

  // Multi-model layout with resizable split
  // Grouping mode toggle component (shared by both layouts)
  const groupingToggle = (
    <div className="flex gap-1 mt-2">
      <Button
        variant={groupingMode === 'spatial' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('spatial')}
        title="Spatial"
      >
        <Building2 className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">Spatial</span>
      </Button>
      <Button
        variant={groupingMode === 'type' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('type')}
        title="Class"
      >
        <Layers className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">Class</span>
      </Button>
      <Button
        variant={groupingMode === 'ifc-type' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('ifc-type')}
        title="Type"
      >
        <FileBox className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">Type</span>
      </Button>
    </div>
  );

  // In type/ifc-type grouping mode, always use flat tree layout (even for multi-model)
  if (isMultiModel && groupingMode === 'spatial') {
    return (
      <div ref={containerRef} className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
        {/* Search Header */}
        <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
          <Input
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="h-4 w-4" />}
            className="h-9 text-sm rounded-none border-2 border-zinc-200 dark:border-zinc-800 focus:border-primary focus:ring-0 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
          />
          {groupingToggle}
        </div>

        {/* Resizable content area */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Storeys Section */}
          <div style={{ height: `${splitRatio * 100}%` }} className="flex flex-col min-h-0">
            <SectionHeader icon={Layers} title="Building Storeys" count={storeysNodes.length} />
            <div ref={storeysRef} className="flex-1 overflow-auto scrollbar-thin bg-white dark:bg-black">
              <div
                style={{
                  height: `${storeysVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {storeysVirtualizer.getVirtualItems().map((virtualRow) => {
                  const node = storeysNodes[virtualRow.index];
                  return renderNode(node, virtualRow);
                })}
              </div>
            </div>
          </div>

          {/* Resizable Divider */}
          <div
            className={cn(
              'flex items-center justify-center h-2 cursor-ns-resize border-y border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors',
              isDragging && 'bg-primary/20'
            )}
            onMouseDown={handleResizeStart}
          >
            <GripHorizontal className="h-3 w-3 text-zinc-400" />
          </div>

          {/* Models Section */}
          <div style={{ height: `${(1 - splitRatio) * 100}%` }} className="flex flex-col min-h-0">
            <SectionHeader icon={FileBox} title="Models" count={models.size} />
            <div ref={modelsRef} className="flex-1 overflow-auto scrollbar-thin bg-white dark:bg-black">
              <div
                style={{
                  height: `${modelsVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {modelsVirtualizer.getVirtualItems().map((virtualRow) => {
                  const node = modelsNodes[virtualRow.index];
                  return renderNode(node, virtualRow);
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Footer status */}
        {hasActiveFilters ? (
          <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 bg-primary text-white dark:bg-primary">
            <div className="flex items-center justify-between text-xs font-medium gap-2">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                {selectedStoreys.size > 0 && (
                  <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    {selectedStoreys.size} {selectedStoreys.size === 1 ? 'Storey' : 'Storeys'}
                    <button onClick={clearStoreySelection} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label="Clear storey filter">&times;</button>
                  </span>
                )}
                {classFilter !== null && (
                  <>
                    {selectedStoreys.size > 0 && <span className="text-[10px] opacity-50">+</span>}
                    <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      {classFilter.label}
                      <button onClick={clearClassFilter} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label="Clear class filter">&times;</button>
                    </span>
                  </>
                )}
                {isolatedEntities !== null && (
                  <>
                    {(selectedStoreys.size > 0 || classFilter !== null) && <span className="text-[10px] opacity-50">+</span>}
                    <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      {typeIsolationLabel}
                      <button onClick={clearIsolation} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label="Clear type filter">&times;</button>
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="opacity-70 text-[10px] font-mono">ESC</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] uppercase border border-white/20 hover:bg-white/20 hover:text-white rounded-none px-2"
                  onClick={() => { clearStoreySelection(); clearAllFilters(); }}
                >
                  Clear all
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500 text-center bg-zinc-50 dark:bg-black font-mono">
            {models.size} models · Drag divider to resize
          </div>
        )}
      </div>
    );
  }

  // Single model layout
  return (
    <div className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
      {/* Header */}
      <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
        <Input
          placeholder="Search..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          leftIcon={<Search className="h-4 w-4" />}
          className="h-9 text-sm rounded-none border-2 border-zinc-200 dark:border-zinc-800 focus:border-primary focus:ring-0 bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
        />
        {groupingToggle}
      </div>

      {/* Section Header */}
      <SectionHeader icon={groupingMode === 'spatial' ? Building2 : groupingMode === 'type' ? Layers : FileBox} title={groupingMode === 'spatial' ? 'Hierarchy' : groupingMode === 'type' ? 'By Class' : 'By Type'} count={filteredNodes.length} />

      {/* Tree */}
      <div ref={parentRef} className="flex-1 overflow-auto scrollbar-thin bg-white dark:bg-black">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const node = filteredNodes[virtualRow.index];
            return renderNode(node, virtualRow);
          })}
        </div>
      </div>

      {/* Footer status */}
      {hasActiveFilters ? (
        <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 bg-primary text-white dark:bg-primary">
          <div className="flex items-center justify-between text-xs font-medium gap-2">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              {selectedStoreys.size > 0 && (
                <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {selectedStoreys.size} {selectedStoreys.size === 1 ? 'Storey' : 'Storeys'}
                  <button onClick={clearStoreySelection} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label="Clear storey filter">&times;</button>
                </span>
              )}
              {classFilter !== null && (
                <>
                  {selectedStoreys.size > 0 && <span className="text-[10px] opacity-50">+</span>}
                  <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    {classFilter.label}
                    <button onClick={clearClassFilter} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label="Clear class filter">&times;</button>
                  </span>
                </>
              )}
              {isolatedEntities !== null && (
                <>
                  {(selectedStoreys.size > 0 || classFilter !== null) && <span className="text-[10px] opacity-50">+</span>}
                  <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    {typeIsolationLabel}
                    <button onClick={clearIsolation} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label="Clear type filter">&times;</button>
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="opacity-70 text-[10px] font-mono">ESC</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] uppercase border border-white/20 hover:bg-white/20 hover:text-white rounded-none px-2"
                onClick={() => { clearStoreySelection(); clearAllFilters(); }}
              >
                Clear all
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500 text-center bg-zinc-50 dark:bg-black font-mono">
          Click to filter · Ctrl toggle
        </div>
      )}
    </div>
  );
}
