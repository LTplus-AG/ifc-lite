/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ListPanel - Main container for the Lists feature
 *
 * Shows either:
 * - List builder (when creating/editing a list)
 * - List results table (when a list has been executed)
 * - List library (saved lists + presets)
 */

import React, { useCallback, useState, useMemo } from 'react';
import { X, Table2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import {
  executeList,
  summariseListRows,
  importListDefinition,
  exportListDefinition,
  createListDataProvider,
} from '@/lib/lists';
import type { ListDefinition, ListResult, ListDataProvider, ListGrouping } from '@/lib/lists';
import { mergeResultColumns } from '@/lib/lists/merge-result-columns';
import { extractProjectUnits, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import { useRenderFrameOffsets } from '@/hooks/useRenderFrameOffsets';
import { makeWorldPositionGetter } from '@/lib/geo/entity-world-position';
import { zoneVolumeSiScale } from '@/lib/units/zone-volume-scale';
import { ListBuilder } from './ListBuilder';
import { ListResultsTable } from './ListResultsTable';
import { ListErrorBox } from './ListErrorBox';
import { ListLibrary } from './ListLibrary';

interface ListPanelProps {
  onClose?: () => void;
}

type PanelView = 'library' | 'builder' | 'results';

export function ListPanel({ onClose }: ListPanelProps) {
  const { ifcDataStore, models, geometryResult } = useIfc();
  const renderFrame = useRenderFrameOffsets(); // scene-wide frame for World X/Y/Z (issue #3671)
  const [view, setView] = useState<PanelView>('library');
  const [editingList, setEditingList] = useState<ListDefinition | null>(null);

  const listDefinitions = useViewerStore((s) => s.listDefinitions);
  const activeListId = useViewerStore((s) => s.activeListId);
  const listResult = useViewerStore((s) => s.listResult);
  const listExecuting = useViewerStore((s) => s.listExecuting);
  const addListDefinition = useViewerStore((s) => s.addListDefinition);
  const updateListDefinition = useViewerStore((s) => s.updateListDefinition);
  const deleteListDefinition = useViewerStore((s) => s.deleteListDefinition);
  const setActiveListId = useViewerStore((s) => s.setActiveListId);
  const setListResult = useViewerStore((s) => s.setListResult);
  const setListExecuting = useViewerStore((s) => s.setListExecuting);
  const listError = useViewerStore((s) => s.listError);
  const setListError = useViewerStore((s) => s.setListError);
  const pendingListDraft = useViewerStore((s) => s.pendingListDraft);
  const setPendingListDraft = useViewerStore((s) => s.setPendingListDraft);

  // A draft handed off from "Create list" (search filter) opens straight into
  // the builder for column configuration, then is cleared so it fires once.
  React.useEffect(() => {
    if (!pendingListDraft) return;
    setEditingList(pendingListDraft);
    setView('builder');
    setPendingListDraft(null);
  }, [pendingListDraft, setPendingListDraft]);

  const importInputRef = React.useRef<HTMLInputElement>(null);

  // Zone assignment (issue #1810) is shared across every model's provider —
  // `zoneAssignments` is already keyed by federated global id, so each
  // model's provider just needs ITS OWN `toGlobalId` closure.
  const zoneSets = useViewerStore((s) => s.zoneSets);
  const zoneAssignments = useViewerStore((s) => s.zoneAssignments);
  const zoneApportionment = useViewerStore((s) => s.zoneApportionment);
  const toGlobalId = useViewerStore((s) => s.toGlobalId);

  // Declared VOLUMEUNIT scale per model (#2508), memoized on MODELS alone so
  // zone/assignment changes don't re-derive a value that cannot have moved.
  const volumeScaleByModelId = useMemo(() => {
    const map = new Map<string, number>();
    const scaleOf = (store: IfcDataStore) => (store.source.length > 0
      ? zoneVolumeSiScale(extractProjectUnits(store.source, store.entityIndex)) : 1);
    if (models.size > 0) {
      for (const [modelId, model] of models) {
        if (!model.ifcDataStore) continue;
        map.set(modelId, scaleOf(model.ifcDataStore));
      }
    } else if (ifcDataStore) {
      map.set('default', scaleOf(ifcDataStore));
    }
    return map;
  }, [models, ifcDataStore]);

  // {modelId, provider} pairs, built in one pass so the two arrays can never
  // drift out of alignment.
  const modelProviderPairs = useMemo(() => {
    const pairs: Array<{ modelId: string; provider: ListDataProvider; store: IfcDataStore }> = [];
    if (models.size > 0) {
      for (const [modelId, model] of models) {
        if (!model.ifcDataStore) continue; // native-metadata model, nothing to query
        const zoneContext = {
          zoneSets, zoneAssignments,
          apportionment: zoneApportionment,
          volumeSiScale: volumeScaleByModelId.get(modelId) ?? 1,
          toGlobalId: (expressId: number) => toGlobalId(modelId, expressId),
          getWorldPosition: makeWorldPositionGetter(model.ifcDataStore, model.geometryResult ?? geometryResult, renderFrame, (id) => toGlobalId(modelId, id)),
        };
        pairs.push({ modelId, provider: createListDataProvider(model.ifcDataStore, model.name, zoneContext), store: model.ifcDataStore });
      }
    } else if (ifcDataStore) {
      const zoneContext = {
        zoneSets, zoneAssignments,
        apportionment: zoneApportionment,
        volumeSiScale: volumeScaleByModelId.get('default') ?? 1,
        toGlobalId: (expressId: number) => toGlobalId('default', expressId),
        getWorldPosition: makeWorldPositionGetter(ifcDataStore, geometryResult, renderFrame, (id) => toGlobalId('default', id)),
      };
      pairs.push({ modelId: 'default', provider: createListDataProvider(ifcDataStore, '', zoneContext), store: ifcDataStore });
    }
    return pairs;
  }, [models, ifcDataStore, geometryResult, renderFrame, zoneSets, zoneAssignments, zoneApportionment, volumeScaleByModelId, toGlobalId]);

  const allProviders = useMemo(() => modelProviderPairs.map((p) => p.provider), [modelProviderPairs]);
  const allStores = useMemo(() => modelProviderPairs.map((p) => p.store), [modelProviderPairs]);

  // Every loaded model's declared units, keyed by the same modelId the rows
  // carry (issue #1573 follow-up) — the single per-model source both the
  // on-screen table and the export resolve quantity/measure columns against
  // (`resolveListColumnUnits`), so a federation of models with different
  // declared units converts each row from ITS OWN model's unit rather than
  // assuming every row shares the first model's units.
  const modelUnits = useMemo(() => {
    const map = new Map<string, ProjectUnits>();
    for (const { modelId, store } of modelProviderPairs) {
      map.set(modelId, store.source.length > 0 ? extractProjectUnits(store.source, store.entityIndex) : ProjectUnits.empty());
    }
    return map;
  }, [modelProviderPairs]);

  const hasData = allProviders.length > 0;

  const handleExecuteList = useCallback((definition: ListDefinition) => {
    if (!hasData) return;

    setListExecuting(true);
    setListError(null);
    setActiveListId(definition.id);
    setEditingList(definition);

    // Use requestAnimationFrame to avoid blocking UI during execution
    requestAnimationFrame(() => {
      try {
        const resultParts: ListResult[] = [];
        for (const { modelId, provider } of modelProviderPairs) {
          resultParts.push(executeList(definition, provider, modelId));
        }

        const allRows = resultParts.flatMap(r => r.rows);
        const totalTime = resultParts.reduce((sum, r) => sum + r.executionTime, 0);

        // Re-derive groups/summary over the merged rows so grouping works
        // across federated models (and isn't dropped on the merge).
        const { groups, summary } = summariseListRows(definition, allRows);

        // Merge each part's execution-time quantityType/dataType onto the
        // columns (P0 fix, #1573 follow-up): `definition.columns` alone never
        // carries them, which silently killed the export unit conversion.
        const columns = mergeResultColumns(resultParts, definition.columns);

        setListResult({
          columns,
          rows: allRows,
          totalCount: allRows.length,
          executionTime: totalTime,
          groups,
          summary,
        });
        setView('results');
      } catch (err) {
        // Must be user-visible, not just logged (#4317) — e.g. a name-pattern
        // column compileNameMatcher's ReDoS guard rejects. `view` stays put
        // (never reaches 'results'), so the error box renders over it.
        console.error('[Lists] Execution failed:', err);
        setListError(err instanceof Error ? err.message : String(err));
      } finally {
        setListExecuting(false);
      }
    });
  }, [hasData, modelProviderPairs, setActiveListId, setListResult, setListExecuting, setListError]);

  const handleCreateNew = useCallback(() => {
    setEditingList(null);
    setView('builder');
  }, []);

  const handleEdit = useCallback((definition: ListDefinition) => {
    setEditingList(definition);
    setView('builder');
  }, []);

  const handleDuplicate = useCallback((definition: ListDefinition) => {
    const clone: ListDefinition = {
      ...definition,
      id: crypto.randomUUID(),
      name: `${definition.name} (Copy)`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    addListDefinition(clone);
  }, [addListDefinition]);

  const handleSaveList = useCallback((definition: ListDefinition) => {
    // Check if updating existing or adding new
    const exists = listDefinitions.some(d => d.id === definition.id);
    if (exists) {
      updateListDefinition(definition.id, definition);
    } else {
      addListDefinition(definition);
    }
    setView('library');
  }, [listDefinitions, addListDefinition, updateListDefinition]);

  const handleDelete = useCallback((id: string) => {
    deleteListDefinition(id);
  }, [deleteListDefinition]);

  const handleEditFromResults = useCallback(() => {
    if (editingList) {
      setView('builder');
    }
  }, [editingList]);

  // Grouping/summing changed directly from the results table: update the
  // executed definition (so Settings reflects it), persist if it's saved, and
  // re-derive groups/summary over the current rows for a consistent result.
  const handleGroupingFromTable = useCallback((grouping: ListGrouping | undefined) => {
    const def = editingList;
    if (!def) return;
    const next: ListDefinition = { ...def, grouping };
    setEditingList(next);
    if (listDefinitions.some((d) => d.id === def.id)) {
      updateListDefinition(def.id, { grouping });
    }
    const current = useViewerStore.getState().listResult;
    if (current) {
      const summ = summariseListRows(next, current.rows);
      setListResult({ ...current, groups: summ.groups, summary: summ.summary });
    }
  }, [editingList, listDefinitions, updateListDefinition, setListResult]);

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setListError(null);
    try {
      const definition = await importListDefinition(file);
      addListDefinition(definition);
    } catch (err) {
      // Same bar as execution (#4317): a bad file must not silently no-op.
      console.error('[Lists] Import failed:', err);
      setListError(err instanceof Error ? err.message : String(err));
    }
    e.target.value = '';
  }, [addListDefinition, setListError]);

  const handleExportDefinition = useCallback((definition: ListDefinition) => {
    exportListDefinition(definition);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <Table2 className="h-4 w-4" />
          <span className="font-medium text-sm">
            {view === 'library' && 'Lists'}
            {view === 'builder' && (editingList ? 'Edit List' : 'New List')}
            {view === 'results' && 'Results'}
          </span>
          {view === 'results' && listResult && (
            <span className="text-xs text-muted-foreground">
              ({listResult.totalCount} rows, {listResult.executionTime.toFixed(0)}ms)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {view === 'results' && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Edit Configuration" onClick={handleEditFromResults}>
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit Configuration</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Back to Lists" onClick={() => setView('library')}>
                    <Table2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Back to Lists</TooltipContent>
              </Tooltip>
            </>
          )}
          {view === 'builder' && (
            <Button variant="ghost" size="sm" onClick={() => setView('library')} className="text-xs h-7">
              Cancel
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Rendered over whichever view is active — #4317. */}
      {listError && <ListErrorBox message={listError} onDismiss={() => setListError(null)} />}

      {/* Content */}
      {view === 'library' && (
        <ListLibrary
          definitions={listDefinitions}
          activeListId={activeListId}
          executing={listExecuting}
          hasData={hasData}
          onExecute={handleExecuteList}
          onCreateNew={handleCreateNew}
          onEdit={handleEdit}
          onDuplicate={handleDuplicate}
          onDelete={handleDelete}
          onExport={handleExportDefinition}
          onImport={() => importInputRef.current?.click()}
        />
      )}

      {view === 'builder' && hasData && (
        <ListBuilder
          providers={allProviders}
          stores={allStores}
          initial={editingList}
          onSave={handleSaveList}
          onCancel={() => setView('library')}
          onExecute={handleExecuteList}
        />
      )}

      {view === 'results' && listResult && (
        <ListResultsTable
          result={listResult}
          listName={editingList?.name}
          grouping={editingList?.grouping}
          onGroupingChange={handleGroupingFromTable}
          modelUnits={modelUnits}
        />
      )}

      {/* Hidden import input */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json"
        onChange={handleImport}
        className="hidden"
      />
    </div>
  );
}

