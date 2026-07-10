/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers for the Lists results table — value formatting, comparison,
 * numeric-column detection, content-aware column widths, and the grouping /
 * aggregation that powers the in-table (settings-free) grouped view.
 */

import type { CellValue, ColumnDefinition, ListRow, ListGrouping } from '@ifc-lite/lists';
import { buildGroupBuckets, compareCells, orderGroups, type GroupSort, type OrderableGroup } from '@/lib/lists/group-sort';

// Re-exported so existing consumers keep importing the list-table barrel.
export { compareCells, orderGroups };
export type { GroupSort, OrderableGroup };

export function formatCellValue(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(4).replace(/\.?0+$/, '');
  }
  return String(value);
}

/** A column is numeric (summable) when every sampled non-empty value is a
 *  finite number and at least one such value exists. */
export function detectNumericColumns(columns: ColumnDefinition[], rows: ListRow[]): boolean[] {
  const sample = rows.slice(0, 120);
  return columns.map((_, i) => {
    let sawNumber = false;
    for (const r of sample) {
      const v = r.values[i];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'number' && Number.isFinite(v)) { sawNumber = true; continue; }
      return false;
    }
    return sawNumber;
  });
}

/** Content-aware default width: fits the header + the widest sampled value
 *  (≈7px/char), clamped to a readable range. */
export function autoColumnWidth(label: string, rows: ListRow[], colIdx: number): number {
  let maxLen = label.length;
  const sample = rows.slice(0, 200);
  for (const r of sample) {
    const v = r.values[colIdx];
    if (v === null || v === undefined) continue;
    const len = (typeof v === 'number' ? formatCellValue(v) : String(v)).length;
    if (len > maxLen) maxLen = len;
  }
  return Math.max(80, Math.min(460, maxLen * 7 + 34));
}

export type DisplayItem =
  | { kind: 'group'; key: string; label: string; count: number; sums: Record<string, number> }
  | { kind: 'row'; row: ListRow };

export interface Totals { count: number; sums: Record<string, number> }
export interface GroupedView { items: DisplayItem[]; groupCount: number; totals: Totals }

function sumIndices(columns: ColumnDefinition[], sumColumnIds: string[]) {
  return sumColumnIds
    .map((id) => ({ id, idx: columns.findIndex((c) => c.id === id) }))
    .filter((s) => s.idx >= 0);
}

/** Bucket already-filtered/sorted rows by the group-by column, accumulate
 *  per-group + grand count/sums, and flatten into a virtualizable list
 *  (group header followed by its rows when the group is expanded). */
export function buildGroupedView(
  rows: ListRow[],
  columns: ColumnDefinition[],
  grouping: ListGrouping,
  expanded: Set<string>,
  sort: GroupSort = null,
): GroupedView {
  const groupIdx = columns.findIndex((c) => c.id === grouping.columnId);
  const sums = sumIndices(columns, grouping.sumColumnIds);

  const byKey = buildGroupBuckets(
    rows,
    (r) => (groupIdx >= 0 ? r.values[groupIdx] : null),
    sums,
    (r, idx) => r.values[idx],
    formatCellValue,
  );

  // Grand totals are the sum of the per-group subtotals.
  const totals: Totals = { count: rows.length, sums: Object.fromEntries(sums.map((s) => [s.id, 0])) };
  for (const g of byKey.values()) for (const s of sums) totals.sums[s.id] += g.sums[s.id];

  const groups = orderGroups(Array.from(byKey.values()), sort, groupIdx, sums);
  const items: DisplayItem[] = [];
  for (const g of groups) {
    items.push({ kind: 'group', key: g.key, label: g.label, count: g.count, sums: g.sums });
    if (expanded.has(g.key)) for (const r of g.rows) items.push({ kind: 'row', row: r });
  }
  return { items, groupCount: groups.length, totals };
}

/** Grand totals for the flat (ungrouped) view when sum columns are active. */
export function flatTotals(rows: ListRow[], columns: ColumnDefinition[], sumColumnIds: string[]): Totals {
  const sums = sumIndices(columns, sumColumnIds);
  const acc: Record<string, number> = Object.fromEntries(sums.map((s) => [s.id, 0]));
  for (const r of rows) {
    for (const s of sums) {
      const v = r.values[s.idx];
      if (typeof v === 'number' && Number.isFinite(v)) acc[s.id] += v;
    }
  }
  return { count: rows.length, sums: acc };
}
