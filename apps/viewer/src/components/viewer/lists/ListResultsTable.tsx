/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ListResultsTable — virtualized results grid with in-table grouping &
 * aggregation. The column header is the control surface (sort · group · sum
 * · colour) and every action writes back to the ListDefinition, so the table
 * and the list settings stay in sync. Columns are drag-resizable.
 *
 * PERF: @tanstack/react-virtual renders only visible items (group headers +
 * rows), so 100K+ rows stay smooth.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUp, ArrowDown, Search, Eye, EyeOff, Download, ChevronRight, ChevronDown, FileText, FileSpreadsheet, FileType } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useViewerStore } from '@/store';
import { getVisibleBasketEntityRefsFromStore } from '@/store/basketVisibleSet';
import type { ListResult, ListRow, ColumnDefinition, ListGrouping } from '@ifc-lite/lists';
import { exportList, buildExportModel, EXPORT_LABELS, type ExportFormat } from '@/lib/lists/export';
import { cn } from '@/lib/utils';
import { columnToAutoColor } from '@/lib/lists/columnToAutoColor';
import { AUTO_COLOR_FROM_LIST_ID } from '@/store/slices/lensSlice';
import { ColumnHeaderMenu } from './ColumnHeaderMenu';
import { ListGroupingBar } from './ListGroupingBar';
import {
  formatCellValue, compareCells, detectNumericColumns, autoColumnWidth,
  buildGroupedView, flatTotals, type DisplayItem, type Totals,
} from './list-table-utils';

interface ListResultsTableProps {
  result: ListResult;
  /** List name — used as the export title / filename. */
  listName?: string;
  /** Active grouping from the executed definition (table ↔ settings sync). */
  grouping?: ListGrouping;
  /** Persist a grouping change made from the table back to the definition. */
  onGroupingChange?: (grouping: ListGrouping | undefined) => void;
}

