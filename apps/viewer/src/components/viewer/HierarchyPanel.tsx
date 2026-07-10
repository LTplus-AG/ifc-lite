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
  Palette,
  Network,
} from 'lucide-react';
import { extractGroupMembersOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useViewerStore, resolveEntityRef } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useIfc } from '@/hooks/useIfc';
import { useEntityListMultiSelect, type MultiSelectItem } from '@/hooks/useEntityListMultiSelect';
import { Rule, type FilterRule } from '@/lib/search/filter-rules';
import { toast } from '@/components/ui/toast';

import type { TreeNode } from './hierarchy/types';
import { isSpatialContainer } from './hierarchy/types';
import { useHierarchyTree } from './hierarchy/useHierarchyTree';
import { HierarchyNode, SectionHeader } from './hierarchy/HierarchyNode';
import { StoreyDisplayControls } from './hierarchy/StoreyDisplayControls';
import { HierarchySortControl } from './hierarchy/HierarchySortControl';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

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
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
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
  const setActiveStorey = useViewerStore((s) => s.setActiveStorey);
  const setLevelDisplayMode = useViewerStore((s) => s.setLevelDisplayMode);
  const isolateEntities = useViewerStore((s) => s.isolateEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const clearIsolation = useViewerStore((s) => s.clearIsolation);
  const classFilter = useViewerStore((s) => s.classFilter);
  const setClassFilter = useViewerStore((s) => s.setClassFilter);
  const addFilterRule = useViewerStore((s) => s.addFilterRule);
  const updateFilterRule = useViewerStore((s) => s.updateFilterRule);
  const removeFilterRule = useViewerStore((s) => s.removeFilterRule);
  const setSearchFilterAutoRunPending = useViewerStore((s) => s.setSearchFilterAutoRunPending);
  const clearClassFilter = useViewerStore((s) => s.clearClassFilter);
  const clearAllFilters = useViewerStore((s) => s.clearAllFilters);
  const setHierarchyBasketSelection = useViewerStore((s) => s.setHierarchyBasketSelection);

  // Group-isolation needs the camera + the hidden-by-default class toggles
  // (spaces / spatial zones), mirroring the properties panel's Groups & Zones
  // isolate action (#1622, pattern from #1075).
  const cameraCallbacks = useViewerStore((s) => s.cameraCallbacks);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const toggleTypeVisibility = useViewerStore((s) => s.toggleTypeVisibility);

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

  // Use extracted hook for tree data management
  const {
    searchQuery,
    setSearchQuery,
    groupingMode,
    setGroupingMode,
    sortMode,
    setSortMode,
    groupFilter,
    setGroupFilter,
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

  // Explorer-style multi-select over the leaf element / space rows: Ctrl/Cmd
  // toggles, Shift selects the contiguous range in the visible order. Built
  // over the flattened, visible node list so ranges follow what's on screen.
  // Assemblies keep their existing select-all-parts behaviour. (#1463)
  const { select: onMultiSelect, setAnchor: setMultiSelectAnchor } = useEntityListMultiSelect();
  const selectableNodeItems = useMemo<MultiSelectItem[]>(() => {
    const out: MultiSelectItem[] = [];
    for (const node of filteredNodes) {
      if (node.type !== 'element' && node.type !== 'IfcSpace') continue;
      if (node.assemblyChildGlobalIds && node.assemblyChildGlobalIds.length > 0) continue;
      const expressId = node.expressIds[0];
      if (expressId == null) continue;
      out.push({
        globalId: node.globalIds[0] ?? expressId,
        modelId: node.modelIds[0] || 'legacy',
        expressId,
      });
    }
    return out;
  }, [filteredNodes]);
  const selectableNodeIndexById = useMemo(() => {
    const m = new Map<string, number>();
    let idx = 0;
    for (const node of filteredNodes) {
      if (node.type !== 'element' && node.type !== 'IfcSpace') continue;
      if (node.assemblyChildGlobalIds && node.assemblyChildGlobalIds.length > 0) continue;
      if (node.expressIds[0] == null) continue;
      m.set(node.id, idx++);
    }
    return m;
  }, [filteredNodes]);

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

  // Mirror a hierarchy selection into the advanced filter as ONE rule per
  // dimension (issue #1107). Upsert (not append): replace the existing rule of
  // this kind so the filter tracks the current selection — appending singletons
  // both leaves stale values behind and, under the default AND combinator,
  // makes two ifcType rules match nothing. Pass `null` to clear the dimension.
  const upsertSearchRule = useCallback(
    (matches: (r: FilterRule) => boolean, rule: FilterRule | null) => {
      const rules = useViewerStore.getState().searchFilter.rules;
      const idx = rules.findIndex(matches);
      if (rule === null) {
        if (idx < 0) return; // nothing to clear — don't arm an empty run
        removeFilterRule(idx);
      } else if (idx >= 0) {
        updateFilterRule(idx, rule);
      } else {
        addFilterRule(rule);
      }
      // Arm the Filter to run itself: a hierarchy click shouldn't make the
      // user open the modal and press Run to see what it matched. The Filter
      // panel only mounts when the modal is open, so the flag waits there.
      setSearchFilterAutoRunPending(true);
    },
    [addFilterRule, updateFilterRule, removeFilterRule, setSearchFilterAutoRunPending],
  );

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
          const className = node.ifcType || node.name;
          // Class tab → class filter (combinable with storey + type isolation)
          setClassFilter(elements, className);
          // Mirror to the advanced filter: sync the single ifcType rule to the
          // current class (issue #1107). Replace, don't accumulate — the class
          // tab is single-select, so the rule should be exactly the clicked
          // class, not a pile-up of earlier clicks.
          upsertSearchRule((r) => r.kind === 'ifcType' && r.op === 'in', Rule.ifcType([className], 'in'));
          toast.success(`Filter → ${className}`);
        } else {
          // Type tab → type isolation (combinable with storey + class filter)
          isolateEntities(elements);
        }
      }
      return;
    }

    // Material group nodes (Materials tab) - select the material entity for the
    // totals panel + isolate the elements that use it.
    if (node.type === 'material-group') {
      const modelId = node.modelIds[0];
      const materialExpressId = node.entityExpressId;

      // Clear multi-selection first (setSelectedEntityIds([]) resets selectedEntityId)
      setSelectedEntityIds([]);

      if (materialExpressId !== undefined) {
        if (modelId && modelId !== 'legacy') {
          setSelectedEntityId(toGlobalId(modelId, materialExpressId));
          setSelectedEntity({ modelId, expressId: materialExpressId });
          setActiveModel(modelId);
        } else {
          setSelectedEntityId(materialExpressId);
          setSelectedEntity({ modelId: 'legacy', expressId: materialExpressId });
        }
      }

      // Isolate the elements using this material
      const elements = getNodeElements(node);
      if (elements.length > 0) {
        isolateEntities(elements);
      }
      // Mirror to the advanced filter (issue #1107).
      upsertSearchRule((r) => r.kind === 'material', Rule.material('eq', node.name));
      toast.success(`Filter → material ${node.name}`);
      return;
    }

    // Group rows (Groups tab, #1622) - isolate + fit the group's resolved member
    // geometry and select the GROUP entity so its system-level psets show.
    if (node.type === 'group') {
      const modelId = node.modelIds[0] || 'legacy';
      const groupExpressId = node.entityExpressId;
      if (!groupExpressId) return;
      const dataStore = (models.get(modelId)?.ifcDataStore ?? ifcDataStore) as IfcDataStore | null | undefined;
      const groupGlobalId = modelId !== 'legacy'
        ? toGlobalIdFromModels(models, modelId, groupExpressId)
        : groupExpressId;

      // Members can be hidden-by-default classes (IfcSpace / IfcSpatialZone in
      // an IfcZone): flip only the toggles the group actually needs, or the
      // isolated set would render nothing (lifted from PropertiesPanel's
      // handleIsolateGroupMembers, #1075 / PR #1094 review).
      if (dataStore) {
        const members = extractGroupMembersOnDemand(dataStore, groupExpressId);
        if (!typeVisibility.spaces && members.some((m) => m.type === 'IfcSpace')) {
          toggleTypeVisibility('spaces');
        }
        if (!typeVisibility.spatialZones && members.some((m) => m.type === 'IfcSpatialZone')) {
          toggleTypeVisibility('spatialZones');
        }
      }

      // node.globalIds carry the RESOLVED member geometry (ports folded into
      // their nesting host elements) - see buildGroupTree (#1622).
      const memberGlobalIds = node.globalIds;
      if (memberGlobalIds.length > 0) {
        isolateEntities(memberGlobalIds);
        // Highlight members + frame them; the group goes last so it becomes the
        // primary selection and its row reads selected (same trick as
        // decomposing assemblies, #1133).
        setSelectedEntityIds([...memberGlobalIds, groupGlobalId]);
      } else {
        setSelectedEntityIds([]);
        setSelectedEntityId(groupGlobalId);
      }
      // Model-aware ref so the properties panel shows the group's own psets
      // (e.g. Pset_DistributionSystemTypeCommon).
      setSelectedEntity({ modelId, expressId: groupExpressId });
      if (modelId !== 'legacy') setActiveModel(modelId);
      if (memberGlobalIds.length > 0 && cameraCallbacks.frameSelection) {
        window.setTimeout(() => cameraCallbacks.frameSelection?.(), 50);
      }
      if (node.hasChildren) {
        toggleExpand(node.id);
      }
      return;
    }

    // Group member rows (Groups tab, #1622) - select + focus, like picking the
    // element in 3D plus a camera frame (no-op frame for geometry-less members).
    if (node.type === 'group-member') {
      const memberExpressId = node.expressIds[0];
      const modelId = node.modelIds[0] || 'legacy';
      const globalId = node.globalIds[0] ?? memberExpressId;

      setSelectedEntityIds([]);
      setSelectedEntityId(globalId);
      if (modelId !== 'legacy') {
        setSelectedEntity({ modelId, expressId: memberExpressId });
        setActiveModel(modelId);
      } else {
        setSelectedEntity(resolveEntityRef(globalId));
      }
      if (cameraCallbacks.frameSelection) {
        window.setTimeout(() => cameraCallbacks.frameSelection?.(), 50);
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

      // Update the shared active storey (model-aware) so Space Sketch, the
      // Solo level-display mode, and the floorplan all follow the storey the
      // user just clicked. For a multi-model unified storey, pick the first
      // constituent as the representative.
      const activeRep = unified && unified.storeys.length > 0
        ? { modelId: unified.storeys[0].modelId, expressId: unified.storeys[0].storeyId }
        : { modelId: node.modelIds[0] || 'legacy', expressId: storeyIds[0] };
      if (activeRep.expressId != null) setActiveStorey(activeRep);

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
        // Mirror to the advanced filter — accumulate the storey name (issue #1107).
        const cur = useViewerStore.getState().searchFilter.rules.find((r) => r.kind === 'storey' && r.op === 'in');
        const names = cur && cur.kind === 'storey' ? Array.from(new Set([...cur.values, node.name])) : [node.name];
        upsertSearchRule((r) => r.kind === 'storey' && r.op === 'in', Rule.storey(names, 'in'));
        toast.success(`Filter → storey ${node.name}`);
      } else {
        // Single selection - toggle if already selected
        const allAlreadySelected = storeyIds.length > 0 &&
          storeyIds.every(id => selectedStoreys.has(id)) &&
          selectedStoreys.size === storeyIds.length;

        if (allAlreadySelected) {
          // Toggle off - clear selection to show all. The level-display guard
          // (useLevelDisplayEffect) drops Solo → Stacked when no storey is
          // isolated, so the mode flag follows.
          clearStoreySelection();
          // Clear the mirrored storey rule too (issue #1107).
          upsertSearchRule((r) => r.kind === 'storey', null);
          // Make the "click again to leave Solo" behaviour discoverable (#1265).
          toast.success('Showing all storeys');
        } else {
          // Select this storey (replaces any existing selection). Isolating a
          // single storey IS Solo, so reflect that in the level-display mode —
          // keeps the storey-tab control + in-viewport chip in sync.
          setStoreysSelection(storeyIds);
          setLevelDisplayMode('solo');
          // Mirror to the advanced filter: one storey rule = this storey (issue #1107).
          upsertSearchRule((r) => r.kind === 'storey' && r.op === 'in', Rule.storey([node.name], 'in'));
          // Phrase it as Solo so the storey-row to Solo link is obvious (#1265).
          toast.success(`Solo: showing only ${node.name}`);
        }
      }
    } else if (node.type === 'IfcSpace') {
      const spaceId = node.expressIds[0];
      const modelId = node.modelIds[0];
      const globalId = node.globalIds[0] ?? spaceId;

      // Modifier-click -> multi-select (Ctrl/Cmd toggle, Shift range). (#1463)
      const multiIdx = selectableNodeIndexById.get(node.id);
      if (multiIdx !== undefined && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        onMultiSelect(selectableNodeItems, multiIdx, e);
        if (modelId && modelId !== 'legacy') setActiveModel(modelId);
        return;
      }
      // Plain click goes through the legacy single-select below, but still seed
      // the multi-select anchor so a following Shift+click extends from here. (#1463)
      if (multiIdx !== undefined) setMultiSelectAnchor(multiIdx);

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
      const parts = node.assemblyChildGlobalIds;

      // Modifier-click -> multi-select (Ctrl/Cmd toggle, Shift range) for plain
      // elements. Assemblies aren't in the selectable map, so they fall through
      // to their existing select-all-parts behaviour. (#1463)
      const multiIdx = selectableNodeIndexById.get(node.id);
      if (multiIdx !== undefined && (e.shiftKey || e.ctrlKey || e.metaKey)) {
        onMultiSelect(selectableNodeItems, multiIdx, e);
        if (modelId && modelId !== 'legacy') setActiveModel(modelId);
        return;
      }
      // Plain click uses the legacy single-select below, but still seed the
      // multi-select anchor so a following Shift+click extends from here. (#1463)
      if (multiIdx !== undefined) setMultiSelectAnchor(multiIdx);

      if (parts && parts.length > 0) {
        // A decomposing assembly (IfcElementAssembly, IfcStair-as-container, …)
        // carries no geometry of its own — highlight + frame all its parts in
        // one click. The assembly goes last so it becomes the primary selection
        // (setSelectedEntityIds keys selectedEntityId off the final id), which
        // keeps the assembly row highlighted in the tree (#1133).
        setSelectedEntityIds([...parts, globalId]);
        if (modelId !== 'legacy') {
          setSelectedEntity({ modelId, expressId: elementId });
          setActiveModel(modelId);
        } else {
          setSelectedEntity(resolveEntityRef(globalId));
        }
        return;
      }

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
  }, [selectedStoreys, setStoreysSelection, clearStoreySelection, setActiveStorey, setLevelDisplayMode, setSelectedEntityId, setSelectedEntityIds, setSelectedEntity, setSelectedEntities, setActiveModel, toggleExpand, unifiedStoreys, models, ifcDataStore, isolateEntities, getNodeElements, setHierarchyBasketSelection, toGlobalId, groupingMode, setClassFilter, upsertSearchRule, onMultiSelect, setMultiSelectAnchor, selectableNodeItems, selectableNodeIndexById, cameraCallbacks, typeVisibility, toggleTypeVisibility]);

  // Compute selection and visibility state for a node
  const computeNodeState = useCallback((node: TreeNode): { isSelected: boolean; nodeHidden: boolean; modelVisible?: boolean } => {
    // Determine if node is selected
    // For ifc-type nodes, check if the type entity itself is selected
    const isSelected = node.type === 'unified-storey'
      ? node.expressIds.some(id => selectedStoreys.has(id))
      : node.type === 'IfcBuildingStorey'
        ? selectedStoreys.has(node.expressIds[0])
        : node.type === 'IfcSpace' || node.type === 'element' || node.type === 'group-member'
          ? (() => {
              const gId = node.globalIds[0] ?? node.expressIds[0];
              // Honour the multi-selection set so Ctrl/Shift-selected rows all
              // read as highlighted in the tree, not just the primary. (#1463)
              // group-member rows highlight by globalId, so the same element
              // under two groups lights up in both rows (many-to-many, #1622).
              return selectedEntityId === gId || selectedEntityIds.has(gId);
            })()
          : node.type === 'ifc-type' || node.type === 'material-group' || node.type === 'group'
            ? (() => {
                const entityExpressId = node.entityExpressId;
                if (!entityExpressId) return false;
                const mId = node.modelIds[0];
                const gId = mId && mId !== 'legacy'
                  ? toGlobalId(mId, entityExpressId)
                  : entityExpressId;
                return selectedEntityId === gId;
              })()
            : false;

    // Compute visibility inline - for elements check directly, for storeys use getNodeElements
    let nodeHidden = false;
    if (node.type === 'element' || node.type === 'group-member') {
      const parts = node.assemblyChildGlobalIds;
      if (parts && parts.length > 0) {
        // An assembly reads as hidden only when every part it owns is hidden
        // (its own geometry-less id never enters hiddenEntities) (#1133).
        nodeHidden = parts.every((id) => hiddenEntities.has(id));
      } else {
        nodeHidden = hiddenEntities.has(node.globalIds[0] ?? node.expressIds[0]);
      }
    } else if (node.type === 'IfcBuildingStorey' || node.type === 'IfcSpace' || node.type === 'unified-storey' ||
               node.type === 'type-group' || node.type === 'ifc-type' || node.type === 'material-group' ||
               node.type === 'group' ||
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
  }, [selectedStoreys, selectedEntityId, selectedEntityIds, hiddenEntities, getNodeElements, models, toGlobalId]);

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
  if (!ifcDataStore && singleModel) {
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
    <div className="hierarchy-grouping-tabs flex gap-1 mt-2">
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
      <Button
        variant={groupingMode === 'material' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('material')}
        title="Materials"
      >
        <Palette className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">Material</span>
      </Button>
      <Button
        variant={groupingMode === 'groups' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('groups')}
        title="Groups, systems and zones"
      >
        <Network className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">Groups</span>
      </Button>
    </div>
  );

  // Sub-filter chips for the Groups tab (#1622). Session-only; not persisted.
  const groupFilterChips = groupingMode === 'groups' ? (
    <div className="flex gap-1 mt-2">
      {([
        ['all', 'All'],
        ['systems', 'Systems'],
        ['zones', 'Zones'],
        ['other', 'Other'],
      ] as const).map(([value, label]) => (
        <Button
          key={value}
          variant={groupFilter === value ? 'default' : 'outline'}
          size="sm"
          className={cn(
            'h-5 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider px-1',
            // Inactive (outline) chips inherited a too-light zinc-400 in light
            // mode (2.52:1 at 10px). Pin a darker foreground for light mode only;
            // dark mode kept at zinc-400 which already passes.
            groupFilter !== value && 'text-zinc-600 dark:text-zinc-400',
          )}
          onClick={() => setGroupFilter(value)}
        >
          {label}
        </Button>
      ))}
    </div>
  ) : null;

  // In type/ifc-type grouping mode, always use flat tree layout (even for multi-model)
  if (isMultiModel && groupingMode === 'spatial') {
    return (
      <div ref={containerRef} {...tourAnchor(TOUR_ANCHORS.hierarchyPanel)} className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
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
          {groupingMode === 'spatial' && (
            <HierarchySortControl value={sortMode} onChange={setSortMode} />
          )}
        </div>

        {/* Resizable content area */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Storeys Section */}
          <div style={{ height: `${splitRatio * 100}%` }} className="flex flex-col min-h-0">
            <SectionHeader icon={Layers} title="Building Storeys" count={storeysNodes.length} />
            <StoreyDisplayControls />
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
    <div {...tourAnchor(TOUR_ANCHORS.hierarchyPanel)} className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
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
        {groupFilterChips}
        {groupingMode === 'spatial' && (
          <HierarchySortControl value={sortMode} onChange={setSortMode} />
        )}
      </div>

      {/* Section Header */}
      <SectionHeader
        icon={groupingMode === 'spatial' ? Building2 : groupingMode === 'type' ? Layers : groupingMode === 'material' ? Palette : groupingMode === 'groups' ? Network : FileBox}
        title={groupingMode === 'spatial' ? 'Hierarchy' : groupingMode === 'type' ? 'By Class' : groupingMode === 'material' ? 'By Material' : groupingMode === 'groups' ? 'By Group' : 'By Type'}
        count={filteredNodes.length}
      />

      {/* Level display (Stacked / Exploded / Solo) + floorplan — only in the
          spatial view where storeys are the organising concept. */}
      {groupingMode === 'spatial' && <StoreyDisplayControls />}

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
        <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-600 dark:text-zinc-500 text-center bg-zinc-50 dark:bg-black font-mono">
          Click to filter · Ctrl toggle
        </div>
      )}
    </div>
  );
}
