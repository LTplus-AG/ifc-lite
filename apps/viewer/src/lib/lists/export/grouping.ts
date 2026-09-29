/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical grouped/schedule projection of already converted list rows. */
import type { CellValue } from '@ifc-lite/lists';
import { buildNestedGroupBuckets, type GroupSort, type GroupOrder } from '../group-sort';
import type { ExportColumn, ExportGroup, ExportModel } from './model';

export interface GroupedExportInput {
  columns: ExportColumn[];
  rows: CellValue[][];
  groupColumnIds: string[];
  sumColumnIds: string[];
  formatLabel: (cell: CellValue) => string;
  sort: GroupSort;
  scheduleView: boolean;
  groupOrder?: GroupOrder;
}

export function buildGroupedExport({ columns, rows, groupColumnIds, sumColumnIds, formatLabel, sort, scheduleView, groupOrder }: GroupedExportInput): Pick<ExportModel, 'groups' | 'schedule'> {
  const sumIdx = sumColumnIds.map((id) => ({ id, idx: columns.findIndex((c) => c.id === id) })).filter((s) => s.idx >= 0);
  let groups: ExportGroup[] | null = null;
  let schedule: ExportModel['schedule'] = null;
  if (groupColumnIds.length > 0) {
    const levelIndices = groupColumnIds.map((id) => columns.findIndex((c) => c.id === id));
    const leafLevel = levelIndices.length - 1;
    // Bucket + subtotal via the shared helper so the sections match the table
    // exactly (multi-criteria grouping nests one section level per group
    // column), then project each LEAF group's member rows to display values.
    const nested = buildNestedGroupBuckets(
      rows,
      levelIndices,
      sumIdx,
      (r, idx) => r[idx],
      formatLabel,
      sort,
      groupOrder,
    );
    groups = nested.map((g) => ({
      label: g.label,
      count: g.count,
      sums: g.sums,
      level: g.level,
      path: g.path,
      rows: g.level === leafLevel ? g.rows : [],
    }));

    // Schedule / pivot presentation (issue #1790 round 2): one row per
    // group-value tuple (leaf group), grouping columns first, then a
    // first-class Count column, then the configured sums — the same leaf
    // buckets, just flattened into a single tuple row instead of a section.
    if (scheduleView) {
      const scheduleCols: ExportColumn[] = [
        ...groupColumnIds.map((id) => {
          const i = columns.findIndex((c) => c.id === id);
          // `numeric` is INHERITED from the source column, not hard-coded false.
          // In this presentation the grouping value is a data cell -- it is the
          // only place the value appears -- so a numeric grouping column has to
          // reach the writers as numeric or they format it for a human.
          return {
            id,
            label: columns[i]?.label ?? id,
            numeric: columns[i]?.numeric ?? false,
            summed: false,
            width: columns[i]?.width ?? 120,
          };
        }),
        { id: '__count', label: 'Count', numeric: true, summed: false, width: 80 },
        ...sumIdx.map((s) => columns[s.idx]),
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
          const first = g.rows[0]?.[idx] ?? null;
          // An empty grouping cell is bucketed under the literal label
          // `(none)`, and `-1` above means "no column at this level" -- the
          // same bucket. Writing a blank instead would be indistinguishable
          // from a missing value.
          if (first === null || first === undefined || first === '') return label;
          // `buildGroupBuckets` keys buckets by the FORMATTED label, so two
          // distinct raw values that format alike land in ONE bucket (12.345671
          // and 12.345679 both render "12.3457"). Emitting row 0's value would
          // assert a number only one member actually has.
          if (g.rows.some((r) => r[idx] !== first)) return label;
          return first;
        });
      const scheduleRows: CellValue[][] = nested
        .filter((g) => g.level === leafLevel)
        .map((g) => [...rawGroupValues(g), g.count, ...sumIdx.map((s) => g.sums[s.id])]);
      schedule = { columns: scheduleCols, rows: scheduleRows };
    }
  }

  return { groups, schedule };
}
