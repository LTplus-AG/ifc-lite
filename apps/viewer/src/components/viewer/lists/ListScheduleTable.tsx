/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ListScheduleTable — the Bonsai-style schedule (pivot) presentation of a
 * grouped list: ONE row per group-value tuple (leaf groups only) instead of
 * the nested collapsible tree, with a first-class Count column and the
 * configured sum columns (issue #1790 round 2).
 *
 * Split out of `ListResultsTable` (PR #1867 review): the pivot header,
 * virtualized body and totals footer are a self-contained presentation, and
 * inlining them compounded an already oversized module.
 *
 * The virtualizer is owned by the PARENT — it scrolls the shared container and
 * its row count switches between this view and the nested one — so it arrives
 * as a prop, already counting `scheduleRows`.
 */

import React, { useCallback, useMemo } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { ArrowUp, ArrowDown } from 'lucide-react';
import type { ColumnDefinition } from '@ifc-lite/lists';
import { cn } from '@/lib/utils';
import {
  formatCellValue, blankRepeatedPathValues,
  type Totals, type ScheduleRow,
} from './list-table-utils';

/** A group-by or summed column reduced to what the pivot header renders. */
export interface ScheduleChip {
  id: string;
  label: string;
}

interface ListScheduleTableProps {
  /** Leaf-group rows, already ordered for display. */
  scheduleRows: ScheduleRow[];
  /** Group-by columns, outermost first. */
  groupChips: ScheduleChip[];
  /** Configured sum columns, in menu order. */
  sumChips: ScheduleChip[];
  /** Full column set — resolves a pivot column back to its original index so
   *  sorting stays in the nested view's index space. */
  columns: ColumnDefinition[];
  sortCol: number | null;
  sortDir: 'asc' | 'desc';
  /** Grand totals for the footer. */
  totals: Totals;
  /** Manual column-width overrides, keyed by ORIGINAL column id (shared with
   *  the nested view, so a resize carries across the view toggle). */
  widthOverrides: Record<string, number>;
  setWidthOverrides: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  /** Shared resize handler; `startWidth` is passed because the pivot header
   *  and the nested header index into different width arrays. */
  startResize: (e: React.MouseEvent, colId: string, startWidth: number) => void;
  onHeaderClick: (colIndex: number) => void;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
}

export function ListScheduleTable({
  scheduleRows, groupChips, sumChips, columns, sortCol, sortDir, totals,
  widthOverrides, setWidthOverrides, startResize, onHeaderClick, virtualizer,
}: ListScheduleTableProps) {
  // Bonsai-style blank-on-repeat: display sugar ONLY — export keeps full values.
  const scheduleDisplayPaths = useMemo(() => blankRepeatedPathValues(scheduleRows), [scheduleRows]);

  // One column per grouping level, a first-class Count column, then the sums.
  //
  // "Group by" and "Sum" are independent menu actions, so the SAME column can
  // be both a grouping key and a summed column. Keying these entries by `id`
  // alone then emits duplicate React keys across header/body/footer, and every
  // `sumColumnIds.includes(col.id)` test matches the group-role cell too — it
  // grows a stray Σ marker and renders the grand total that belongs to the
  // sum-role cell (PR #1867 review). Each entry therefore carries a
  // role-qualified `key` for rendering, while `id` stays the original column
  // id that widths, sorting and `totals.sums` address columns by.
  const scheduleColumns = useMemo(
    () => [
      ...groupChips.map((c) => ({ ...c, key: `group:${c.id}`, role: 'group' as const })),
      { id: '__count', label: 'Count', key: '__count', role: 'count' as const },
      ...sumChips.map((c) => ({ ...c, key: `sum:${c.id}`, role: 'sum' as const })),
    ],
    [groupChips, sumChips]);

  // Width-override key. Normally the ORIGINAL column id, so a resize carries
  // across the schedule/nested view toggle. A column that is BOTH grouped and
  // summed appears twice though, and sharing one key there would make dragging
  // the sigma column silently resize the group column too — so only that
  // second, sum-role instance gets its own key (PR #1867 review).
  const widthKey = useCallback(
    (col: { id: string; role: 'group' | 'count' | 'sum' }) =>
      col.role === 'sum' && groupChips.some((g) => g.id === col.id) ? `sum:${col.id}` : col.id,
    [groupChips]);

  const scheduleColumnWidths = useMemo(() => scheduleColumns.map((c, i) => {
    const wk = c.role === 'sum' && groupChips.some((g) => g.id === c.id) ? `sum:${c.id}` : c.id;
    if (widthOverrides[wk] !== undefined) return widthOverrides[wk];
    if (i >= groupChips.length) return c.role === 'count' ? 90 : 130; // Count / sum columns
    // Group-value columns: size to the widest value actually shown.
    let maxLen = c.label.length;
    for (const row of scheduleRows) {
      const len = (row.path[i] ?? '').length;
      if (len > maxLen) maxLen = len;
    }
    return Math.max(90, Math.min(320, maxLen * 7 + 34));
  }), [scheduleColumns, groupChips.length, scheduleRows, widthOverrides]);

  const scheduleTotalWidth = useMemo(
    () => scheduleColumnWidths.reduce((a, b) => a + b, 0),
    [scheduleColumnWidths]);

  return (
    <div style={{ minWidth: scheduleTotalWidth }}>
      {/* Schedule (pivot) header */}
      <div className="flex sticky top-0 z-10 bg-muted/80 backdrop-blur-sm border-b">
        {scheduleColumns.map((col, colIdx) => {
          const isCount = col.role === 'count';
          const isSum = col.role === 'sum';
          // Sort state rides the ORIGINAL column index space (shared with
          // the nested view), so toggling between views keeps the same
          // sort. Count has no original column — it IS the null-sort
          // default (count-descending), so it's shown but not clickable.
          const originalIdx = isCount ? -1 : columns.findIndex((c) => c.id === col.id);
          return (
            <div
              key={col.key}
              className={cn(
                'relative flex items-center gap-0.5 border-r border-border/50 px-2 py-1.5 text-xs font-medium shrink-0',
                (isCount || isSum) ? 'text-foreground' : 'text-muted-foreground',
              )}
              style={{ width: scheduleColumnWidths[colIdx] }}
            >
              {originalIdx >= 0 ? (
                <button className="flex min-w-0 flex-1 items-center gap-1 hover:text-foreground" onClick={() => onHeaderClick(originalIdx)}>
                  <span className="truncate">{col.label}</span>
                  {isSum && <span className="text-primary">Σ</span>}
                  {sortCol === originalIdx && (sortDir === 'asc' ? <ArrowUp className="h-3 w-3 shrink-0" /> : <ArrowDown className="h-3 w-3 shrink-0" />)}
                </button>
              ) : (
                <span className="truncate flex-1" title="Count aggregate — the default sort order">{col.label}</span>
              )}
              <div
                onMouseDown={(e) => startResize(e, widthKey(col), scheduleColumnWidths[colIdx])}
                onDoubleClick={() => setWidthOverrides((p) => { const n = { ...p }; delete n[widthKey(col)]; return n; })}
                className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40"
                title="Drag to resize · double-click to auto-fit"
              />
            </div>
          );
        })}
      </div>

      {/* One row per group-value tuple — no per-element detail rows. */}
      <div style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const row = scheduleRows[vRow.index];
          if (!row) return null;
          const displayPath = scheduleDisplayPaths[vRow.index];
          const transform = `translateY(${vRow.start}px)`;
          return (
            <div
              key={vRow.key}
              className="absolute left-0 top-0 flex w-full border-b border-border/30 hover:bg-muted/40"
              style={{ transform }}
            >
              {groupChips.map((c, i) => (
                <div
                  key={`group:${c.id}`}
                  className="border-r border-border/20 px-2 py-1 text-xs truncate shrink-0"
                  style={{ width: scheduleColumnWidths[i] }}
                  title={row.path[i]}
                >
                  {displayPath[i]}
                </div>
              ))}
              <div
                className="border-r border-border/20 px-2 py-1 text-xs text-right font-mono tabular-nums shrink-0"
                style={{ width: scheduleColumnWidths[groupChips.length] }}
              >
                {row.count.toLocaleString()}
              </div>
              {sumChips.map((s, i) => (
                <div
                  key={`sum:${s.id}`}
                  className="border-r border-border/20 px-2 py-1 text-xs text-right font-mono tabular-nums shrink-0"
                  style={{ width: scheduleColumnWidths[groupChips.length + 1 + i] }}
                >
                  {formatCellValue(row.sums[s.id])}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Grand-totals footer (sticky, aligned under columns) */}
      <div className="flex sticky bottom-0 z-10 border-t-2 border-border bg-muted/90 backdrop-blur-sm">
        {scheduleColumns.map((col, colIdx) => (
          <div key={col.key} className="flex items-center border-r border-border/30 px-2 py-1 text-xs font-semibold shrink-0" style={{ width: scheduleColumnWidths[colIdx] }}>
            {colIdx === 0 && <span className="text-muted-foreground">Total · {scheduleRows.length.toLocaleString()} group{scheduleRows.length === 1 ? '' : 's'}</span>}
            {col.role === 'count' && <span className="ml-auto font-mono tabular-nums text-foreground">{totals.count.toLocaleString()}</span>}
            {col.role === 'sum' && (
              <span className="ml-auto font-mono tabular-nums text-foreground">{formatCellValue(totals.sums[col.id])}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
