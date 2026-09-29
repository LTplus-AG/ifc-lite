/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Normalised export model shared by the CSV / Excel / PDF writers. Built from
 * the on-screen list view so every export honours the configured columns
 * (order, labels, widths), the active grouping, and the summed columns —
 * grouped sections with per-group count + subtotals, plus grand totals.
 */

import { guardSpreadsheetFormula } from '@ifc-lite/export';
import { groupingColumnIds, type CellValue, type ColumnDefinition, type ListRow, type ListGrouping } from '@ifc-lite/lists';
import type { ProjectUnits } from '@ifc-lite/parser';
import type { GroupSort, GroupOrder } from '@/lib/lists/group-sort';
import { buildGroupedExport } from './grouping';
import { resolveListColumnUnits } from '@/lib/units/list-column-units';

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
   *  `modelUnits`. Already folded into `label` (`"NetVolume (m³/h)"`) so
   *  writers don't need to special-case it; kept here too for callers that
   *  want the symbol on its own. */
  unit?: string;
}

export interface ExportGroup {
  label: string;
  /** Member-row count of this group (the Count aggregate, issue #1790). */
  count: number;
  sums: Record<string, number>;
  /** Member rows. With multi-criteria grouping only LEAF groups carry rows
   *  (parents would duplicate them); parent groups export with `rows: []`. */
  rows: CellValue[][];
  /** 0-based nesting depth (0 = outermost grouping column). */
  level: number;
  /** Group labels from the outermost level down to this group. */
  path: string[];
}

