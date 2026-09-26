/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from '@/i18n';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, Building2, Layers, LayoutTemplate, FileBox, GripHorizontal, Palette, Network } from 'lucide-react';
import type { IfcDataStore } from '@ifc-lite/parser';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useViewerStore, resolveEntityRef } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { useEntityListMultiSelect } from '@/hooks/useEntityListMultiSelect';
import { Rule, activeGroupRules, type FilterRule } from '@ifc-lite/rules';
import { toast } from '@/components/ui/toast';
import { EmptyState } from '@/components/ui/empty-state';
import { useSourceHost } from '@/services/sources/SourceHostProvider';
import { syncSourceModel } from '@/lib/sources/syncSourceModel';

import type { TreeNode } from './hierarchy/types';
import { useHierarchyTree } from './hierarchy/useHierarchyTree';
import { useRevealSelection } from './hierarchy/useRevealSelection';
import { useHierarchySplit } from './hierarchy/useHierarchySplit';
import { effectiveGroupAssignments, effectiveGroupMembers } from './hierarchy/effectiveGroupEntities';
import { computeTypeIsolationLabel } from './hierarchy/typeIsolationLabel';
import { HierarchyNode } from './hierarchy/HierarchyNode';
import { HierarchySearchEmptyState } from './hierarchy/HierarchySearchEmptyState';
import { useStrippedHierarchyNodes } from './hierarchy/useStrippedHierarchyNodes';
import { useConfirmRemoveModel } from './hierarchy/useConfirmRemoveModel';
import { SectionHeader } from './hierarchy/SectionHeader';
import { useModelRowSize } from './hierarchy/ModelRowTags';
import { ModelsSectionHeader } from './hierarchy/ModelsSectionHeader';
import { StoreyDisplayControls } from './hierarchy/StoreyDisplayControls';
import { HierarchySortControl } from './hierarchy/HierarchySortControl';
import { hierarchyRowSelection } from './hierarchy/rowSelection';
import type { HierarchyRowAction } from './hierarchy/HierarchyRowActions';
import { applyLevelDisplayMode } from '@/store/levelDisplay';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

