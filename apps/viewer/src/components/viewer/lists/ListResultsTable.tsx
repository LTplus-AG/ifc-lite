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

import { useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUp, ArrowDown, Search, Eye, EyeOff, Download, ChevronRight, ChevronDown, FileText, FileSpreadsheet, FileType } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { EmptyState } from '@/components/ui/empty-state';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useViewerStore } from '@/store';
import { getVisibleBasketEntityRefsFromStore } from '@/store/basketVisibleSet';
import { toGlobalIdFromModels } from '@/store/globalId';
import { useEntityListMultiSelect, type MultiSelectItem, type SelectModifiers } from '@/hooks/useEntityListMultiSelect';
import { groupingColumnIds, type ListResult, type ListRow, type ColumnDefinition, type ListGrouping } from '@ifc-lite/lists';
import type { ProjectUnits } from '@ifc-lite/parser';
import { exportList, buildExportModel, EXPORT_LABELS, type ExportFormat } from '@/lib/lists/export';
import { resolveListColumnUnits } from '@/lib/units/list-column-units';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { columnToAutoColor } from '@/lib/lists/columnToAutoColor';
import { AUTO_COLOR_FROM_LIST_ID } from '@/store/slices/lensSlice';
import { useTranslation } from '@/i18n/useTranslation'; import { ColumnHeaderMenu } from './ColumnHeaderMenu'; import { formatLocaleCount } from './formatLocaleCount';
import { ListGroupingBar } from './ListGroupingBar';
import { ListScheduleTable } from './ListScheduleTable';
import { ColumnResizeHandle } from './ColumnResizeHandle';
import { formatCellValue, compareCells, detectNumericColumns, autoColumnWidth,
  buildGroupedView, flatTotals, buildScheduleRows, rebuildGrouping,
  type DisplayItem, type Totals, type ScheduleRow } from './list-table-utils';
interface ListResultsTableProps {
  result: ListResult;
  /** List name — used as the export title / filename. */
  listName?: string;
  /** Active grouping from the executed definition (table ↔ settings sync). */
  grouping?: ListGrouping;
  /** Persist a grouping change made from the table back to the definition. */
  onGroupingChange?: (grouping: ListGrouping | undefined) => void;
  /** Per-model declared units (issue #1573 follow-up), keyed by the same
   *  `modelId` every `ListRow` carries — lets quantity/measure columns
   *  render (and export) CONVERTED into one resolved target unit via
   *  `resolveListColumnUnits`, the same resolver `buildExportModel` uses, so
   *  the on-screen table and the export can never disagree. */
  modelUnits: Map<string, ProjectUnits>;
}

