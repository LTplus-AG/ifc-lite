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
import type { ProjectUnits } from '@ifc-lite/parser';
import { buildGroupBuckets, orderGroups, type GroupSort } from '@/lib/lists/group-sort';
import { resolveMeasureDisplay, resolveQuantityDisplay } from '@/lib/units/display';

export interface ExportColumn {
  id: string;
  label: string;
  numeric: boolean;
  summed: boolean;
  /** Pixel width from the table (for proportional column sizing in exports). */
  width: number;
  /** Resolved display unit symbol for this column — the file's declared/
   *  default unit, or the user's display-unit override (issue #1573).
   *  Undefined for non-measure columns, or when the model was built without
   *  `projectUnits`. Already folded into `label` (`"NetVolume (m³/h)"`) so
   *  writers don't need to special-case it; kept here too for callers that
   *  want the symbol on its own. */
  unit?: string;
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
  /** Active header sort, so grouped sections export in the on-screen order. */
  sort?: GroupSort;
  numericCols: boolean[];
  columnWidths: number[];
  generatedAt: string;
  /**
   * The file's declared units (issue #1573) — when provided alongside
   * `unitDisplayOverrides`, quantity columns (`ColumnDefinition.quantityType`)
   * and measure property columns (`ColumnDefinition.dataType`, both populated
   * by `executeList`) export CONVERTED into the overridden unit, with the
   * resolved symbol folded into the column label. Omitted keeps the legacy
   * raw-value, no-unit export.
   */
  projectUnits?: ProjectUnits;
  /** Per-unit-type display-unit overrides — see `unitDisplayOverrides` in the
   *  viewer store's `unitDisplaySlice`. `{}` (or omitted) exports every
   *  measure column in the file's declared unit (still labelled), with no
   *  values converted. */
  unitDisplayOverrides?: Record<string, string>;
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
  const { columns, rows, grouping, sort, numericCols, columnWidths, title, generatedAt, projectUnits, unitDisplayOverrides } = input;
  const sumColumnIds = grouping?.sumColumnIds ?? [];
  const exportCols: ExportColumn[] = columns.map((c, i) => ({
    id: c.id,
    label: c.label ?? c.propertyName,
    numeric: !!numericCols[i],
    summed: sumColumnIds.includes(c.id),
    width: columnWidths[i] ?? 120,
  }));

  // Display-unit conversion (issue #1573): quantity/property measure columns
  // export CONVERTED into the overridden unit, same math as the Properties
  // panel (`resolveQuantityDisplay`/`resolveMeasureDisplay`), with the
  // resolved symbol folded into the column label. A NEW row-values array is
  // built rather than mutating `rows[i].values` in place — those arrays are
  // the live on-screen `ListRow`s (shared with sort/group/colour-by), so
  // converting for export must never leak back into them.
  const convertibleCols = projectUnits && unitDisplayOverrides
    ? columns.map((c, i) => ({ c, i })).filter(({ c }) => c.quantityType !== undefined || !!c.dataType)
    : [];

  const resolveDisplay = (c: ColumnDefinition, value: CellValue) =>
    c.quantityType !== undefined
      ? resolveQuantityDisplay(typeof value === 'number' ? value : NaN, c.quantityType, projectUnits!, unitDisplayOverrides!)
      : resolveMeasureDisplay(value, c.dataType, projectUnits!, unitDisplayOverrides!);

  // Resolve each convertible column's label from a REPRESENTATIVE row (the
  // first with a finite numeric value), not just `rows[0]`: an override only
  // reports its symbol once it sees a convertible value (see
  // `resolveQuantityDisplay`'s contract), so seeding from a row that happens
  // to be null/non-numeric would freeze the header on the file's default
  // unit while the actual (later) rows convert correctly underneath it —
  // a header/value mismatch. Falls back to a non-finite probe (still labels
  // with the file default) only when no row has data for that column at all.
  for (const { c, i } of convertibleCols) {
    const seed = rows.find((r) => typeof r.values[i] === 'number' && Number.isFinite(r.values[i] as number));
    const disp = resolveDisplay(c, seed ? seed.values[i] : null);
    if (disp.unit) {
      exportCols[i].unit = disp.unit;
      exportCols[i].label = `${exportCols[i].label} (${disp.unit})`;
    }
  }

  const convertRowValues = (values: CellValue[]): CellValue[] => {
    if (convertibleCols.length === 0) return values;
    const next = values.slice();
    for (const { c, i } of convertibleCols) {
      const disp = resolveDisplay(c, next[i]);
      if (disp.converted !== null) next[i] = disp.converted;
    }
    return next;
  };

  const convertedRows: ListRow[] = convertibleCols.length > 0
    ? rows.map((r) => ({ ...r, values: convertRowValues(r.values) }))
    : rows;

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

  const totals = { count: convertedRows.length, sums: zeroSums() };
  const flatRows: CellValue[][] = [];
  for (const r of convertedRows) { flatRows.push(r.values); addSums(totals.sums, r.values); }

  const groupColumnId = grouping?.columnId && columns.some((c) => c.id === grouping.columnId)
    ? grouping.columnId : null;

  let groups: ExportGroup[] | null = null;
  if (groupColumnId) {
    const groupIdx = columns.findIndex((c) => c.id === groupColumnId);
    // Bucket + subtotal via the shared helper so the sections match the table
    // exactly, then order and project each member row to its display values.
    const byKey = buildGroupBuckets(
      convertedRows,
      (r) => r.values[groupIdx],
      sumIdx,
      (r, idx) => r.values[idx],
      displayCell,
    );
    groups = orderGroups(Array.from(byKey.values()), sort ?? null, groupIdx, sumIdx)
      .map((g) => ({ label: g.label, count: g.count, sums: g.sums, rows: g.rows.map((r) => r.values) }));
  }

  return { title, generatedAt, columns: exportCols, groups, rows: flatRows, groupColumnId, sumColumnIds, totals };
}
