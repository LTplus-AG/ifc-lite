/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ListResultsTable - Virtualized table displaying list execution results
 *
 * PERF: Uses @tanstack/react-virtual for efficient rendering of large result sets.
 * Only renders visible rows, supports 100K+ rows smoothly.
 * Clicking a row selects the entity in the 3D viewer.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUp, ArrowDown, Search, Palette, Eye, EyeOff, Download } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { getVisibleBasketEntityRefsFromStore } from '@/store/basketVisibleSet';
import type { ListResult, ListRow, CellValue, ColumnDefinition } from '@ifc-lite/lists';
import { listResultToCSV } from '@ifc-lite/lists';
import { cn } from '@/lib/utils';
import { columnToAutoColor } from '@/lib/lists/columnToAutoColor';
import { AUTO_COLOR_FROM_LIST_ID } from '@/store/slices/lensSlice';

interface ListResultsTableProps {
  result: ListResult;
}

export function ListResultsTable({ result }: ListResultsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterByVisibility, setFilterByVisibility] = useState(true);

  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntity = useViewerStore((s) => s.setSelectedEntity);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const activateAutoColorFromColumn = useViewerStore((s) => s.activateAutoColorFromColumn);
  const activeLensId = useViewerStore((s) => s.activeLensId);
  const [colorByColIdx, setColorByColIdx] = useState<number | null>(null);

  // Subscribe to visibility state so we re-filter when 3D visibility changes
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const classFilter = useViewerStore((s) => s.classFilter);
  const lensHiddenIds = useViewerStore((s) => s.lensHiddenIds);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const hiddenEntitiesByModel = useViewerStore((s) => s.hiddenEntitiesByModel);
  const isolatedEntitiesByModel = useViewerStore((s) => s.isolatedEntitiesByModel);
  const models = useViewerStore((s) => s.models);
  const activeBasketViewId = useViewerStore((s) => s.activeBasketViewId);
  const geometryResult = useViewerStore((s) => s.geometryResult);

  // Filter rows by 3D visibility
  const visibilityFilteredRows = useMemo(() => {
    if (!filterByVisibility) return result.rows;

    const visibleRefs = getVisibleBasketEntityRefsFromStore();
    const visibleSet = new Set<string>();
    for (const ref of visibleRefs) {
      visibleSet.add(`${ref.modelId}:${ref.expressId}`);
    }

    return result.rows.filter(row => {
      // List uses 'default' for single-model, visibility uses 'legacy'
      const modelId = row.modelId === 'default' ? 'legacy' : row.modelId;
      return visibleSet.has(`${modelId}:${row.entityId}`);
    });
  }, [
    result.rows, filterByVisibility,
    hiddenEntities, isolatedEntities, classFilter, lensHiddenIds,
    selectedStoreys, typeVisibility, hiddenEntitiesByModel,
    isolatedEntitiesByModel, models, activeBasketViewId, geometryResult,
  ]);

  // Filter rows by search query
  const filteredRows = useMemo(() => {
    if (!searchQuery) return visibilityFilteredRows;
    const q = searchQuery.toLowerCase();
    return visibilityFilteredRows.filter(row =>
      row.values.some(v => v !== null && String(v).toLowerCase().includes(q))
    );
  }, [visibilityFilteredRows, searchQuery]);

  // Sort rows
  const sortedRows = useMemo(() => {
    if (sortCol === null) return filteredRows;
    const sorted = [...filteredRows];
    sorted.sort((a, b) => {
      const va = a.values[sortCol];
      const vb = b.values[sortCol];
      return compareCells(va, vb) * (sortDir === 'asc' ? 1 : -1);
    });
    return sorted;
  }, [filteredRows, sortCol, sortDir]);

  const handleHeaderClick = useCallback((colIndex: number) => {
    if (sortCol === colIndex) {
      setSortDir(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(colIndex);
      setSortDir('asc');
    }
  }, [sortCol]);

  const handleColorByColumn = useCallback((col: ColumnDefinition, colIdx: number) => {
    const spec = columnToAutoColor(col);
    const label = col.label ?? col.propertyName;
    activateAutoColorFromColumn(spec, label);
    setColorByColIdx(colIdx);
  }, [activateAutoColorFromColumn]);

  const handleExportCSV = useCallback(() => {
    const exportResult: ListResult = {
      columns: result.columns,
      rows: sortedRows,
      totalCount: sortedRows.length,
      executionTime: result.executionTime,
    };
    const csv = listResultToCSV(exportResult);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'list-export.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [result.columns, result.executionTime, sortedRows]);

  const handleRowClick = useCallback((row: ListRow) => {
    setSelectedEntity({ modelId: row.modelId, expressId: row.entityId });
    // For single-model, selectedEntityId is the expressId
    // For multi-model, we'd need the global ID, but we set expressId for now
    setSelectedEntityId(row.entityId);
  }, [setSelectedEntity, setSelectedEntityId]);

  // Column widths
  const columnWidths = useMemo(() => {
    return result.columns.map(col => {
      const label = col.label ?? col.propertyName;
      // Estimate width: min 80px, max 250px, based on header + content
      return Math.max(80, Math.min(250, label.length * 8 + 40));
    });
  }, [result.columns]);

  const totalWidth = useMemo(() => columnWidths.reduce((a, b) => a + b, 0), [columnWidths]);

  const virtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 20,
  });

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Search bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Filter results..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="h-7 text-xs border-0 shadow-none focus-visible:ring-0 px-0"
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {sortedRows.length}{(searchQuery || filterByVisibility) ? ` / ${result.rows.length}` : ''} rows
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                'h-6 w-6 shrink-0',
                filterByVisibility && 'text-primary',
              )}
              onClick={() => setFilterByVisibility(prev => !prev)}
            >
              {filterByVisibility ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {filterByVisibility ? 'Showing visible objects only' : 'Showing all objects'}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-6 w-6 shrink-0"
              onClick={handleExportCSV}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Export CSV</TooltipContent>
        </Tooltip>
      </div>

      {/* Grouping & totals summary */}
      {result.groups && result.summary && (
        <GroupSummaryPanel result={result} />
      )}

      {/* Table */}
      <div ref={parentRef} className="flex-1 overflow-auto min-h-0">
        <div style={{ minWidth: totalWidth }}>
          {/* Header */}
          <div className="flex sticky top-0 bg-muted/80 backdrop-blur-sm border-b z-10">
            {result.columns.map((col, colIdx) => {
              const isColoredCol = activeLensId === AUTO_COLOR_FROM_LIST_ID && colorByColIdx === colIdx;
              return (
                <div
                  key={col.id}
                  className={cn(
                    'flex items-center gap-0.5 px-2 py-1.5 text-xs font-medium text-muted-foreground border-r border-border/50 shrink-0 group/col',
                    isColoredCol && 'bg-primary/10',
                  )}
                  style={{ width: columnWidths[colIdx] }}
                >
                  <button
                    className="flex items-center gap-1 flex-1 min-w-0 hover:text-foreground"
                    onClick={() => handleHeaderClick(colIdx)}
                  >
                    <span className="truncate">
                      {col.label ?? col.propertyName}
                    </span>
                    {sortCol === colIdx && (
                      sortDir === 'asc'
                        ? <ArrowUp className="h-3 w-3 shrink-0" />
                        : <ArrowDown className="h-3 w-3 shrink-0" />
                    )}
                  </button>
                  <button
                    className={cn(
                      'shrink-0 p-0.5 rounded-sm transition-opacity',
                      isColoredCol
                        ? 'text-primary opacity-100'
                        : 'opacity-0 group-hover/col:opacity-100 text-muted-foreground hover:text-primary',
                    )}
                    onClick={(e) => { e.stopPropagation(); handleColorByColumn(col, colIdx); }}
                    title={`Color by ${col.label ?? col.propertyName}`}
                  >
                    <Palette className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Virtualized rows */}
          <div
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {virtualizer.getVirtualItems().map(virtualRow => {
              const row = sortedRows[virtualRow.index];
              const isSelected = row.entityId === selectedEntityId;

              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className={cn(
                    'flex absolute top-0 left-0 w-full border-b border-border/30 cursor-pointer hover:bg-muted/40',
                    isSelected && 'bg-primary/10'
                  )}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                  onClick={() => handleRowClick(row)}
                >
                  {row.values.map((value, colIdx) => (
                    <div
                      key={colIdx}
                      className="px-2 py-1 text-xs truncate border-r border-border/20 shrink-0"
                      style={{ width: columnWidths[colIdx] }}
                      title={value !== null ? String(value) : ''}
                    >
                      {formatCellValue(value)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupSummaryPanel({ result }: { result: ListResult }) {
  const groups = result.groups ?? [];
  const summary = result.summary;
  const sumColIds = summary ? Object.keys(summary.sums) : [];
  const labelOf = (id: string): string => {
    const col = result.columns.find(c => c.id === id);
    return col?.label ?? col?.propertyName ?? id;
  };

  return (
    <div className="border-b bg-muted/30 px-3 py-2 text-xs max-h-48 overflow-auto">
      <div className="flex items-center gap-2 mb-1 font-medium">
        <span>
          {groups.length} group{groups.length === 1 ? '' : 's'} · {summary?.count ?? 0} elements
        </span>
        {sumColIds.length > 0 && (
          <span className="ml-auto flex flex-wrap gap-x-3 gap-y-0.5 justify-end text-muted-foreground">
            {sumColIds.map(id => (
              <span key={id}>
                Σ {labelOf(id)}:{' '}
                <span className="font-mono text-foreground">{formatCellValue(summary!.sums[id])}</span>
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        {groups.map(g => (
          <div key={g.key} className="flex items-center gap-2">
            <span className="flex-1 truncate" title={g.label}>{g.label}</span>
            <span className="font-mono text-muted-foreground w-14 text-right shrink-0">{g.count}</span>
            {sumColIds.map(id => (
              <span key={id} className="font-mono w-24 text-right shrink-0">
                {formatCellValue(g.sums[id])}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatCellValue(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    // Format numbers: integers as-is, decimals with up to 4 decimal places
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(4).replace(/\.?0+$/, '');
  }
  return String(value);
}

function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}