export function ListResultsTable({ result, listName, grouping, onGroupingChange, modelUnits }: ListResultsTableProps) {
  const { t, locale } = useTranslation(); const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const parentRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterByVisibility, setFilterByVisibility] = useState(true);
  const [colorByColIdx, setColorByColIdx] = useState<number | null>(null);
  const [widthOverrides, setWidthOverrides] = useState<Record<string, number>>({});
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  const activateAutoColorFromColumn = useViewerStore((s) => s.activateAutoColorFromColumn);
  const activeLensId = useViewerStore((s) => s.activeLensId);
  const { select: onMultiSelect } = useEntityListMultiSelect();

  // Visibility state — re-filter when 3D visibility changes.
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const isolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const classFilter = useViewerStore((s) => s.classFilter);
  const lensHiddenIds = useViewerStore((s) => s.lensHiddenIds);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const typeVisibility = useViewerStore((s) => s.typeVisibility);
  const models = useViewerStore((s) => s.models);
  const activeBasketViewId = useViewerStore((s) => s.activeBasketViewId);
  const geometryResult = useViewerStore((s) => s.geometryResult);

  const columns = result.columns;
  const numericCols = useMemo(() => detectNumericColumns(columns, result.rows), [columns, result.rows]);

  // Single per-column unit resolution (issue #1573 follow-up), shared with
  // `buildExportModel` so the table and the export can never disagree.
  const unitResolver = useMemo(
    () => resolveListColumnUnits(columns, modelUnits, unitDisplayOverrides),
    [columns, modelUnits, unitDisplayOverrides],
  );

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
    selectedStoreys, typeVisibility, models,
    activeBasketViewId, geometryResult,
  ]);

  const filteredRows = useMemo(() => {
    if (!searchQuery) return visibilityFilteredRows;
    const q = searchQuery.toLowerCase();
    return visibilityFilteredRows.filter((row) =>
      row.values.some((v) => v !== null && String(v).toLowerCase().includes(q)));
  }, [visibilityFilteredRows, searchQuery]);

  // Sorts on the RAW value (single-model monotonic either way; a federated
  // column mixing declared units sorts by each row's pre-conversion number —
  // pre-existing, units aren't resolved per-row for sorting).
  const sortedRows = useMemo(() => {
    if (sortCol === null) return filteredRows;
    return [...filteredRows].sort((a, b) =>
      compareCells(a.values[sortCol], b.values[sortCol]) * (sortDir === 'asc' ? 1 : -1));
  }, [filteredRows, sortCol, sortDir]);

  // Rows as DISPLAYED (converted via `unitResolver`) — cell rendering, group
  // subtotals, and the grand-totals row all agree with the export (#1573).
  const displayRows = useMemo(
    () => sortedRows.map((r) => ({ ...r, values: r.values.map((v, i) => unitResolver.convertCell(i, v, r.modelId)) })),
    [sortedRows, unitResolver],
  );

  // ── Grouping / aggregation derived from the definition ──
  // Multi-criteria grouping (issue #1790): ordered group-by columns,
  // outermost first, restricted to columns that actually exist in the result.
  const groupColumnIds = useMemo(
    () => groupingColumnIds(grouping).filter((id) => columns.some((c) => c.id === id)),
    [grouping, columns]);
  const sumColumnIds = useMemo(() => grouping?.sumColumnIds ?? [], [grouping]);
  const isGrouped = groupColumnIds.length > 0;
  const groupChips = useMemo(
    () => groupColumnIds.map((id) => {
      const c = columns.find((c) => c.id === id);
      return { id, label: c ? (c.label ?? c.propertyName) : id };
    }),
    [groupColumnIds, columns]);
  const sumChips = useMemo(
    () => sumColumnIds.map((id) => {
      const c = columns.find((c) => c.id === id);
      return { id, label: c ? (c.label ?? c.propertyName) : id };
    }),
    [sumColumnIds, columns]);
  const showSumRow = sumColumnIds.length > 0;

  // Result presentation (issue #1790 round 2): `schedule` swaps the nested
  // collapsible tree for a Bonsai-style pivot table — one row per group-value
  // tuple, grouping columns first, then a first-class Count column, then any
  // configured sums. Only meaningful once grouped.
  const scheduleMode = isGrouped && grouping?.view === 'schedule';
  const scheduleRows = useMemo<ScheduleRow[]>(() => {
    if (!scheduleMode) return [];
    const sort = sortCol === null ? null : { colIdx: sortCol, dir: sortDir };
    return buildScheduleRows(
      displayRows, columns,
      { columnId: groupColumnIds[0], columnIds: groupColumnIds, sumColumnIds },
      sort,
    );
  }, [scheduleMode, displayRows, columns, groupColumnIds, sumColumnIds, sortCol, sortDir]);
  // The pivot header/body/footer live in `ListScheduleTable` — see the note
  // there on role-qualified column keys.

  const handleViewChange = useCallback((next: 'nested' | 'schedule') => {
    if (!onGroupingChange || !grouping) return;
    onGroupingChange({ ...grouping, view: next });
  }, [onGroupingChange, grouping]);

  const { items, groupCount, totals, groupKeys } = useMemo<{
    items: DisplayItem[]; groupCount: number; totals: Totals; groupKeys: string[];
  }>(() => {
    if (isGrouped) {
      const sort = sortCol === null ? null : { colIdx: sortCol, dir: sortDir };
      const view = buildGroupedView(
        displayRows, columns,
        { columnId: groupColumnIds[0], columnIds: groupColumnIds, sumColumnIds },
        expandedGroups, sort,
      );
      return { items: view.items, groupCount: view.groupCount, totals: view.totals, groupKeys: view.groupKeys };
    }
    return {
      items: displayRows.map((row): DisplayItem => ({ kind: 'row', row })),
      groupCount: 0,
      totals: flatTotals(displayRows, columns, sumColumnIds),
      groupKeys: [],
    };
  }, [isGrouped, displayRows, columns, groupColumnIds, sumColumnIds, expandedGroups, sortCol, sortDir]);

  const columnWidths = useMemo(
    () => columns.map((c, i) => widthOverrides[c.id] ?? autoColumnWidth(c.label ?? c.propertyName, result.rows, i)),
    [columns, widthOverrides, result.rows]);
  const totalWidth = useMemo(() => columnWidths.reduce((a, b) => a + b, 0), [columnWidths]);

  const virtualizer = useVirtualizer({
    count: scheduleMode ? scheduleRows.length : items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (scheduleMode ? 28 : (items[i]?.kind === 'group' ? 30 : 28)),
    overscan: 18,
    getItemKey: (i) => {
      if (scheduleMode) return `s:${scheduleRows[i]?.key ?? i}`;
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

  // Toggling a column in/out of the grouping: a second (third, …) column adds
  // a nesting level (multi-criteria grouping, issue #1790). `columnId` is kept
  // in sync with the first level for pre-multi-level consumers. `rebuildGrouping`
  // spreads the previous grouping so fields it doesn't touch — `view`, issue
  // #1790 round 2 — survive instead of silently resetting (bug found in QA:
  // removing a grouping level or toggling a sum column used to drop the
  // active schedule view back to nested).
  const toggleGroupBy = useCallback((colId: string) => {
    if (!onGroupingChange) return;
    const next = groupColumnIds.includes(colId)
      ? groupColumnIds.filter((x) => x !== colId)
      : [...groupColumnIds, colId];
    onGroupingChange(rebuildGrouping(grouping, next, sumColumnIds));
  }, [onGroupingChange, grouping, groupColumnIds, sumColumnIds]);

  const toggleSum = useCallback((colId: string) => {
    if (!onGroupingChange) return;
    const next = sumColumnIds.includes(colId) ? sumColumnIds.filter((x) => x !== colId) : [...sumColumnIds, colId];
    onGroupingChange(rebuildGrouping(grouping, groupColumnIds, next));
  }, [onGroupingChange, grouping, groupColumnIds, sumColumnIds]);

  const toggleGroupExpand = useCallback((key: string) => {
    setExpandedGroups((prev) => { const n = new Set(prev); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }, []);
  const allExpanded = groupKeys.length > 0 && groupKeys.every((k) => expandedGroups.has(k));
  const toggleExpandAll = useCallback(() => {
    setExpandedGroups(allExpanded ? new Set() : new Set(groupKeys));
  }, [allExpanded, groupKeys]);

  // Export honours the on-screen columns, grouping, sums, and totals.
  const handleExport = useCallback((format: ExportFormat) => {
    const model = buildExportModel({
      title: listName?.trim() || t('lists.resultsTable.defaultTitle'),
      columns,
      rows: sortedRows,
      grouping,
      sort: sortCol === null ? null : { colIdx: sortCol, dir: sortDir },
      numericCols,
      columnWidths,
      generatedAt: new Date().toLocaleString(),
      modelUnits,
      unitDisplayOverrides,
    });
    void exportList(format, model).catch((error) => {
      console.error('[Lists] export failed:', error);
      toast.error(t('lists.resultsTable.exportFailed', { message: error instanceof Error ? error.message : 'Unknown error' }));
    });
  }, [listName, columns, sortedRows, grouping, sortCol, sortDir, numericCols, columnWidths, modelUnits, unitDisplayOverrides, t]);
  // Flat, ordered list of the selectable rows (group headers excluded) and a
  // lookup from a row to its position, so Shift+click range-select works over
  // the on-screen order. (#1463)
  const selectableItems = useMemo<MultiSelectItem[]>(() => {
    const out: MultiSelectItem[] = [];
    for (const it of items) {
      if (it.kind !== 'row') continue;
      const r = (it as { row: ListRow }).row;
      out.push({
        globalId: toGlobalIdFromModels(models, r.modelId, r.entityId),
        modelId: r.modelId,
        expressId: r.entityId,
      });
    }
    return out;
  }, [items, models]);
  const rowIndexByKey = useMemo(() => {
    const m = new Map<string, number>();
    selectableItems.forEach((it, idx) => m.set(`${it.modelId}:${it.expressId}`, idx));
    return m;
  }, [selectableItems]);
  const handleRowClick = useCallback((row: ListRow, e: SelectModifiers) => {
    const idx = rowIndexByKey.get(`${row.modelId}:${row.entityId}`);
    if (idx === undefined) return;
    onMultiSelect(selectableItems, idx, e);
  }, [rowIndexByKey, selectableItems, onMultiSelect]);
  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Search / actions */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b">
        <Search className="h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder={t('lists.resultsTable.filterPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="h-7 text-xs border-0 shadow-none focus-visible:ring-0 px-0"
        />
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {(searchQuery || filterByVisibility) ? t('lists.resultsTable.rowCountOfTotal', { count: sortedRows.length, countDisplay: formatLocaleCount(sortedRows.length, locale), total: formatLocaleCount(result.rows.length, locale) }) : t('lists.resultsTable.rowCount', { count: sortedRows.length, countDisplay: formatLocaleCount(sortedRows.length, locale) })}
        </span>
        <IconButton
          label={filterByVisibility ? t('lists.resultsTable.showingVisibleOnly') : t('lists.resultsTable.showingAllObjects')}
          size="icon-sm"
          className={cn('h-6 w-6 shrink-0', filterByVisibility && 'text-primary')}
          aria-pressed={filterByVisibility}
          onClick={() => setFilterByVisibility((p) => !p)}
        >
          {filterByVisibility ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </IconButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label={t('lists.resultsTable.exportAriaLabel')} tooltip={t('lists.resultsTable.exportEllipsis')} size="icon-sm" className="h-6 w-6 shrink-0">
              <Download className="h-3.5 w-3.5" />
            </IconButton>
          </DropdownMenuTrigger>
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
          groups={groupChips}
          sums={sumChips}
          groupCount={groupCount}
          count={totals.count}
          allExpanded={allExpanded}
          onRemoveGroup={(id) => toggleGroupBy(id)}
          onRemoveSum={(id) => toggleSum(id)}
          onToggleExpandAll={toggleExpandAll}
          view={isGrouped ? (grouping?.view ?? 'nested') : undefined}
          onViewChange={isGrouped ? handleViewChange : undefined}
        />
      )}

      {/* Table */}
      <div ref={parentRef} className="flex-1 overflow-auto min-h-0">
      {scheduleMode ? (
        <ListScheduleTable
          scheduleRows={scheduleRows}
          groupChips={groupChips}
          sumChips={sumChips}
          columns={columns}
          sortCol={sortCol}
          sortDir={sortDir}
          totals={totals}
          widthOverrides={widthOverrides}
          setWidthOverrides={setWidthOverrides}
          onHeaderClick={handleHeaderClick}
          virtualizer={virtualizer}
        />
      ) : (
        <div style={{ minWidth: totalWidth }}>
          {/* Header */}
          <div className="flex sticky top-0 z-10 bg-muted/80 backdrop-blur-sm border-b">
            {columns.map((col, colIdx) => {
              const colored = activeLensId === AUTO_COLOR_FROM_LIST_ID && colorByColIdx === colIdx;
              const groupLevel = groupColumnIds.indexOf(col.id);
              const groupedBy = groupLevel >= 0;
              const summed = sumColumnIds.includes(col.id);
              const unit = unitResolver.unitSymbol(colIdx);
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
                    {groupedBy && <ChevronDown className="h-3 w-3 shrink-0 text-primary" aria-label={t('lists.resultsTable.groupedAriaLabel')} />}
                    {groupedBy && groupColumnIds.length > 1 && (
                      <span className="shrink-0 text-[9px] font-semibold tabular-nums text-primary" aria-label={t('lists.resultsTable.groupingLevelAriaLabel', { level: groupLevel + 1 })}>
                        {groupLevel + 1}
                      </span>
                    )}
                    <span className="truncate">{col.label ?? col.propertyName}{unit ? ` (${unit})` : ''}</span>
                    {summed && <span className="text-primary">{t('lists.resultsTable.sumIcon')}</span>}
                    {sortCol === colIdx && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />)}
                  </button>
                  {onGroupingChange && (
                    <ColumnHeaderMenu
                      isNumeric={numericCols[colIdx]}
                      isGroupedBy={groupedBy}
                      groupedElsewhere={isGrouped && !groupedBy}
                      isSummed={summed}
                      active={groupedBy || summed || colored}
                      onSort={(dir) => { setSortCol(colIdx); setSortDir(dir); }}
                      onToggleGroup={() => toggleGroupBy(col.id)}
                      onToggleSum={() => toggleSum(col.id)}
                      onColorBy={() => handleColorByColumn(col, colIdx)}
                    />
                  )}
                  <ColumnResizeHandle
                    columnId={col.id}
                    width={columnWidths[colIdx]}
                    title={`${col.label ?? col.propertyName}: ${t('lists.resultsTable.dragToResizeTitle')}`}
                    setWidthOverrides={setWidthOverrides}
                  />
                </div>
              );
            })}
          </div>
          {/* Virtualized rows / group headers */}
          {sortedRows.length === 0 && <EmptyState icon={<FileSpreadsheet className="size-8" />} title={t('lists.resultsTable.noRows')} />}
          <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              const item = items[vRow.index];
              if (!item) return null;
              const transform = `translateY(${vRow.start}px)`;

              if (item.kind === 'group') {
                const expanded = expandedGroups.has(item.key);
                return (
                  <button
                    key={vRow.key}
                    type="button"
                    aria-expanded={expanded}
                    className="absolute left-0 top-0 flex w-full cursor-pointer border-b border-border/40 bg-muted/50 text-left hover:bg-muted/70"
                    style={{ transform }}
                    onClick={() => toggleGroupExpand(item.key)}
                  >
                    {columns.map((col, colIdx) => (
                      <span
                        key={col.id}
                        className="flex items-center gap-1 border-r border-border/20 px-2 py-1 text-xs font-medium shrink-0"
                        // Sub-groups indent one step per nesting level (#1790).
                        style={{ width: columnWidths[colIdx], ...(colIdx === 0 && item.level > 0 ? { paddingLeft: 8 + item.level * 14 } : undefined) }}
                      >
                        {colIdx === 0 && (
                          <>
                            {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                            <span className="truncate" title={item.label}>{item.label}</span>
                            <span className="ml-1 shrink-0 rounded-full bg-foreground/10 px-1.5 text-[10px] tabular-nums text-muted-foreground">{formatLocaleCount(item.count, locale)}</span>
                          </>
                        )}
                        {sumColumnIds.includes(col.id) && (
                          <span className="ml-auto font-mono tabular-nums">{formatCellValue(item.sums[col.id])}</span>
                        )}
                      </span>
                    ))}
                  </button>
                );
              }

              const row = item.row;
              const globalId = toGlobalIdFromModels(models, row.modelId, row.entityId);
              const isSelected = selectedEntityIds.has(globalId) || globalId === selectedEntityId;
              return (
                <button
                  key={vRow.key}
                  type="button"
                  aria-pressed={isSelected}
                  className={cn('absolute left-0 top-0 flex w-full cursor-pointer select-none border-b border-border/30 text-left hover:bg-muted/40', isSelected && 'bg-primary/10')}
                  style={{ transform }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handleRowClick(row, event); }
                  }}
                  onClick={(e) => handleRowClick(row, e)}
                >
                  {row.values.map((value, colIdx) => (
                    <span
                      key={colIdx}
                      className={cn('border-r border-border/20 px-2 py-1 text-xs truncate shrink-0', numericCols[colIdx] && 'text-right font-mono tabular-nums')}
                      // Member rows sit one indent step past the deepest group header.
                      style={{ width: columnWidths[colIdx], ...(isGrouped && colIdx === 0 ? { paddingLeft: 8 + groupColumnIds.length * 16 } : undefined) }}
                      title={value !== null ? String(value) : ''}
                    >
                      {formatCellValue(value)}
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
          {/* Grand-totals footer (sticky, aligned under columns) */}
          {showSumRow && (
            <div className="flex sticky bottom-0 z-10 border-t-2 border-border bg-muted/90 backdrop-blur-sm">
              {columns.map((col, colIdx) => (
                <div key={col.id} className="flex items-center border-r border-border/30 px-2 py-1 text-xs font-semibold shrink-0" style={{ width: columnWidths[colIdx] }}>
                  {colIdx === 0 && <span className="text-muted-foreground">{t('lists.resultsTable.totalCount', { count: formatLocaleCount(totals.count, locale) })}</span>}
                  {sumColumnIds.includes(col.id) && (
                    <span className="ml-auto font-mono tabular-nums text-foreground">{formatCellValue(totals.sums[col.id])}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
