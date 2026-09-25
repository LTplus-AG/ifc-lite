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

import React, { useCallback, useState } from 'react';
import { Table2, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { useViewerStore } from '@/store';
import {
  summariseListRows,
  importListDefinition,
  exportListDefinition,
} from '@/lib/lists';
import type { ListDefinition, ListGrouping } from '@/lib/lists';
import { runListFederated } from '@/lib/lists/run-list';
import { useListProviders } from './useListProviders';
import { ListBuilder } from './ListBuilder';
import { ListResultsTable } from './ListResultsTable';
import { ListErrorBox } from './ListErrorBox';
import { ListLibrary } from './ListLibrary';
import { useTranslation } from '@/i18n/useTranslation';
import { formatLocaleCount } from './formatLocaleCount';

type PanelView = 'library' | 'builder' | 'results';

export function ListPanel() {
  const { t, locale } = useTranslation();
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

  // Providers + declared units per model, shared with document table blocks (#5142).
  const { pairs: modelProviderPairs, providers: allProviders, stores: allStores, modelUnits, hasData } = useListProviders();
  const listModelIds = React.useMemo(() => modelProviderPairs.map((pair) => pair.modelId), [modelProviderPairs]);

  const handleExecuteList = useCallback((definition: ListDefinition) => {
    if (!hasData) return;

    setListExecuting(true);
    setListError(null);
    setActiveListId(definition.id);
    setEditingList(definition);

    // Use requestAnimationFrame to avoid blocking UI during execution
    requestAnimationFrame(() => {
      try {
        setListResult(runListFederated(definition, modelProviderPairs, useViewerStore.getState()));
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
      name: t('lists.panel.copyName', { name: definition.name }),
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
            {view === 'library' && t('lists.panel.title')}
            {view === 'builder' && (editingList ? t('lists.panel.editList') : t('lists.panel.newList'))}
            {view === 'results' && t('lists.panel.results')}
          </span>
          {view === 'results' && listResult && (
            <span className="text-xs text-muted-foreground">
              ({t('lists.panel.resultsSummary', {
                count: listResult.totalCount,
                countDisplay: formatLocaleCount(listResult.totalCount, locale),
                ms: listResult.executionTime.toFixed(0),
              })})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {view === 'results' && (
            <>
              <IconButton
                label={t('lists.panel.editConfiguration')}
                size="icon-sm"
                onClick={handleEditFromResults}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </IconButton>
              <IconButton
                label={t('lists.panel.backToLists')}
                size="icon-sm"
                onClick={() => setView('library')}
              >
                <Table2 className="h-3.5 w-3.5" />
              </IconButton>
            </>
          )}
          {view === 'builder' && (
            <Button variant="ghost" size="sm" onClick={() => setView('library')} className="text-xs h-7">
              {t('lists.panel.cancel')}
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
          modelIds={listModelIds}
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