export interface ExportModel {
  title: string;
  generatedAt: string;
  columns: ExportColumn[];
  /** Grouped sections in pre-order (parent group immediately followed by its
   *  subgroups), or null when the list isn't grouped. */
  groups: ExportGroup[] | null;
  /** All rows in display order (flat) — used by writers that don't section. */
  rows: CellValue[][];
  groupColumnId: string | null;
  /** Ordered group-by column ids, outermost first (multi-criteria #1790). */
  groupColumnIds: string[];
  sumColumnIds: string[];
  totals: { count: number; sums: Record<string, number> };
  /**
   * Present when the grouping's presentation is `schedule` (issue #1790
   * round 2): a Bonsai-style pivot table — one row per group-value tuple
   * (leaf group), grouping columns first, then a first-class `Count` column,
   * then any configured sums. Every writer renders THIS instead of
   * `groups`/`rows` when it is present, so the export always mirrors exactly
   * what the on-screen schedule view shows. Cell values already carry the
   * FULL (repeated) group-value tuple — no blank-on-repeat here, that's
   * on-screen-only sugar; a re-importable CSV/XLSX needs every row complete.
   */
  schedule: { columns: ExportColumn[]; rows: CellValue[][] } | null;
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
   * Per-model declared units (issue #1573 follow-up), keyed by the same
   * `modelId` every `ListRow` carries — when provided alongside
   * `unitDisplayOverrides`, quantity columns (`ColumnDefinition.quantityType`)
   * and measure property columns (`ColumnDefinition.dataType`, both populated
   * by `executeList`) export CONVERTED into ONE resolved target unit (see
   * `resolveListColumnUnits`), with the resolved symbol folded into the
   * column label. Omitted (or empty) keeps the legacy raw-value, no-unit
   * export. This is the SAME resolver the on-screen table
   * (`ListResultsTable`) uses, so the two can never disagree.
   */
  modelUnits?: Map<string, ProjectUnits>;
  /** Per-unit-type display-unit overrides — see `unitDisplayOverrides` in the
   *  viewer store's `unitDisplaySlice`. `{}` (or omitted) exports every
   *  measure column in the file's declared (first-contributing model's) unit
   *  (still labelled), with no values converted. */
  unitDisplayOverrides?: Record<string, string>;
}

/** A group header's first cell: the label indented one step per nesting level, with the member count. */
export function groupHeaderLabel(group: Pick<ExportGroup, 'label' | 'count' | 'level'>, indent = '    '): string {
  return `${indent.repeat(group.level)}${group.label}  (${group.count})`;
}

/**
 * The grand-total row over `cols` as raw cells: `label` first, the schedule
 * view's Count under `__count`, each summed column's total, `null` elsewhere.
 * Writers format (`displayCell`) or keep the numbers (Excel) as they do rows.
 */
export function totalsRowCells(model: ExportModel, cols: ExportColumn[], label: string): CellValue[] {
  return cols.map((c, i) => {
    if (i === 0) return label;
    if (model.schedule && c.id === '__count') return model.totals.count;
    return c.summed ? model.totals.sums[c.id] : null;
  });
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

/**
 * Neutralize spreadsheet formula injection (CWE-1236): a leading =, +, -, @,
 * TAB or CR makes a cell execute as a formula in Excel/LibreOffice/Sheets.
 * List-export cells (values, group labels, custom column headers) derive from
 * attacker-controllable IFC values, so any such cell is prefixed with an
 * apostrophe.
 *
 * The trigger is looked for PAST any leading invisibles (BOM, ZWSP, LRM, NBSP,
 * U+2028/U+2029, ordinary spaces): spreadsheet importers swallow those, so a
 * marker hidden behind one still executes, while an anchored regex stops
 * matching. They are looked past, not removed — see `guardSpreadsheetFormula`.
 *
 * Used by the XLSX writer for its string cells. The CSV writer calls
 * `escapeCsvCell` directly instead, because it also needs RFC 4180 quoting;
 * both reach the same guard in `@ifc-lite/export`.
 */
export function neutralizeSpreadsheetFormula(s: string): string {
  // Delegates to `@ifc-lite/export`'s single guard. The copy that used to live
  // here bought its invisible-handling by DELETING the leading run of
  // `\p{Cf}\p{Z}`; `\p{Z}` includes U+0020, so every exported cell silently
  // lost its leading spaces, against RFC 4180 §2.4 ("Spaces are considered
  // part of a field and should not be ignored"). The shared guard looks *past*
  // the run instead of removing it — same payloads guarded, data intact.
  //
  // No options: the numeric exemption is the shared guard's DEFAULT, which is
  // how the repo stopped disagreeing with itself. `packages/lists/src/engine.ts`
  // has exempted genuine numbers since #1772 ("`-0.35` exported as `'-0.35` and
  // broke Excel SUM()"); this call site guarded them, so the same list exported
  // from the viewer and from the library did not match.

  return guardSpreadsheetFormula(s);
}

export function buildExportModel(input: BuildModelInput): ExportModel {
  const { columns, rows, grouping, sort, numericCols, columnWidths, title, generatedAt, modelUnits, unitDisplayOverrides } = input;
  const sumColumnIds = grouping?.sumColumnIds ?? [];
  const exportCols: ExportColumn[] = columns.map((c, i) => ({
    id: c.id,
    label: c.label ?? c.propertyName,
    numeric: !!numericCols[i],
    summed: sumColumnIds.includes(c.id),
    width: columnWidths[i] ?? 120,
  }));

  // Display-unit conversion (issue #1573 follow-up): quantity/property
  // measure columns export CONVERTED into ONE resolved target unit via the
  // resolver shared with the on-screen table (`ListResultsTable`), with the
  // resolved symbol folded into the column label. A NEW row-values array is
  // built rather than mutating `rows[i].values` in place — those arrays are
  // the live on-screen `ListRow`s (shared with sort/group/colour-by), so
  // converting for export must never leak back into them.
  const resolver = modelUnits && modelUnits.size > 0 && unitDisplayOverrides
    ? resolveListColumnUnits(columns, modelUnits, unitDisplayOverrides)
    : null;

  if (resolver) {
    columns.forEach((_, i) => {
      const unit = resolver.unitSymbol(i);
      if (unit) {
        exportCols[i].unit = unit;
        exportCols[i].label = `${exportCols[i].label} (${unit})`;
      }
    });
  }

  const convertedRows: ListRow[] = resolver
    ? rows.map((r) => ({ ...r, values: r.values.map((v, i) => resolver.convertCell(i, v, r.modelId)) }))
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

  const groupColumnIds = groupingColumnIds(grouping).filter((id) => columns.some((c) => c.id === id));
  const groupColumnId = groupColumnIds[0] ?? null;

  const { groups, schedule } = buildGroupedExport({ columns: exportCols, rows: flatRows, groupColumnIds, sumColumnIds, formatLabel: displayCell, sort: sort ?? null, scheduleView: grouping?.view === 'schedule' });

  return { title, generatedAt, columns: exportCols, groups, rows: flatRows, groupColumnId, groupColumnIds, sumColumnIds, totals, schedule };
}

/** Document-only group ordering (#6489), using cached converted rows without rerunning IFC evaluation. */
export function orderExportModelGroups(model: ExportModel, order?: GroupOrder): ExportModel {
  if (!order || !model.groups) return model;
  const grouped = buildGroupedExport({ columns: model.columns, rows: model.rows, groupColumnIds: model.groupColumnIds, sumColumnIds: model.sumColumnIds, formatLabel: displayCell, sort: null, scheduleView: model.schedule !== null, groupOrder: order });
  return { ...model, ...grouped };
}
