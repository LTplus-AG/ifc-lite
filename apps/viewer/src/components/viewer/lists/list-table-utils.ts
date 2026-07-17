/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers for the Lists results table — value formatting, comparison,
 * numeric-column detection, content-aware column widths, and the grouping /
 * aggregation that powers the in-table (settings-free) grouped view.
 */

import { groupingColumnIds, type CellValue, type ColumnDefinition, type ListRow, type ListGrouping } from '@ifc-lite/lists';
import { buildNestedGroupBuckets, compareCells, orderGroups, type GroupSort, type OrderableGroup } from '@/lib/lists/group-sort';

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
  | { kind: 'group'; key: string; label: string; count: number; sums: Record<string, number>; level: number }
  | { kind: 'row'; row: ListRow };

export interface Totals { count: number; sums: Record<string, number> }
export interface GroupedView {
  items: DisplayItem[];
  /** Number of top-level groups. */
  groupCount: number;
  totals: Totals;
  /** EVERY group key at every nesting level (including ones hidden inside a
   *  collapsed parent), so expand-all can open the whole tree at once. */
  groupKeys: string[];
}

function sumIndices(columns: ColumnDefinition[], sumColumnIds: string[]) {
  return sumColumnIds
    .map((id) => ({ id, idx: columns.findIndex((c) => c.id === id) }))
    .filter((s) => s.idx >= 0);
}

/** Bucket already-filtered/sorted rows by the group-by column(s), accumulate
 *  per-group + grand count/sums, and flatten into a virtualizable list
 *  (group header followed by its subgroups/rows when the group is expanded).
 *  Multi-criteria grouping (issue #1790) nests one header level per group
 *  column; every header carries its member count. */
export function buildGroupedView(
  rows: ListRow[],
  columns: ColumnDefinition[],
  grouping: ListGrouping,
  expanded: Set<string>,
  sort: GroupSort = null,
): GroupedView {
  const groupIds = groupingColumnIds(grouping).filter((id) => columns.some((c) => c.id === id));
  // No resolvable group column keeps the legacy single-"(none)"-bucket shape.
  const levelIndices = groupIds.length > 0
    ? groupIds.map((id) => columns.findIndex((c) => c.id === id))
    : [-1];
  const sums = sumIndices(columns, grouping.sumColumnIds);

  const nested = buildNestedGroupBuckets(
    rows,
    levelIndices,
    sums,
    (r, idx) => r.values[idx],
    formatCellValue,
    sort,
  );

  // Grand totals from the TOP-LEVEL subtotals only (deeper levels re-split the
  // same rows — adding them too would double-count).
  const totals: Totals = { count: rows.length, sums: Object.fromEntries(sums.map((s) => [s.id, 0])) };
  let groupCount = 0;
  for (const g of nested) {
    if (g.level !== 0) continue;
    groupCount++;
    for (const s of sums) totals.sums[s.id] += g.sums[s.id];
  }

  const items: DisplayItem[] = [];
  const groupKeys: string[] = [];
  const leafLevel = levelIndices.length - 1;
  // Visibility of the currently open branch, per level. Pre-order guarantees a
  // parent is visited before its children, so index level-1 is this group's
  // direct parent.
  const branchOpen: boolean[] = [];
  for (const g of nested) {
    groupKeys.push(g.key);
    const parentVisible = g.level === 0 || branchOpen[g.level - 1] === true;
    if (parentVisible) {
      items.push({ kind: 'group', key: g.key, label: g.label, count: g.count, sums: g.sums, level: g.level });
    }
    const open = parentVisible && expanded.has(g.key);
    branchOpen[g.level] = open;
    if (open && g.level === leafLevel) {
      for (const r of g.rows) items.push({ kind: 'row', row: r });
    }
  }
  return { items, groupCount, totals, groupKeys };
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
