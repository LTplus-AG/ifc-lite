/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure, framework-agnostic sorting for the Lists feature — the cell
 * comparator plus the group-header ordering. Lives in `lib/` so both the
 * table component and the export model can share one implementation (and stay
 * in agreement) without a component → lib layer inversion.
 */

import { groupPathKey, type CellValue } from '@ifc-lite/lists';

/** Null-first, numbers-numeric, everything-else locale-compared. */
export function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Active header sort — a column index into the result columns and a
 *  direction. `null` means no explicit sort (grouped view falls back to its
 *  count-descending default). */
export type GroupSort = { colIdx: number; dir: 'asc' | 'desc' } | null;

/** Minimal shape `orderGroups` needs — the group header's raw value (for the
 *  group-by column), row count, and per-column subtotals. */
export interface OrderableGroup { label: string; raw: CellValue; count: number; sums: Record<string, number> }

/** A bucketed group plus the member rows that fed it (row type is the
 *  caller's — `ListRow` for the table, `ListRow` projected to values by the
 *  export). */
export type GroupBucket<R> = OrderableGroup & { key: string; rows: R[] };

/** Bucket rows by a group cell, deriving `(none)` / raw / label and the
 *  per-group subtotals identically for every caller, so the table view and the
 *  export can never diverge on grouping (the divergence that caused #1498). The
 *  returned Map keeps first-seen insertion order; callers apply their own
 *  ordering with `orderGroups`. */
export function buildGroupBuckets<R>(
  rows: R[],
  getGroupCell: (row: R) => CellValue,
  sums: { id: string; idx: number }[],
  getSumValue: (row: R, idx: number) => CellValue,
  formatLabel: (cell: CellValue) => string,
): Map<string, GroupBucket<R>> {
  const zero = (): Record<string, number> => Object.fromEntries(sums.map((s) => [s.id, 0]));
  const byKey = new Map<string, GroupBucket<R>>();
  for (const row of rows) {
    const cell = getGroupCell(row);
    const isNone = cell === null || cell === undefined || cell === '';
    const raw: CellValue = isNone ? null : cell;
    const label = isNone ? '(none)' : formatLabel(cell);
    let g = byKey.get(label);
    if (!g) { g = { key: label, label, raw, count: 0, sums: zero(), rows: [] }; byKey.set(label, g); }
    g.count++;
    g.rows.push(row);
    for (const s of sums) {
      const v = getSumValue(row, s.idx);
      if (typeof v === 'number' && Number.isFinite(v)) g.sums[s.id] += v;
    }
  }
  return byKey;
}

/** A group in a multi-criteria (nested) grouping — one bucket per group-by
 *  value at one nesting `level`, keyed by the full `path` so the same label
 *  under two different parents stays two distinct groups. */
export type NestedGroupBucket<R> = GroupBucket<R> & {
  /** 0-based nesting depth (0 = outermost grouping column). */
  level: number;
  /** Group labels from the outermost level down to this group. The bucket's
   *  `key` is `groupPathKey(path)` — a collision-free JSON encoding, matching
   *  the engine's `ListGroup.key`. */
  path: string[];
};

/**
 * Bucket rows by SEVERAL group columns (multi-criteria grouping, issue #1790)
 * into a FLAT pre-order list: each parent group immediately followed by its
 * subgroups. Every group carries its own count and per-column subtotals.
 * Groups within a level are ordered by `orderGroups` (header sort, or the
 * count-descending default). Shared by the table view and the export model so
 * the two can never diverge on grouping.
 */
export function buildNestedGroupBuckets<R>(
  rows: R[],
  /** Column index per grouping level, outermost first (-1 buckets under "(none)"). */
  levelIndices: number[],
  sums: { id: string; idx: number }[],
  getCell: (row: R, idx: number) => CellValue,
  formatLabel: (cell: CellValue) => string,
  sort: GroupSort,
): NestedGroupBucket<R>[] {
  const out: NestedGroupBucket<R>[] = [];
  const walk = (subRows: R[], level: number, parentPath: string[]) => {
    const colIdx = levelIndices[level];
    const byKey = buildGroupBuckets(
      subRows,
      (r) => (colIdx >= 0 ? getCell(r, colIdx) : null),
      sums,
      getCell,
      formatLabel,
    );
    const ordered = orderGroups(Array.from(byKey.values()), sort, colIdx, sums);
    for (const g of ordered) {
      const path = [...parentPath, g.label];
      out.push({ ...g, key: groupPathKey(path), level, path });
      if (level + 1 < levelIndices.length) walk(g.rows, level + 1, path);
    }
  };
  if (levelIndices.length > 0) walk(rows, 0, []);
  return out;
}

/** Order the group headers to match the active header sort so that toggling
 *  a column's sort actually reorders the groups (not just the rows inside
 *  them). The group header only carries a value for the group-by column and
 *  the summed columns, so those drive the order; anything else (or no sort)
 *  falls back to the count-descending default. The label tie-breaker rides
 *  the same direction as the primary key, so ties stay consistent with the
 *  arrow. */
export function orderGroups<T extends OrderableGroup>(
  groups: T[],
  sort: GroupSort,
  groupIdx: number,
  sums: { id: string; idx: number }[],
): T[] {
  const byCount = (a: T, b: T) => b.count - a.count || a.label.localeCompare(b.label);
  if (!sort) return groups.sort(byCount);

  const dir = sort.dir === 'desc' ? -1 : 1;
  if (sort.colIdx === groupIdx) {
    return groups.sort((a, b) => (compareCells(a.raw, b.raw) || a.label.localeCompare(b.label)) * dir);
  }
  const summed = sums.find((s) => s.idx === sort.colIdx);
  if (summed) {
    return groups.sort((a, b) => ((a.sums[summed.id] - b.sums[summed.id]) || a.label.localeCompare(b.label)) * dir);
  }
  // A non-group, non-summed column has no group-level value to order by.
  return groups.sort(byCount);
}
