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
import { buildNestedGroupBuckets, type GroupSort } from '@/lib/lists/group-sort';
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

  let groups: ExportGroup[] | null = null;
  let schedule: ExportModel['schedule'] = null;
  if (groupColumnIds.length > 0) {
    const levelIndices = groupColumnIds.map((id) => columns.findIndex((c) => c.id === id));
    const leafLevel = levelIndices.length - 1;
    // Bucket + subtotal via the shared helper so the sections match the table
    // exactly (multi-criteria grouping nests one section level per group
    // column), then project each LEAF group's member rows to display values.
    const nested = buildNestedGroupBuckets(
      convertedRows,
      levelIndices,
      sumIdx,
      (r, idx) => r.values[idx],
      displayCell,
      sort ?? null,
    );
    groups = nested.map((g) => ({
      label: g.label,
      count: g.count,
      sums: g.sums,
      level: g.level,
      path: g.path,
      rows: g.level === leafLevel ? g.rows.map((r) => r.values) : [],
    }));

    // Schedule / pivot presentation (issue #1790 round 2): one row per
    // group-value tuple (leaf group), grouping columns first, then a
    // first-class Count column, then the configured sums — the same leaf
    // buckets, just flattened into a single tuple row instead of a section.
    if (grouping?.view === 'schedule') {
      const scheduleCols: ExportColumn[] = [
        ...groupColumnIds.map((id) => {
          const i = columns.findIndex((c) => c.id === id);
          // `numeric` is INHERITED from the source column, not hard-coded false.
          // In this presentation the grouping value is a data cell -- it is the
          // only place the value appears -- so a numeric grouping column has to
          // reach the writers as numeric or they format it for a human.
          return {
            id,
            label: exportCols[i]?.label ?? id,
            numeric: exportCols[i]?.numeric ?? false,
            summed: false,
            width: exportCols[i]?.width ?? 120,
          };
        }),
        { id: '__count', label: 'Count', numeric: true, summed: false, width: 80 },
        ...sumIdx.map((s) => exportCols[s.idx]),
      ];
      // RAW group values, not `g.path`. `path` is built by the shared bucketing
      // helper from `displayCell`, so it is already locale-formatted text by the
      // time it gets here: grouping by a quantity wrote `"'-3,000"` as the sole
      // rendering of -3000, and under a `.`-grouping locale a bare `-3.000` that
      // a `,`-grouping spreadsheet reads back as -3. Every row in a leaf group
      // shares the grouping cell by construction, so the first row carries it.
      const rawGroupValues = (g: (typeof nested)[number]): CellValue[] =>
        levelIndices.map((idx, level) => {
          // The bucket's LABEL is true of every member by construction; a raw
          // value is only true of the members that share it. Prefer the raw
          // value, fall back to the label whenever it would not be.
          const label = g.path[level] ?? null;
          if (idx < 0) return label;
          const first = g.rows[0]?.values[idx] ?? null;
          // An empty grouping cell is bucketed under the literal label
          // `(none)`, and `-1` above means "no column at this level" -- the
          // same bucket. Writing a blank instead would be indistinguishable
          // from a missing value.
          if (first === null || first === undefined || first === '') return label;
          // `buildGroupBuckets` keys buckets by the FORMATTED label, so two
          // distinct raw values that format alike land in ONE bucket (12.345671
          // and 12.345679 both render "12.3457"). Emitting row 0's value would
          // assert a number only one member actually has.
          if (g.rows.some((r) => r.values[idx] !== first)) return label;
          return first;
        });
      const scheduleRows: CellValue[][] = nested
        .filter((g) => g.level === leafLevel)
        .map((g) => [...rawGroupValues(g), g.count, ...sumIdx.map((s) => g.sums[s.id])]);
      schedule = { columns: scheduleCols, rows: scheduleRows };
    }
  }

  return { title, generatedAt, columns: exportCols, groups, rows: flatRows, groupColumnId, groupColumnIds, sumColumnIds, totals, schedule };
}