export function ListResultsTable({ result, listName, grouping, onGroupingChange }: ListResultsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterByVisibility, setFilterByVisibility] = useState(true);
  const [colorByColIdx, setColorByColIdx] = useState<number | null>(null);
  const [widthOverrides, setWidthOverrides] = useState<Record<string, number>>({});
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const setSelectedEntityId = useViewerStore((s) => s.setSelectedEntityId);
  const setSelectedEntity = useViewerStore((s) => s.setSelectedEntity);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const activateAutoColorFromColumn = useViewerStore((s) => s.activateAutoColorFromColumn);
  const activeLensId = useViewerStore((s) => s.activeLensId);

  // Visibility state — re-filter when 3D visibility changes.
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

  const columns = result.columns;
  const numericCols = useMemo(() => detectNumericColumns(columns, result.rows), [columns, result.rows]);

  const visibilityFilteredRows = useMemo(() => {
    if (!filterByVisibility) return result.rows;
    const visibleSet = new Set<string>();
    for (const ref of getVisibleBasketEntityRefsFromStore()) visibleSet.add(`${ref.modelId}:${ref.expressId}`);
    return result.rows.filter((row) => {
      const modelId = row.modelId === 'default' ? 'legacy' : row.modelId;
      return visibleSet.has(`${modelId}:${row.entityId}`);
    });
  }, [
    result.rows, filterByVisibility, hiddenEntities, isolatedEntities, classFilter, lensHiddenIds,
    selectedStoreys, typeVisibility, hiddenEntitiesByModel, isolatedEntitiesByModel, models,
    activeBasketViewId, geometryResult,
  ]);

  const filteredRows = useMemo(() => {
    if (!searchQuery) return visibilityFilteredRows;
    const q = searchQuery.toLowerCase();
    return visibilityFilteredRows.filter((row) =>
      row.values.some((v) => v !== null && String(v).toLowerCase().includes(q)));
  }, [visibilityFilteredRows, searchQuery]);

  const sortedRows = useMemo(() => {
    if (sortCol === null) return filteredRows;
    return [...filteredRows].sort((a, b) =>
      compareCells(a.values[sortCol], b.values[sortCol]) * (sortDir === 'asc' ? 1 : -1));
  }, [filteredRows, sortCol, sortDir]);

  // ── Grouping / aggregation derived from the definition ──
  const groupByColumnId = grouping?.columnId ?? '';
  const sumColumnIds = useMemo(() => grouping?.sumColumnIds ?? [], [grouping]);
  const isGrouped = groupByColumnId !== '' && columns.some((c) => c.id === groupByColumnId);
  const groupColLabel = useMemo(() => {
    const c = columns.find((c) => c.id === groupByColumnId);
    return c ? (c.label ?? c.propertyName) : null;
  }, [columns, groupByColumnId]);

  const { items, groupCount, totals, groupKeys } = useMemo<{
    items: DisplayItem[]; groupCount: number; totals: Totals; groupKeys: string[];
  }>(() => {
    if (isGrouped) {
      const view = buildGroupedView(sortedRows, columns, { columnId: groupByColumnId, sumColumnIds }, expandedGroups);
      return {
        items: view.items, groupCount: view.groupCount, totals: view.totals,
        groupKeys: view.items.filter((i) => i.kind === 'group').map((i) => (i as { key: string }).key),
      };
    }
    return {
      items: sortedRows.map((row): DisplayItem => ({ kind: 'row', row })),
      groupCount: 0,
      totals: flatTotals(sortedRows, columns, sumColumnIds),
      groupKeys: [],
    };
  }, [isGrouped, sortedRows, columns, groupByColumnId, sumColumnIds, expandedGroups]);

  const columnWidths = useMemo(
    () => columns.map((c, i) => widthOverrides[c.id] ?? autoColumnWidth(c.label ?? c.propertyName, result.rows, i)),
    [columns, widthOverrides, result.rows]);
  const totalWidth = useMemo(() => columnWidths.reduce((a, b) => a + b, 0), [columnWidths]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (items[i]?.kind === 'group' ? 30 : 28),
    overscan: 18,
    getItemKey: (i) => {
      const it = items[i];
      if (it?.kind === 'group') return `g:${it.key}`;
      const r = (it as { row: ListRow }).row;
      return `r:${r.modelId}:${r.entityId}:${i}`;
    },
  });

  // ── Handlers ──
  const handleHeaderClick = useCallback((colIndex: number) => {
    setSortCol((prev) => {
      if (prev === colIndex) { setSortDir((d) => (d === 'asc' ? 'desc' : 'asc')); return prev; }
      setSortDir('asc'); return colIndex;
    });
  }, []);

  const handleColorByColumn = useCallback((col: ColumnDefinition, colIdx: number) => {
    activateAutoColorFromColumn(columnToAutoColor(col), col.label ?? col.propertyName);
    setColorByColIdx(colIdx);
  }, [activateAutoColorFromColumn]);

  const toggleGroupBy = useCallback((colId: string) => {
    if (!onGroupingChange) return;
    if (groupByColumnId === colId) onGroupingChange(sumColumnIds.length ? { columnId: '', sumColumnIds } : undefined);
    else onGroupingChange({ columnId: colId, sumColumnIds });
  }, [onGroupingChange, groupByColumnId, sumColumnIds]);

  const toggleSum = useCallback((colId: string) => {
    if (!onGroupingChange) return;
    const next = sumColumnIds.includes(colId) ? sumColumnIds.filter((x) => x !== colId) : [...sumColumnIds, colId];
    onGroupingChange((groupByColumnId || next.length) ? { columnId: groupByColumnId, sumColumnIds: next } : undefined);
  }, [onGroupingChange, groupByColumnId, sumColumnIds]);

  const toggleGroupExpand = useCallback((key: string) => {
    setExpandedGroups((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }, []);
  const allExpanded = groupKeys.length > 0 && groupKeys.every((k) => expandedGroups.has(k));
  const toggleExpandAll = useCallback(() => {
    setExpandedGroups(allExpanded ? new Set() : new Set(groupKeys));
  }, [allExpanded, groupKeys]);

  const startResize = useCallback((e: React.MouseEvent, colId: string, colIdx: number) => {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startWidth = columnWidths[colIdx];
    const onMove = (ev: MouseEvent) => setWidthOverrides((p) => ({ ...p, [colId]: Math.max(56, startWidth + (ev.clientX - startX)) }));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = ''; document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  }, [columnWidths]);

  // Export honours the on-screen view: configured columns, the active
  // grouping (sections + per-group count/sums), and the grand totals.
  const handleExport = useCallback((format: ExportFormat) => {
    const model = buildExportModel({
      title: listName?.trim() || 'List',
      columns,
      rows: sortedRows,
      grouping,
      numericCols,
      columnWidths,
      generatedAt: new Date().toLocaleString(),
    });
    void exportList(format, model);
  }, [listName, columns, sortedRows, grouping, numericCols, columnWidths]);

  const handleRowClick = useCallback((row: ListRow) => {
    setSelectedEntity({ modelId: row.modelId, expressId: row.entityId });
    setSelectedEntityId(row.entityId);
  }, [setSelectedEntity, setSelectedEntityId]);

  const sumChips = useMemo(
    () => sumColumnIds.map((id) => {
      const c = columns.find((c) => c.id === id);
      return { id, label: c ? (c.label ?? c.propertyName) : id };
    }),
    [sumColumnIds, columns]);
  const showSumRow = sumColumnIds.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Search / actions */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Filter results..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-7 text-xs border-0 shadow-none focus-visible:ring-0 px-0"
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {sortedRows.length}{(searchQuery || filterByVisibility) ? ` / ${result.rows.length}` : ''} rows
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className={cn('h-6 w-6 shrink-0', filterByVisibility && 'text-primary')} onClick={() => setFilterByVisibility((p) => !p)}>
              {filterByVisibility ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{filterByVisibility ? 'Showing visible objects only' : 'Showing all objects'}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="h-6 w-6 shrink-0">
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>Export…</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem className="gap-2 text-xs" onClick={() => handleExport('csv')}>
              <FileText className="h-3.5 w-3.5" /> {EXPORT_LABELS.csv}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2 text-xs" onClick={() => handleExport('xlsx')}>
              <FileSpreadsheet className="h-3.5 w-3.5" /> {EXPORT_LABELS.xlsx}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2 text-xs" onClick={() => handleExport('pdf')}>
              <FileType className="h-3.5 w-3.5" /> {EXPORT_LABELS.pdf}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Grouping / totals control strip */}
      {(isGrouped || showSumRow) && onGroupingChange && (
        <ListGroupingBar
          groupLabel={isGrouped ? groupColLabel : null}
          sums={sumChips}
          groupCount={groupCount}
          count={totals.count}
          allExpanded={allExpanded}
          onClearGroup={() => onGroupingChange(sumColumnIds.length ? { columnId: '', sumColumnIds } : undefined)}
          onRemoveSum={(id) => toggleSum(id)}
          onToggleExpandAll={toggleExpandAll}
        />
      )}

      {/* Table */}
      <div ref={parentRef} className="flex-1 overflow-auto min-h-0">
        <div style={{ minWidth: totalWidth }}>
          {/* Header */}
          <div className="flex sticky top-0 z-10 bg-muted/80 backdrop-blur-sm border-b">
            {columns.map((col, colIdx) => {
              const colored = activeLensId === AUTO_COLOR_FROM_LIST_ID && colorByColIdx === colIdx;
              const groupedBy = groupByColumnId === col.id;
              const summed = sumColumnIds.includes(col.id);
              return (
                <div
                  key={col.id}
                  className={cn(
                    'group/col relative flex items-center gap-0.5 border-r border-border/50 px-2 py-1.5 text-xs font-medium text-muted-foreground shrink-0',
                    colored && 'bg-primary/10',
                    (groupedBy || summed) && 'text-foreground',
                  )}
                  style={{ width: columnWidths[colIdx] }}
                >
                  <button className="flex min-w-0 flex-1 items-center gap-1 hover:text-foreground" onClick={() => handleHeaderClick(colIdx)}>
                    {groupedBy && <ChevronDown className="h-3 w-3 shrink-0 text-primary" aria-label="grouped" />}
                    <span className="truncate">{col.label ?? col.propertyName}</span>
                    {summed && <span className="text-primary">Σ</span>}
                    {sortCol === colIdx && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />)}
                  </button>
                  {onGroupingChange && (
                    <ColumnHeaderMenu
                      isNumeric={numericCols[colIdx]}
                      isGroupedBy={groupedBy}
                      isSummed={summed}
                      active={groupedBy || summed || colored}
                      onSort={(dir) => { setSortCol(colIdx); setSortDir(dir); }}
                      onToggleGroup={() => toggleGroupBy(col.id)}
                      onToggleSum={() => toggleSum(col.id)}
                      onColorBy={() => handleColorByColumn(col, colIdx)}
                    />
                  )}
                  <div
                    onMouseDown={(e) => startResize(e, col.id, colIdx)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={() => setWidthOverrides((p) => { const n = { ...p }; delete n[col.id]; return n; })}
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                    title="Drag to resize · double-click to auto-fit"
                  />
                </div>
              );
            })}
          </div>

          {/* Virtualized rows / group headers */}
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              const item = items[vRow.index];
              if (!item) return null;
              const transform = `translateY(${vRow.start}px)`;

              if (item.kind === 'group') {
                const expanded = expandedGroups.has(item.key);
                return (
                  <div
                    key={vRow.key}
                    className="absolute left-0 top-0 flex w-full cursor-pointer border-b border-border/40 bg-muted/50 hover:bg-muted/70"
                    style={{ transform }}
                    onClick={() => toggleGroupExpand(item.key)}
                  >
                    {columns.map((col, colIdx) => (
                      <div key={col.id} className="flex items-center gap-1 border-r border-border/20 px-2 py-1 text-xs font-medium shrink-0" style={{ width: columnWidths[colIdx] }}>
                        {colIdx === 0 && (
                          <>
                            {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                            <span className="truncate" title={item.label}>{item.label}</span>
                            <span className="ml-1 shrink-0 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums text-muted-foreground">{item.count.toLocaleString()}</span>
                          </>
                        )}
                        {sumColumnIds.includes(col.id) && (
                          <span className="ml-auto font-mono tabular-nums">{formatCellValue(item.sums[col.id])}</span>
                        )}
                      </div>
                    ))}
                  </div>
                );
              }

              const row = item.row;
              const isSelected = row.entityId === selectedEntityId;
              return (
                <div
                  key={vRow.key}
                  className={cn('absolute left-0 top-0 flex w-full cursor-pointer border-b border-border/30 hover:bg-muted/40', isSelected && 'bg-primary/10')}
                  style={{ transform }}
                  onClick={() => handleRowClick(row)}
                >
                  {row.values.map((value, colIdx) => (
                    <div
                      key={colIdx}
                      className={cn('border-r border-border/20 px-2 py-1 text-xs truncate shrink-0', numericCols[colIdx] && 'text-right font-mono tabular-nums', isGrouped && colIdx === 0 && 'pl-6')}
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

          {/* Grand-totals footer (sticky, aligned under columns) */}
          {showSumRow && (
            <div className="flex sticky bottom-0 z-10 border-t-2 border-border bg-muted/90 backdrop-blur-sm">
              {columns.map((col, colIdx) => (
                <div key={col.id} className="flex items-center border-r border-border/30 px-2 py-1 text-xs font-semibold shrink-0" style={{ width: columnWidths[colIdx] }}>
                  {colIdx === 0 && <span className="text-muted-foreground">Total · {totals.count.toLocaleString()}</span>}
                  {sumColumnIds.includes(col.id) && (
                    <span className="ml-auto font-mono tabular-nums text-foreground">{formatCellValue(totals.sums[col.id])}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
