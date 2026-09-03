/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Subtotals for `ifc-lite schedule` (PR-2).
 *
 * `--subtotals <agg>[, ...]` where agg is `count | sum:<Header> | avg:<Header> |
 * min:<Header> | max:<Header>`. Every `<Header>` must be a declared `--columns`
 * header, else a `fatal(...)`. Numeric aggregation reuses the shared
 * `aggregateFinite` from `query-aggregation.ts` (the `Number.isFinite`-guarded
 * reduction behind `query`'s `--sum/--avg/--min/--max`), so an `Infinity` value
 * cannot poison a subtotal and the two commands cannot drift.
 *
 * With `--group-by`, a subtotal row follows each contiguous group and a grand
 * total closes the schedule. Without `--group-by`, only the grand total is
 * emitted (documented in the command help).
 */

import { fatal } from '../output.js';
import { aggregateFinite, type NumericAggMode } from './query-aggregation.js';
import type { ScheduleColumn } from './schedule-columns.js';
import type { ScheduleRow } from './schedule-render.js';
import { cellToNumber, cellCanonicalKey, columnMode, type CellMode, type GroupKey } from './schedule-group.js';

export type SubtotalMode = 'count' | NumericAggMode;

/** One parsed `--subtotals` aggregation. `header`/`index` are null for `count`. */
export interface SubtotalAgg {
  /** Original token, e.g. `count` or `sum:Area` — also the JSON field key. */
  spec: string;
  mode: SubtotalMode;
  header: string | null;
  index: number | null;
}

/** One computed aggregation value on a subtotal/total row. */
export interface SubtotalValue {
  spec: string;
  value: number | null;
}

/** A subtotal (per group) or the grand total row. */
export interface SubtotalRowData {
  kind: 'subtotal' | 'total';
  /** The group key values that identify this group; empty for the grand total. */
  groupValues: Array<{ header: string; index: number; value: unknown }>;
  values: SubtotalValue[];
}

/** The output plan: flat ordered rows, per-group subtotal rows, and a grand total. */
export interface SubtotalPlan {
  rows: ScheduleRow[];
  groups: Array<{ rows: ScheduleRow[]; subtotal: SubtotalRowData }>;
  total: SubtotalRowData;
}

/**
 * Parse `--subtotals "<agg>[, ...]"` into aggregations. A `sum|avg|min|max`
 * token requires a `:<Header>` naming a declared column; `count` takes none.
 */
export function parseSubtotalsSpec(spec: string | undefined, columns: ScheduleColumn[]): SubtotalAgg[] {
  if (spec === undefined || spec.trim() === '') return [];
  const aggs: SubtotalAgg[] = [];
  for (const rawSegment of spec.split(',')) {
    const segment = rawSegment.trim();
    if (segment === '') fatal(`Invalid --subtotals spec: empty entry in "${spec}". Expected "count | sum:Header | avg:Header | min:Header | max:Header".`);

    const colonIdx = segment.indexOf(':');
    const fn = (colonIdx === -1 ? segment : segment.slice(0, colonIdx)).trim().toLowerCase();

    if (fn === 'count') {
      if (colonIdx !== -1) fatal(`Invalid --subtotals entry "${segment}": count takes no :Header.`);
      aggs.push({ spec: 'count', mode: 'count', header: null, index: null });
      continue;
    }

    if (fn !== 'sum' && fn !== 'avg' && fn !== 'min' && fn !== 'max') {
      fatal(`Unknown --subtotals aggregation "${fn}". Valid: count, sum:Header, avg:Header, min:Header, max:Header.`);
    }
    if (colonIdx === -1) fatal(`--subtotals "${fn}" requires a header, e.g. ${fn}:Area.`);
    const header = segment.slice(colonIdx + 1).trim();
    if (header === '') fatal(`--subtotals "${fn}" requires a header, e.g. ${fn}:Area.`);
    const index = columns.findIndex(c => c.header === header);
    if (index === -1) {
      const valid = columns.map(c => c.header).join(', ');
      fatal(`--subtotals header "${header}" is not a declared --columns header. Valid headers: ${valid}`);
    }
    // Canonical spec token (lower-cased fn) so the CSV label and JSON key are stable.
    aggs.push({ spec: `${fn}:${header}`, mode: fn as NumericAggMode, header, index });
  }
  return aggs;
}

/** Compute one row of aggregation values over the given rows. */
function computeValues(rows: ScheduleRow[], aggs: SubtotalAgg[]): SubtotalValue[] {
  return aggs.map(agg => {
    if (agg.mode === 'count') return { spec: agg.spec, value: rows.length };
    const nums: number[] = [];
    for (const row of rows) {
      const n = cellToNumber(row[agg.index!]);
      if (n !== null) nums.push(n);
    }
    return { spec: agg.spec, value: aggregateFinite(nums, agg.mode) };
  });
}

/**
 * True when two rows share every group key value (contiguous-group boundary
 * test). Uses the SAME `cellCanonicalKey`/`columnMode` canonicalisation
 * `orderRows` groups by (`schedule-group.ts`) — a raw `String(value)`
 * comparison here used to disagree with the sorter's numeric/nullish
 * equivalences ('1' vs '1.0', `null` vs a whitespace-only string), splitting
 * one contiguous run the sorter placed together into two separate groups
 * with repeated "Subtotal (...)" headings.
 */
function sameGroup(a: ScheduleRow, b: ScheduleRow, groupKeys: GroupKey[], modeByIndex: Map<number, CellMode>): boolean {
  return groupKeys.every(g => {
    const mode = modeByIndex.get(g.index)!;
    return cellCanonicalKey(a[g.index], mode) === cellCanonicalKey(b[g.index], mode);
  });
}

/**
 * Build the subtotal output plan from ORDERED rows (they must already be sorted
 * so equal group tuples are contiguous — see `orderRows`). With group keys, each
 * contiguous run becomes a group with its own subtotal; the grand total spans
 * all rows in every case.
 */
export function buildSubtotalPlan(rows: ScheduleRow[], groupKeys: GroupKey[], aggs: SubtotalAgg[]): SubtotalPlan {
  const groups: SubtotalPlan['groups'] = [];

  if (groupKeys.length > 0) {
    // Decide each group column's mode once, from the full row set — the same
    // canonicalisation `orderRows` used to make these rows contiguous.
    const modeByIndex = new Map<number, CellMode>(groupKeys.map(g => [g.index, columnMode(rows, g.index)]));
    let start = 0;
    for (let i = 1; i <= rows.length; i++) {
      if (i === rows.length || !sameGroup(rows[start], rows[i], groupKeys, modeByIndex)) {
        const groupRows = rows.slice(start, i);
        const groupValues = groupKeys.map(g => ({ header: g.header, index: g.index, value: groupRows[0][g.index] }));
        groups.push({
          rows: groupRows,
          subtotal: { kind: 'subtotal', groupValues, values: computeValues(groupRows, aggs) },
        });
        start = i;
      }
    }
  }

  const total: SubtotalRowData = { kind: 'total', groupValues: [], values: computeValues(rows, aggs) };
  return { rows, groups, total };
}
