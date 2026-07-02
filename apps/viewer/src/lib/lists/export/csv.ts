/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CellValue } from '@ifc-lite/lists';
import { displayCell, type ExportModel } from './model';

function esc(s: string, delim: string): string {
  // Neutralize spreadsheet formula injection (CWE-1236): a leading =, +, -, @,
  // TAB or CR makes a cell execute as a formula in Excel/LibreOffice/Sheets.
  // List cells derive from attacker-controllable IFC values, so prefix such
  // cells with an apostrophe. A leading UTF-8 BOM is treated as file metadata
  // by spreadsheet importers, so a marker hidden behind one still executes.
  if (/^\uFEFF?[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /["\r\n]/.test(s) || s.includes(delim) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV faithful to the configured columns. When grouped, a leading "Group"
 * column preserves the grouping as data (so it stays re-importable), rows are
 * ordered by group, and a TOTAL row carries the grand count + sums.
 */
export function toCsv(model: ExportModel, delimiter = ','): string {
  const grouped = model.groups !== null;
  const header = [...(grouped ? ['Group'] : []), ...model.columns.map((c) => c.label)];
  const lines = [header.map((h) => esc(h, delimiter)).join(delimiter)];

  const line = (groupLabel: string | null, values: CellValue[]) => {
    const cells = grouped ? [esc(groupLabel ?? '', delimiter)] : [];
    for (let i = 0; i < model.columns.length; i++) cells.push(esc(displayCell(values[i]), delimiter));
    return cells.join(delimiter);
  };

  if (grouped && model.groups) {
    for (const g of model.groups) for (const r of g.rows) lines.push(line(g.label, r));
  } else {
    for (const r of model.rows) lines.push(line(null, r));
  }

  if (model.sumColumnIds.length > 0) {
    const totalLabel = `TOTAL (${model.totals.count})`;
    const cells = grouped ? [esc(totalLabel, delimiter)] : [];
    for (let i = 0; i < model.columns.length; i++) {
      const c = model.columns[i];
      if (c.summed) cells.push(esc(displayCell(model.totals.sums[c.id]), delimiter));
      else if (!grouped && i === 0) cells.push(esc(totalLabel, delimiter));
      else cells.push('');
    }
    lines.push(cells.join(delimiter));
  }

  return lines.join('\r\n');
}
