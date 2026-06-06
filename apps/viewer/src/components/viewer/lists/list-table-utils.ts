/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure helpers for the Lists results table — value formatting, comparison,
 * numeric-column detection, content-aware column widths, and the grouping /
 * aggregation that powers the in-table (settings-free) grouped view.
 */

import type { CellValue, ColumnDefinition, ListRow, ListGrouping } from '@ifc-lite/lists';

export function formatCellValue(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(4).replace(/\.?0+$/, '');
  }
  return String(value);
}

export function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
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
): GroupedView {
  const groupIdx = columns.findIndex((c) => c.id === grouping.columnId);
  const sums = sumIndices(columns, grouping.sumColumnIds);
  const zero = (): Record<string, number> => Object.fromEntries(sums.map((s) => [s.id, 0]));

  const totals: Totals = { count: rows.length, sums: zero() };
  const byKey = new Map<string, { key: string; label: string; count: number; sums: Record<string, number>; rows: ListRow[] }>();

  for (const row of rows) {
    const raw = groupIdx >= 0 ? row.values[groupIdx] : null;
    const label = raw === null || raw === undefined || raw === '' ? '(none)' : formatCellValue(raw);
    let g = byKey.get(label);
    if (!g) { g = { key: label, label, count: 0, sums: zero(), rows: [] }; byKey.set(label, g); }
    g.count++;
    g.rows.push(row);
    for (const s of sums) {
      const v = row.values[s.idx];
      if (typeof v === 'number' && Number.isFinite(v)) { g.sums[s.id] += v; totals.sums[s.id] += v; }
    }
  }

  const groups = Array.from(byKey.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
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