export function HierarchyPanel() {
  const { t } = useTranslation();
  const {
    ifcDataStore,
    geometryResult,
    models,
    setActiveModel,
    setModelVisibility,
    removeModel,
    addModel,
  } = useIfc();
  const sourceHost = useSourceHost();
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const setSelectedEntities = useViewerStore((s) => s.setSelectedEntities);
  const setSelectedModelId = useViewerStore((s) => s.setSelectedModelId);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const clearStoreySelection = useViewerStore((s) => s.clearStoreySelection);
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
  const sourceTags = useViewerStore((s) => s.sourceTags);

  // Explicit group isolation reveals hidden-by-default spaces and zones.
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const toggleTypeVisibility = useViewerStore((s) => s.toggleTypeVisibility);

  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const hideEntities = useViewerStore((s) => s.hideEntities);
  const showEntities = useViewerStore((s) => s.showEntities);
  const clearSelection = useViewerStore((s) => s.clearSelection);

  // Derive label for type isolation (from the Type tab, or any other
  // isolation source — e.g. the Filter tab's "Isolate in 3D", #2532) by
  // resolving each isolated id's IFC type through the data-store index
  // (O(1) per id via entities.getTypeName) rather than scanning
  // geometryResult.meshes per id. Only label with a single type name when
  // EVERY isolated id shares it — a heterogeneous isolation must not claim
  // a class the user never isolated (#2532 review: the chip mislabelled a
  // mixed-class Filter result by sampling only the first id). Extracted to
  // `hierarchy/typeIsolationLabel.ts` (pure, unit-tested) — it also skips ids
  // that don't resolve to any federated model rather than querying the
  // fallback store with a raw, un-offset id (#2532 review: could hit an
  // unrelated entity in a multi-model scene and mislabel the chip).
  const typeIsolationLabel = useMemo(
    () => computeTypeIsolationLabel(isolatedEntities, models, ifcDataStore),
    [isolatedEntities, models, ifcDataStore],
  );

  const hasActiveFilters = selectedStoreys.size > 0 || isolatedEntities !== null || classFilter !== null;

  const [syncingSourceModelIds, setSyncingSourceModelIds] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  const { splitRatio, isDragging, handleResizeStart, handleResizeKeyDown } = useHierarchySplit(containerRef);

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
    filteredNodes: rawFilteredNodes,
    storeysNodes: rawStoreysNodes,
    modelsNodes: rawModelsNodes,
    toggleExpand,
    getNodeElements,
    revealGlobalId,
  } = useHierarchyTree({ models, ifcDataStore, isMultiModel, geometryResult });

  const { filteredNodes, storeysNodes, modelsNodes } = useStrippedHierarchyNodes(rawFilteredNodes, rawStoreysNodes, rawModelsNodes);
  const normalizedSearch = searchQuery.trim().toLowerCase();
  const searchEmptyState = normalizedSearch && !filteredNodes.some((node) =>
    node.name.toLowerCase().includes(normalizedSearch) || node.secondaryName?.toLowerCase().includes(normalizedSearch))
    ? <HierarchySearchEmptyState query={searchQuery.trim()} onClear={() => setSearchQuery('')} />
    : null;

  // Use the same Explorer selection contract for every hierarchy grouping.
  // A group row contributes all of its actual members to one logical row.
  const { selectGroups, setAnchor: setMultiSelectAnchor } = useEntityListMultiSelect();
  const anchorSection = useRef('');
  const selectionRows = useMemo(() => ({
    filtered: filteredNodes.map((node) => hierarchyRowSelection(node, models, resolveEntityRef)),
    storeys: storeysNodes.map((node) => hierarchyRowSelection(node, models, resolveEntityRef)),
    models: modelsNodes.map((node) => hierarchyRowSelection(node, models, resolveEntityRef)),
  }), [filteredNodes, storeysNodes, modelsNodes, models]);

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
    estimateSize: useModelRowSize(modelsNodes, () => modelsVirtualizer.measure()), // #4215: a tagged model row carries a chips line
    overscan: 10,
  });

  // Legacy virtualizer for single-model mode
  const virtualizer = useVirtualizer({
    count: filteredNodes.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  // Reveal an outside selection by expanding its ancestors and scrolling to it (#5881).
  const { markFromTreeClick } = useRevealSelection({
    selectedEntityId, groupingMode, revealGlobalId, storeysNodes, modelsNodes, filteredNodes,
    isMultiModel, storeysVirtualizer, modelsVirtualizer, virtualizer,
  });

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

  const { handleRemoveModel, removeModelDialog } = useConfirmRemoveModel(removeModel);

  const handleSyncSourceModel = useCallback(async (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    const model = models.get(modelId);
    const tag = sourceTags.get(modelId);
    if (!model || !tag) return;

    setSyncingSourceModelIds((previous) => new Set(previous).add(modelId));
    try {
      const { latestFile } = await syncSourceModel({
        modelId,
        tag,
        sourceHost,
        addModel,
        removeModel,
      });
      const providerTitle = sourceHost.get(tag.provider)?.manifest.title ?? tag.provider;
      toast.success(`Synced ${latestFile.name} from ${providerTitle}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to sync source model');
    } finally {
      setSyncingSourceModelIds((previous) => {
        const next = new Set(previous);
        next.delete(modelId);
        return next;
      });
    }
  }, [
    addModel,
    models,
    removeModel,
    sourceHost,
    sourceTags,
  ]);

  // Handle model header click (select model + toggle expand)
  const handleModelHeaderClick = useCallback((modelId: string, nodeId: string, hasChildren: boolean) => {
    setSelectedModelId(modelId);
    if (hasChildren) toggleExpand(nodeId);
  }, [setSelectedModelId, toggleExpand]);

  // The explicit Filter by this action upserts one rule per dimension (#1107).
  const upsertSearchRule = useCallback(
    (matches: (r: FilterRule) => boolean, rule: FilterRule | null) => {
      const hs = useViewerStore.getState(); // targets the ACTIVE group only (#4904)
      const idx = activeGroupRules(hs.searchFilter.groups, hs.searchFilterActiveGroup).findIndex(matches);
      if (rule === null) {
        if (idx < 0) return; // nothing to clear — don't arm an empty run
        removeFilterRule(idx);
      } else if (idx >= 0) {
        updateFilterRule(idx, rule);
      } else {
        addFilterRule(rule);
      }
      // The Filter panel may mount later, so keep this explicit action pending.
      setSearchFilterAutoRunPending(true);
    },
    [addFilterRule, updateFilterRule, removeFilterRule, setSearchFilterAutoRunPending],
  );

  type SelectionSection = keyof typeof selectionRows;

  // #5885: activation only selects. Every visibility or filter transition has
  // its own row action, so Enter, click and modifier selection agree.
  const handleNodeClick = useCallback((
    node: TreeNode,
    event: React.MouseEvent | React.KeyboardEvent,
    section: SelectionSection,
    index: number,
  ) => {
    const rows = selectionRows[section][index];
    if (!rows?.length) return;
    try {
      const sectionKey = section === 'filtered' ? `filtered:${groupingMode}` : section;
      if (anchorSection.current !== sectionKey) {
        setMultiSelectAnchor(-1);
        anchorSection.current = sectionKey;
      }
      selectGroups(selectionRows[section], index, event);
      const refs = rows.map(({ modelId, expressId }) => ({ modelId, expressId }));
      setHierarchyBasketSelection(refs);
      if (node.type === 'unified-storey' && refs.length > 1 &&
          !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        // Preserve the combined properties view for a multi-model storey.
        setSelectedEntities(refs);
      }
      const owners = new Set(rows.map((row) => row.modelId));
      if (owners.size === 1) {
        const modelId = rows[0].modelId;
        if (modelId !== 'legacy') setActiveModel(modelId);
      }
    } finally {
      markFromTreeClick();
    }
  }, [selectionRows, groupingMode, selectGroups, setMultiSelectAnchor, setHierarchyBasketSelection, setSelectedEntities, setActiveModel, markFromTreeClick]);

  const handleRowAction = useCallback((node: TreeNode, action: HierarchyRowAction) => {
    const isStorey = node.type === 'unified-storey' || node.type === 'IfcBuildingStorey';
    const storeyRefs = isStorey
      ? node.expressIds.map((expressId, index) => ({ modelId: node.modelIds[index] ?? 'legacy', expressId }))
      : [];
    if (action === 'solo') {
      if (storeyRefs.length > 0) applyLevelDisplayMode('solo', storeyRefs);
      return;
    }
    if (action === 'isolate') {
      const elements = getNodeElements(node);
      if (elements.length === 0) return;
      if (node.type === 'group') {
        // Edited assignments may contain hidden-by-default spaces or zones.
        const modelId = node.modelIds[0] ?? 'legacy';
        const dataStore = (models.get(modelId)?.ifcDataStore ?? ifcDataStore) as IfcDataStore | null | undefined;
        if (dataStore && node.entityExpressId != null) {
          const view = useViewerStore.getState().mutationViews.get(modelId);
          const members = effectiveGroupMembers(
            dataStore, node.entityExpressId, view, effectiveGroupAssignments(dataStore, view),
          );
          if (!typeVisibility.spaces && members.some((member) => member.type === 'IfcSpace')) {
            toggleTypeVisibility('spaces');
          }
          if (!typeVisibility.spatialZones && members.some((member) => member.type === 'IfcSpatialZone')) {
            toggleTypeVisibility('spatialZones');
          }
        }
      }
      isolateEntities(elements);
      return;
    }

    if (action !== 'filter') return;
    if (node.type === 'type-group') {
      const className = node.ifcType ?? node.name;
      setClassFilter(getNodeElements(node), className);
      upsertSearchRule((rule) => rule.kind === 'ifcType' && rule.op === 'in', Rule.ifcType([className], 'in'));
    } else if (node.type === 'ifc-type') {
      upsertSearchRule((rule) => rule.kind === 'type', Rule.typeName('eq', node.name));
    } else if (node.type === 'material-group') {
      upsertSearchRule((rule) => rule.kind === 'material', Rule.material('eq', node.name));
    } else if (node.type === 'group') {
      upsertSearchRule((rule) => rule.kind === 'group', Rule.group('eq', node.name, node.ifcType));
    } else if (isStorey) {
      upsertSearchRule((rule) => rule.kind === 'storey', Rule.storey([node.name], 'in', storeyRefs));
    }
  }, [getNodeElements, models, ifcDataStore, typeVisibility, toggleTypeVisibility, isolateEntities, setClassFilter, upsertSearchRule]);

  const rowActions = useCallback((node: TreeNode): HierarchyRowAction[] => {
    if (node.type === 'model-header' || node.type === 'model-tag-group') return [];
    if (node.type === 'unified-storey' || node.type === 'IfcBuildingStorey') {
      return ['solo', 'filter'];
    }
    const actions: HierarchyRowAction[] = [];
    if (getNodeElements(node).length > 0) actions.push('isolate');
    if (node.type === 'type-group' || node.type === 'ifc-type' ||
        node.type === 'material-group' || node.type === 'group') actions.push('filter');
    return actions;
  }, [getNodeElements]);

  // Compute selection and visibility state for a node
  const computeNodeState = useCallback((node: TreeNode, rows: ReadonlyArray<{ globalId: number }>): { isSelected: boolean; nodeHidden: boolean; modelVisible?: boolean } => {
    const isSelected = rows.length > 0 && rows.every(({ globalId }) =>
      selectedEntityId === globalId || selectedEntityIds.has(globalId));

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
  }, [selectedEntityId, selectedEntityIds, hiddenEntities, getNodeElements, models]);

  if (!ifcDataStore && models.size === 0) {
    return (
      <div className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
        <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">{t('hierarchy.panel.title')}</h2>
        </div>
        <EmptyState
          className="flex-1 bg-white dark:bg-black"
          icon={<LayoutTemplate className="size-8" />}
          title={t('hierarchy.panel.noModelTitle')}
          description={t('hierarchy.panel.noModelHint')}
        />
      </div>
    );
  }

  const singleModel = models.size === 1 ? Array.from(models.values())[0] : null;
  if (!ifcDataStore && singleModel) {
    const metadataState = singleModel.metadataLoadState;
    const message = metadataState === 'error'
      ? (singleModel.loadError || 'Model details failed to load.')
      : singleModel.loadState === 'complete' ? 'No hierarchy available for this model.'
      : 'Building the hierarchy. You can explore the geometry while model details load.';
    return (
      <div className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
        <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
          <h2 className="font-bold uppercase tracking-wider text-xs text-zinc-900 dark:text-zinc-100">{t('hierarchy.panel.title')}</h2>
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
  const renderNode = (node: TreeNode, virtualRow: { index: number; size: number; start: number }, section: SelectionSection) => {
    const { isSelected, nodeHidden, modelVisible } = computeNodeState(node, selectionRows[section][virtualRow.index] ?? []);
    const modelId = node.type === 'model-header' && node.id.startsWith('model-')
      ? node.modelIds[0]
      : undefined;

    return (
      <HierarchyNode
        key={node.id}
        node={node}
        virtualRow={virtualRow}
        isSelected={isSelected}
        nodeHidden={nodeHidden}
        isMultiModel={isMultiModel}
        modelsCount={models.size}
        searchActive={Boolean(searchQuery.trim())}
        modelVisible={modelVisible}
        onNodeClick={(_, event) => handleNodeClick(node, event, section, virtualRow.index)}
        actions={rowActions(node)}
        onAction={handleRowAction}
        onToggleExpand={toggleExpand}
        onVisibilityToggle={handleVisibilityToggle}
        onModelVisibilityToggle={handleModelVisibilityToggle}
        onRemoveModel={handleRemoveModel}
        onSyncSourceModel={handleSyncSourceModel}
        onModelHeaderClick={handleModelHeaderClick}
        sourceBacked={modelId ? sourceTags.has(modelId) : false}
        sourceSyncing={modelId ? syncingSourceModelIds.has(modelId) : false}
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
        title={t('hierarchy.panel.grouping.spatial')}
      >
        <Building2 className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">{t('hierarchy.panel.grouping.spatial')}</span>
      </Button>
      <Button
        variant={groupingMode === 'type' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('type')}
        title={t('hierarchy.panel.grouping.class')}
      >
        <Layers className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">{t('hierarchy.panel.grouping.class')}</span>
      </Button>
      <Button
        variant={groupingMode === 'ifc-type' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('ifc-type')}
        title={t('hierarchy.panel.grouping.type')}
      >
        <FileBox className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">{t('hierarchy.panel.grouping.type')}</span>
      </Button>
      <Button
        variant={groupingMode === 'material' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('material')}
        title={t('hierarchy.panel.grouping.materialsTooltip')}
      >
        <Palette className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">{t('hierarchy.panel.grouping.material')}</span>
      </Button>
      <Button
        variant={groupingMode === 'groups' ? 'default' : 'outline'}
        size="sm"
        className="h-6 text-[10px] flex-1 min-w-0 rounded-none uppercase tracking-wider"
        onClick={() => setGroupingMode('groups')}
        title={t('hierarchy.panel.grouping.groupsTooltip')}
      >
        <Network className="h-3 w-3 shrink-0 panel-compact-icon" />
        <span className="panel-compact-text">{t('hierarchy.panel.grouping.groups')}</span>
      </Button>
    </div>
  );

  // Sub-filter chips for the Groups tab (#1622). Session-only; not persisted.
  const groupFilterChips = groupingMode === 'groups' ? (
    <div className="flex gap-1 mt-2">
      {([
        ['all', 'hierarchy.panel.groupFilter.all'], ['systems', 'hierarchy.panel.groupFilter.systems'],
        ['zones', 'hierarchy.panel.groupFilter.zones'], ['other', 'hierarchy.panel.groupFilter.other'],
      ] as const).map(([value, labelKey]) => (
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
          {t(labelKey)}
        </Button>
      ))}
    </div>
  ) : null;

  // In type/ifc-type grouping mode, always use flat tree layout (even for multi-model)
  if (isMultiModel && groupingMode === 'spatial') {
    return (
      <div ref={containerRef} {...tourAnchor(TOUR_ANCHORS.hierarchyPanel)} className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
        {removeModelDialog}
        {/* Search Header */}
        <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
          <Input
            placeholder={t('hierarchy.panel.searchPlaceholder')}
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
        {searchEmptyState ?? <div className="flex-1 flex flex-col min-h-0">
          {/* Storeys Section */}
          <div style={{ height: `${splitRatio * 100}%` }} className="flex flex-col min-h-0">
            <SectionHeader icon={Layers} title={t('hierarchy.panel.buildingStoreysTitle')} count={storeysNodes.length} />
            <StoreyDisplayControls />
            <div ref={storeysRef} role="tree" aria-label={t('hierarchy.panel.buildingStoreysTitle')} className="flex-1 overflow-auto scrollbar-thin bg-white dark:bg-black">
              <div
                style={{
                  height: `${storeysVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {storeysVirtualizer.getVirtualItems().map((virtualRow) => {
                  const node = storeysNodes[virtualRow.index];
                  return renderNode(node, virtualRow, 'storeys');
                })}
              </div>
            </div>
          </div>

          {/* Resizable Divider */}
          {/* The focusable resize widget contains a grip icon; hr cannot contain children. */}
          {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
          <div role="separator"
            aria-orientation="horizontal"
            aria-label={t('shellChrome.sidebarPanelHost.resizeSplitAriaLabel')}
            aria-valuenow={Math.round(splitRatio * 100)}
            aria-valuemin={15}
            aria-valuemax={85}
            tabIndex={0}
            className={cn(
              'flex items-center justify-center h-2 cursor-ns-resize border-y border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-900 hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors',
              isDragging && 'bg-primary/20'
            )}
            onMouseDown={handleResizeStart}
            onKeyDown={handleResizeKeyDown}
          >
            <GripHorizontal className="h-3 w-3 text-zinc-400" />
          </div>

          {/* Models Section */}
          <div style={{ height: `${(1 - splitRatio) * 100}%` }} className="flex flex-col min-h-0">
            <ModelsSectionHeader count={models.size} />
            <div ref={modelsRef} role="tree" aria-label={t('hierarchy.modelsSection.title')} className="flex-1 overflow-auto scrollbar-thin bg-white dark:bg-black">
              <div
                style={{
                  height: `${modelsVirtualizer.getTotalSize()}px`,
                  width: '100%',
                  position: 'relative',
                }}
              >
                {modelsVirtualizer.getVirtualItems().map((virtualRow) => {
                  const node = modelsNodes[virtualRow.index];
                  return renderNode(node, virtualRow, 'models');
                })}
              </div>
            </div>
          </div>
        </div>}

        {/* Footer status */}
        {hasActiveFilters ? (
          <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 bg-primary text-white dark:bg-primary">
            <div className="flex items-center justify-between text-xs font-medium gap-2">
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                {selectedStoreys.size > 0 && (
                  <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    {t('hierarchy.panel.storeyCount', { count: selectedStoreys.size })}
                    <button onClick={clearStoreySelection} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearStoreyFilterAriaLabel')}>&times;</button>
                  </span>
                )}
                {classFilter !== null && (
                  <>
                    {selectedStoreys.size > 0 && <span className="text-[10px] opacity-50">+</span>}
                    <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      {classFilter.label}
                      <button onClick={clearClassFilter} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearClassFilterAriaLabel')}>&times;</button>
                    </span>
                  </>
                )}
                {isolatedEntities !== null && (
                  <>
                    {(selectedStoreys.size > 0 || classFilter !== null) && <span className="text-[10px] opacity-50">+</span>}
                    <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      {typeIsolationLabel}
                      <button onClick={clearIsolation} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearTypeFilterAriaLabel')}>&times;</button>
                    </span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="opacity-70 text-[10px] font-mono">{t('hierarchy.panel.escHint')}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] uppercase border border-white/20 hover:bg-white/20 hover:text-white rounded-none px-2"
                  onClick={() => { clearStoreySelection(); clearAllFilters(); }}
                >
                  {t('hierarchy.panel.clearAllButton')}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-500 text-center bg-zinc-50 dark:bg-black font-mono">
            {t('hierarchy.panel.modelsFooterHint', { count: models.size })}
          </div>
        )}
      </div>
    );
  }

  // Single model layout
  return (
    <div {...tourAnchor(TOUR_ANCHORS.hierarchyPanel)} className="h-full flex flex-col border-r-2 border-zinc-200 dark:border-zinc-800 bg-white dark:bg-black">
      {removeModelDialog}
      {/* Header */}
      <div className="p-3 border-b-2 border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-black">
        <Input
          placeholder={t('hierarchy.panel.searchPlaceholder')}
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
        title={groupingMode === 'spatial' ? t('hierarchy.panel.sectionTitle.spatial') : groupingMode === 'type' ? t('hierarchy.panel.sectionTitle.byClass') : groupingMode === 'material' ? t('hierarchy.panel.sectionTitle.byMaterial') : groupingMode === 'groups' ? t('hierarchy.panel.sectionTitle.byGroup') : t('hierarchy.panel.sectionTitle.byType')}
        count={filteredNodes.length}
      />

      {/* Level display (Stacked / Exploded / Solo) + floorplan — only in the
          spatial view where storeys are the organising concept. */}
      {groupingMode === 'spatial' && <StoreyDisplayControls />}

      {/* Tree */}
      {searchEmptyState ?? <div ref={parentRef} role="tree" aria-label={t('hierarchy.panel.title')} className="flex-1 overflow-auto scrollbar-thin bg-white dark:bg-black">
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const node = filteredNodes[virtualRow.index];
            return renderNode(node, virtualRow, 'filtered');
          })}
        </div>
      </div>}

      {/* Footer status */}
      {hasActiveFilters ? (
        <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 bg-primary text-white dark:bg-primary">
          <div className="flex items-center justify-between text-xs font-medium gap-2">
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              {selectedStoreys.size > 0 && (
                <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {t('hierarchy.panel.storeyCount', { count: selectedStoreys.size })}
                  <button onClick={clearStoreySelection} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearStoreyFilterAriaLabel')}>&times;</button>
                </span>
              )}
              {classFilter !== null && (
                <>
                  {selectedStoreys.size > 0 && <span className="text-[10px] opacity-50">+</span>}
                  <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    {classFilter.label}
                    <button onClick={clearClassFilter} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearClassFilterAriaLabel')}>&times;</button>
                  </span>
                </>
              )}
              {isolatedEntities !== null && (
                <>
                  {(selectedStoreys.size > 0 || classFilter !== null) && <span className="text-[10px] opacity-50">+</span>}
                  <span className="inline-flex items-center gap-1 bg-white/15 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                    {typeIsolationLabel}
                    <button onClick={clearIsolation} className="ml-0.5 opacity-60 hover:opacity-100 text-xs leading-none" aria-label={t('hierarchy.panel.clearTypeFilterAriaLabel')}>&times;</button>
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="opacity-70 text-[10px] font-mono">{t('hierarchy.panel.escHint')}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] uppercase border border-white/20 hover:bg-white/20 hover:text-white rounded-none px-2"
                onClick={() => { clearStoreySelection(); clearAllFilters(); }}
              >
                {t('hierarchy.panel.clearAllButton')}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-2 border-t-2 border-zinc-200 dark:border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-600 dark:text-zinc-500 text-center bg-zinc-50 dark:bg-black font-mono">
          {t('hierarchy.panel.clickToFilterHint')}
        </div>
      )}
    </div>
  );
}
