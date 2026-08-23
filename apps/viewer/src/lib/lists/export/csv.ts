/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { escapeCsvCell } from '@ifc-lite/export';
import type { CellValue } from '@ifc-lite/lists';
import { displayCell, type ExportColumn, type ExportModel } from './model';

/**
 * CWE-1236 formula guard + RFC 4180 quoting, delegated to `@ifc-lite/export`'s
 * single escaper.
 *
 * `exemptNumbers` is passed EXPLICITLY here, against the shared default, and
 * this is the one writer entitled to do that: it knows each column's type, so
 * it does not have to guess from the text. The shared default has to guess,
 * because most callers hand it a bare string.
 *
 * Guessing gets identifiers wrong. `+41791234567` is an `IfcTelecomAddress`
 * phone number and `-007` is a zero-padded code; both are wholly numeric as
 * TEXT, so a value-shape test exempts them and a spreadsheet then reads the
 * first as 4.1791E+10 with the `+` gone. Passing `false` for text keeps them
 * exactly as written. The numeric path opts back in below, where the value
 * really is a number.
 */
function esc(s: string, delim: string, exemptNumbers = false): string {
  return escapeCsvCell(s, { delimiter: delim, exemptNumbers });
}

/**
 * CSV is machine-readable output, so a numeric column emits the NUMBER, the
 * same contract `xlsx.ts` already keeps (`cellValue`) and the opposite of
 * `pdf.ts`, which is for a human to read.
 *
 * `displayCell` is a DISPLAY formatter: it runs `toLocaleString()` on integers.
 * Routing numbers through it wrote `-1,000` into a CSV under en-US (a quoted
 * string, so the column stops summing) and `-3.000` under de-DE (bare, so a
 * spreadsheet in a `,`-grouping locale reads it back as -3 — a silent 1000x
 * error in a quantity column). Exempting numbers from the formula guard does
 * not fix either one, because neither string is wholly numeric to the guard in
 * the locale that produced it. Not formatting is what fixes it.
 *
 * `String(v)` on a finite number is always accepted by the guard's numeric
 * test (`1e+21` included), so this path is never prefixed either.
 */
function cell(v: CellValue, c: ExportColumn, delim: string): string {
  // TWO decisions, and they are not the same one.
  //
  // Whether to FORMAT is a property of the column: only a numeric column skips
  // the display formatter, because only there is every value a measure.
  //
  // Whether to EXEMPT is a property of the value. A real number is a number
  // wherever it sits, and `detectNumericColumns` marks a whole column as text
  // if even one sampled value is a string -- which mixed IFC properties are,
  // routinely. Gating the exemption on the column re-created #1772 in exactly
  // that case: a summed mixed column exported its grand total as `'-3.35`.
  const isNumber = typeof v === 'number' && Number.isFinite(v);
  // `String(v)` on a finite number is always wholly numeric, `1e+21` included.
  if (c.numeric && isNumber) return esc(String(v), delim, true);
  // A number in a text column still goes through the formatter, so `-3000`
  // becomes `-3,000`, which is not wholly numeric and stays guarded either way.
  // Small values survive it intact and are exempt, as they were before.
  return esc(displayCell(v), delim, isNumber);
}

/**
 * CSV faithful to the configured columns. When grouped, a leading "Group"
 * column preserves the grouping as data (so it stays re-importable), rows are
 * ordered by group, and a TOTAL row carries the grand count + sums. With
 * multi-criteria grouping the Group cell carries the full path ("Building /
 * Storey") so nested grouping survives as flat data.
 *
 * Schedule / pivot presentation (issue #1790 round 2): when `model.schedule`
 * is present the CSV mirrors it INSTEAD — grouping columns first (full,
 * repeated values; no blank-on-repeat, that's on-screen-only sugar), then
 * Count, then any configured sums — one row per group-value tuple, matching
 * Bonsai's own schedule CSV arrangement.
 */
export function toCsv(model: ExportModel, delimiter = ','): string {
  if (model.schedule) {
    const cols = model.schedule.columns;
    const lines = [cols.map((c) => esc(c.label, delimiter)).join(delimiter)];
    for (const row of model.schedule.rows) {
      lines.push(cols.map((c, i) => cell(row[i], c, delimiter)).join(delimiter));
    }
    if (model.sumColumnIds.length > 0) {
      const totalLabel = `TOTAL (${model.totals.count})`;
      lines.push(cols.map((c, i) => {
        if (i === 0) return esc(totalLabel, delimiter);
        if (c.id === '__count') return cell(model.totals.count, c, delimiter);
        if (c.summed) return cell(model.totals.sums[c.id], c, delimiter);
        return '';
      }).join(delimiter));
    }
    return lines.join('\r\n');
  }

  const grouped = model.groups !== null;
  const header = [...(grouped ? ['Group'] : []), ...model.columns.map((c) => c.label)];
  const lines = [header.map((h) => esc(h, delimiter)).join(delimiter)];

  const line = (groupLabel: string | null, values: CellValue[]) => {
    const cells = grouped ? [esc(groupLabel ?? '', delimiter)] : [];
    for (let i = 0; i < model.columns.length; i++) cells.push(cell(values[i], model.columns[i], delimiter));
    return cells.join(delimiter);
  };

  if (grouped && model.groups) {
    // Only leaf groups carry rows; parents are represented via the path.
    for (const g of model.groups) for (const r of g.rows) lines.push(line(g.path.join(' / '), r));
  } else {
    for (const r of model.rows) lines.push(line(null, r));
  }

  if (model.sumColumnIds.length > 0) {
    const totalLabel = `TOTAL (${model.totals.count})`;
    const cells = grouped ? [esc(totalLabel, delimiter)] : [];
    for (let i = 0; i < model.columns.length; i++) {
      const c = model.columns[i];
      if (c.summed) cells.push(cell(model.totals.sums[c.id], c, delimiter));
      else if (!grouped && i === 0) cells.push(esc(totalLabel, delimiter));
      else cells.push('');
    }
    lines.push(cells.join(delimiter));
  }

  return lines.join('\r\n');
}
