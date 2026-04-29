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
import {
  X,
  Plus,
  Play,
  FileSpreadsheet,
  Trash2,
  Download,
  Upload,
  Loader2,
  Table2,
  Pencil,
  Copy,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import {
  executeList,
  LIST_PRESETS,
  importListDefinition,
  exportListDefinition,
  createListDataProvider,
} from '@/lib/lists';
import type { ListDefinition, ListResult, ListDataProvider } from '@/lib/lists';
import { ListBuilder } from './ListBuilder';
import { ListResultsTable } from './ListResultsTable';

interface ListPanelProps {
  onClose?: () => void;
}

type PanelView = 'library' | 'builder' | 'results';

export function ListPanel({ onClose }: ListPanelProps) {
  const { ifcDataStore, models } = useIfc();
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

  const importInputRef = React.useRef<HTMLInputElement>(null);

  // Collect all available data providers for multi-model support
  const allProviders = useMemo(() => {
    const providers: ListDataProvider[] = [];
    if (models.size > 0) {
      for (const [, model] of models) {
        // Skip native-metadata models — they don't have a parsed
        // IfcDataStore, so the list provider can't query them.
        if (!model.ifcDataStore) continue;
        providers.push(createListDataProvider(model.ifcDataStore));
      }
    } else if (ifcDataStore) {
      providers.push(createListDataProvider(ifcDataStore));
    }
    return providers;
  }, [models, ifcDataStore]);

  const hasData = allProviders.length > 0;

  // Build a stable map of modelId → provider index for execution
  const modelProviderPairs = useMemo(() => {
    const pairs: Array<{ modelId: string; provider: ListDataProvider }> = [];
    if (models.size > 0) {
      let i = 0;
      for (const [modelId] of models) {
        pairs.push({ modelId, provider: allProviders[i++] });
      }
    } else if (allProviders.length > 0) {
      pairs.push({ modelId: 'default', provider: allProviders[0] });
    }
    return pairs;
  }, [models, allProviders]);

  const handleExecuteList = useCallback((definition: ListDefinition) => {
    if (!hasData) return;

    setListExecuting(true);
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

        setListResult({
          columns: definition.columns,
          rows: allRows,
          totalCount: allRows.length,
          executionTime: totalTime,
        });
        setView('results');
      } catch (err) {
        console.error('[Lists] Execution failed:', err);
      } finally {
        setListExecuting(false);
      }
    });
  }, [hasData, modelProviderPairs, setActiveListId, setListResult, setListExecuting]);

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

  const handleImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const definition = await importListDefinition(file);
      addListDefinition(definition);
    } catch (err) {
      console.error('[Lists] Import failed:', err);
    }
    e.target.value = '';
  }, [addListDefinition]);

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
                  <Button variant="ghost" size="icon-sm" onClick={handleEditFromResults}>
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit Configuration</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => setView('library')}>
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
            <Button variant="ghost" size="icon-sm" onClick={onClose}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

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
          initial={editingList}
          onSave={handleSaveList}
          onCancel={() => setView('library')}
          onExecute={handleExecuteList}
        />
      )}

      {view === 'results' && listResult && (
        <ListResultsTable result={listResult} />
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

// ============================================================================
// List Library Sub-Component
// ============================================================================

interface ListLibraryProps {
  definitions: ListDefinition[];
  activeListId: string | null;
  executing: boolean;
  hasData: boolean;
  onExecute: (def: ListDefinition) => void;
  onCreateNew: () => void;
  onEdit: (def: ListDefinition) => void;
  onDuplicate: (def: ListDefinition) => void;
  onDelete: (id: string) => void;
  onExport: (def: ListDefinition) => void;
  onImport: () => void;
}

function ListLibrary({
  definitions,
  activeListId,
  executing,
  hasData,
  onExecute,
  onCreateNew,
  onEdit,
  onDuplicate,
  onDelete,
  onExport,
  onImport,
}: ListLibraryProps) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Actions */}
      <div className="flex items-center gap-1 px-3 py-2 border-b">
        <Button
          variant="outline"
          size="sm"
          onClick={onCreateNew}
          disabled={!hasData}
          className="text-xs h-7"
        >
          <Plus className="h-3 w-3 mr-1" />
          New List
        </Button>
        <Button variant="ghost" size="sm" onClick={onImport} className="text-xs h-7">
          <Upload className="h-3 w-3 mr-1" />
          Import
        </Button>
      </div>

      <ScrollArea className="flex-1">
        {/* User's saved lists */}
        {definitions.length > 0 && (
          <div className="px-3 py-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Saved Lists
            </span>
            <div className="mt-1 space-y-1">
              {definitions.map(def => (
                <ListItem
                  key={def.id}
                  definition={def}
                  isActive={activeListId === def.id}
                  executing={executing && activeListId === def.id}
                  hasData={hasData}
                  onExecute={onExecute}
                  onEdit={onEdit}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                  onExport={onExport}
                />
              ))}
            </div>
          </div>
        )}

        {definitions.length > 0 && <Separator className="my-1" />}

        {/* Presets */}
        <div className="px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Templates
          </span>
          <div className="mt-1 space-y-1">
            {LIST_PRESETS.map(preset => (
              <ListItem
                key={preset.id}
                definition={preset}
                isActive={activeListId === preset.id}
                executing={executing && activeListId === preset.id}
                hasData={hasData}
                onExecute={onExecute}
                onDuplicate={onDuplicate}
                isPreset
              />
            ))}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

// ============================================================================
// List Item
// ============================================================================

interface ListItemProps {
  definition: ListDefinition;
  isActive: boolean;
  executing: boolean;
  hasData: boolean;
  onExecute: (def: ListDefinition) => void;
  onEdit?: (def: ListDefinition) => void;
  onDuplicate?: (def: ListDefinition) => void;
  onDelete?: (id: string) => void;
  onExport?: (def: ListDefinition) => void;
  isPreset?: boolean;
}

function ListItem({ definition, isActive, executing, hasData, onExecute, onEdit, onDuplicate, onDelete, onExport, isPreset }: ListItemProps) {
  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer hover:bg-muted/50 ${
        isActive ? 'bg-muted' : ''
      }`}
      onClick={() => hasData && onExecute(definition)}
    >
      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="truncate text-xs font-medium">{definition.name}</div>
        {definition.description && (
          <div className="truncate text-xs text-muted-foreground">{definition.description}</div>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {executing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasData) onExecute(definition);
                  }}
                  disabled={!hasData}
                >
                  <Play className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Run</TooltipContent>
            </Tooltip>
            {!isPreset && onEdit && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(definition);
                    }}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Edit</TooltipContent>
              </Tooltip>
            )}
            {onDuplicate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDuplicate(definition);
                    }}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isPreset ? 'Use as Template' : 'Duplicate'}</TooltipContent>
              </Tooltip>
            )}
            {!isPreset && onExport && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6"
                    onClick={(e) => {
                      e.stopPropagation();
                      onExport(definition);
                    }}
                  >
                    <Download className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Export</TooltipContent>
              </Tooltip>
            )}
            {!isPreset && onDelete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(definition.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete</TooltipContent>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  );
}
