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

/**
 * Rebuild a `ListGrouping` after changing the group-by columns and/or sum
 * columns from the results table (a grouping-bar chip's "x", or a column
 * header menu's "Group by" / "Sum" toggle). SPREADS the previous grouping
 * first, then overrides only the fields this rebuild actually changes
 * (`columnId`, `columnIds`, `sumColumnIds`) — so a field neither caller
 * knows about (e.g. `view`, issue #1790 round 2) survives instead of being
 * silently dropped back to its default. Returns `undefined` when there is
 * nothing left to track (no group columns AND no sum columns), matching the
 * existing "clear grouping entirely" behaviour.
 */
export function rebuildGrouping(
  previous: ListGrouping | undefined,
  columnIds: string[],
  sumColumnIds: string[],
): ListGrouping | undefined {
  if (columnIds.length === 0 && sumColumnIds.length === 0) return undefined;
  return { ...previous, columnId: columnIds[0] ?? '', columnIds, sumColumnIds };
}

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

/** One row of the `schedule` / pivot presentation (issue #1790 round 2) — a
 *  single group-value tuple (a leaf group combination) with its Count and
 *  configured sums, display-unit-converted like the rest of the on-screen
 *  table. Unlike `DisplayItem`'s `group` kind, there is no tree here: every
 *  row IS a leaf, one per distinct combination of group-by values. */
export interface ScheduleRow {
  /** Collision-free key — `groupPathKey(path)`. */
  key: string;
  /** Group-by values, outermost first — one per active grouping level. */
  path: string[];
  count: number;
  sums: Record<string, number>;
}

/**
 * Bonsai-style pivot/schedule table (issue #1790 round 2): the grouping
 * criteria become leading columns and each row is one group-value tuple
 * (Building | Storey | Type | Count | Sum(...)), instead of per-element rows
 * nested under collapsible group headers. Reuses `buildNestedGroupBuckets` —
 * the SAME bucket-building `buildGroupedView` uses — so the schedule can
 * never disagree with the nested view on which rows land in which group or
 * how groups are ordered; this just keeps the leaf buckets and drops the
 * parent levels (pre-order flattening already keeps a parent's leaves
 * contiguous, so no re-sorting is needed here).
 */
export function buildScheduleRows(
  rows: ListRow[],
  columns: ColumnDefinition[],
  grouping: ListGrouping,
  sort: GroupSort = null,
): ScheduleRow[] {
  const groupIds = groupingColumnIds(grouping).filter((id) => columns.some((c) => c.id === id));
  if (groupIds.length === 0) return [];
  const levelIndices = groupIds.map((id) => columns.findIndex((c) => c.id === id));
  const sums = sumIndices(columns, grouping.sumColumnIds);
  const nested = buildNestedGroupBuckets(rows, levelIndices, sums, (r, idx) => r.values[idx], formatCellValue, sort);
  const leafLevel = levelIndices.length - 1;
  return nested
    .filter((g) => g.level === leafLevel)
    .map((g) => ({ key: g.key, path: g.path, count: g.count, sums: g.sums }));
}

/**
 * Blank out a schedule row's leading group-value cells where they repeat the
 * row above (Bonsai-style: "P01 / Wall / 12" then "· / Door / 4" — the
 * building doesn't repeat once shown). Purely a display convenience for the
 * on-screen table: only a value whose ENTIRE prefix up to and including this
 * level matches the previous row is blanked, so a change at an outer level
 * always re-shows every level nested inside it. CSV/XLSX/PDF exports keep
 * the full repeated values (machine-friendly, matches Bonsai's own CSV).
 */
export function blankRepeatedPathValues(rows: { path: string[] }[]): string[][] {
  const out: string[][] = [];
  let prev: string[] | null = null;
  for (const r of rows) {
    const display: string[] = new Array(r.path.length);
    let matched = true;
    for (let j = 0; j < r.path.length; j++) {
      matched = matched && prev !== null && prev[j] === r.path[j];
      display[j] = matched ? '' : r.path[j];
    }
    out.push(display);
    prev = r.path;
  }
  return out;
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
