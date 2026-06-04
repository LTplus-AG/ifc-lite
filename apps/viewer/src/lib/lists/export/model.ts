/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Normalised export model shared by the CSV / Excel / PDF writers. Built from
 * the on-screen list view so every export honours the configured columns
 * (order, labels, widths), the active grouping, and the summed columns —
 * grouped sections with per-group count + subtotals, plus grand totals.
 */

import type { CellValue, ColumnDefinition, ListRow, ListGrouping } from '@ifc-lite/lists';

export interface ExportColumn {
  id: string;
  label: string;
  numeric: boolean;
  summed: boolean;
  /** Pixel width from the table (for proportional column sizing in exports). */
  width: number;
}

export interface ExportGroup {
  label: string;
  count: number;
  sums: Record<string, number>;
  rows: CellValue[][];
}

export interface ExportModel {
  title: string;
  generatedAt: string;
  columns: ExportColumn[];
  /** Grouped sections (with member rows), or null when the list isn't grouped. */
  groups: ExportGroup[] | null;
  /** All rows in display order (flat) — used by writers that don't section. */
  rows: CellValue[][];
  groupColumnId: string | null;
  sumColumnIds: string[];
  totals: { count: number; sums: Record<string, number> };
}

export interface BuildModelInput {
  title: string;
  columns: ColumnDefinition[];
  /** Rows already filtered + sorted exactly as shown on screen. */
  rows: ListRow[];
  grouping?: ListGrouping;
  numericCols: boolean[];
  columnWidths: number[];
  generatedAt: string;
}

/** Format a cell for text-based exports (CSV/PDF). Excel keeps raw numbers. */
export function displayCell(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toFixed(4).replace(/\.?0+$/, '');
  }
  return String(value);
}

export function buildExportModel(input: BuildModelInput): ExportModel {
  const { columns, rows, grouping, numericCols, columnWidths, title, generatedAt } = input;
  const sumColumnIds = grouping?.sumColumnIds ?? [];
  const exportCols: ExportColumn[] = columns.map((c, i) => ({
    id: c.id,
    label: c.label ?? c.propertyName,
    numeric: !!numericCols[i],
    summed: sumColumnIds.includes(c.id),
    width: columnWidths[i] ?? 120,
  }));

  const sumIdx = sumColumnIds
    .map((id) => ({ id, idx: columns.findIndex((c) => c.id === id) }))
    .filter((s) => s.idx >= 0);
  const zeroSums = (): Record<string, number> => Object.fromEntries(sumIdx.map((s) => [s.id, 0]));
  const addSums = (acc: Record<string, number>, values: CellValue[]) => {
    for (const s of sumIdx) {
      const v = values[s.idx];
      if (typeof v === 'number' && Number.isFinite(v)) acc[s.id] += v;
    }
  };

  const totals = { count: rows.length, sums: zeroSums() };
  const flatRows: CellValue[][] = [];
  for (const r of rows) { flatRows.push(r.values); addSums(totals.sums, r.values); }

  const groupColumnId = grouping?.columnId && columns.some((c) => c.id === grouping.columnId)
    ? grouping.columnId : null;

  let groups: ExportGroup[] | null = null;
  if (groupColumnId) {
    const groupIdx = columns.findIndex((c) => c.id === groupColumnId);
    const byKey = new Map<string, ExportGroup>();
    for (const r of rows) {
      const raw = r.values[groupIdx];
      const label = raw === null || raw === undefined || raw === '' ? '(none)' : displayCell(raw);
      let g = byKey.get(label);
      if (!g) { g = { label, count: 0, sums: zeroSums(), rows: [] }; byKey.set(label, g); }
      g.count++;
      g.rows.push(r.values);
      addSums(g.sums, r.values);
    }
    groups = Array.from(byKey.values()).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  return { title, generatedAt, columns: exportCols, groups, rows: flatRows, groupColumnId, sumColumnIds, totals };
}
