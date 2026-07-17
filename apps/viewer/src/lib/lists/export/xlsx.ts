/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CellValue } from '@ifc-lite/lists';
import { displayCell, neutralizeSpreadsheetFormula, type ExportModel, type ExportColumn } from './model';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const NUM_FMT = '#,##0.####';

/** px → Excel column-width units (≈ 7px per char). */
const excelWidth = (px: number): number => Math.max(8, Math.min(80, Math.round(px / 7)));

/** Excel keeps real numbers (so the recipient can re-aggregate); other types
 *  fall back to the same display string the table shows. */
function cellValue(v: CellValue, c: ExportColumn): string | number | null {
  if (v === null || v === undefined) return null;
  if (c.numeric && typeof v === 'number' && Number.isFinite(v)) return v;
  // String cells derive from attacker-controllable IFC values — neutralize
  // spreadsheet formula injection before Excel treats a leading =/+/-/@ as one.
  return neutralizeSpreadsheetFormula(displayCell(v));
}

export async function toXlsx(model: ExportModel): Promise<Blob> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IFC-Lite';
  const ws = wb.addWorksheet((model.title || 'List').slice(0, 31), {
    views: [{ state: 'frozen', ySplit: 4 }],
  });

  const cols = model.columns;
  const ncol = cols.length;

  // Title + meta.
  ws.addRow([model.title || 'List']);
  ws.mergeCells(1, 1, 1, ncol);
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.addRow([`${model.totals.count.toLocaleString()} elements · ${model.generatedAt}`]);
  ws.mergeCells(2, 1, 2, ncol);
  ws.getCell(2, 1).font = { italic: true, size: 9, color: { argb: 'FF94A3B8' } };
  ws.addRow([]);

  // Header. Column labels can be user-authored (custom pset/regex columns), so
  // they pass through the same formula-injection guard.
  const header = ws.addRow(cols.map((c) => neutralizeSpreadsheetFormula(c.label)));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF334155' } };
    cell.alignment = { vertical: 'middle' };
  });

  // Column widths + numeric formatting/alignment.
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = excelWidth(c.width);
    if (c.numeric) { col.numFmt = NUM_FMT; col.alignment = { horizontal: 'right' }; }
  });

  const addDataRow = (values: CellValue[], outline?: number) => {
    const r = ws.addRow(cols.map((c, i) => cellValue(values[i], c)));
    if (outline) r.outlineLevel = outline;
  };

  if (model.groups) {
    // Nested (multi-criteria) grouping: sub-group headers indent one step per
    // level and carry their own count; member rows sit on leaf groups only.
    // Outline levels are clamped to Excel's maximum of 8.
    const MAX_OUTLINE = 8;
    for (const g of model.groups) {
      const gr = ws.addRow(cols.map((c, i) => (i === 0 ? `${'  '.repeat(g.level)}${neutralizeSpreadsheetFormula(g.label)} (${g.count})` : (c.summed ? g.sums[c.id] : null))));
      gr.font = { bold: true };
      gr.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } }; });
      if (g.level > 0) gr.outlineLevel = Math.min(g.level, MAX_OUTLINE);
      for (const row of g.rows) addDataRow(row, Math.min(g.level + 1, MAX_OUTLINE));
    }
    ws.properties.outlineLevelRow = Math.min(model.groups.reduce((m, g) => Math.max(m, g.level + 1), 1), MAX_OUTLINE);
  } else {
    for (const row of model.rows) addDataRow(row);
  }

  // Grand total.
  if (model.sumColumnIds.length > 0) {
    const tr = ws.addRow(cols.map((c, i) => (c.summed ? model.totals.sums[c.id] : (i === 0 ? `Total (${model.totals.count})` : null))));
    tr.font = { bold: true };
    tr.eachCell((cell) => { cell.border = { top: { style: 'double', color: { argb: 'FF334155' } } }; });
  }

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: XLSX_MIME });
}
