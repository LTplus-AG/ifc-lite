/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CellValue } from '@ifc-lite/lists';
import { displayCell, type ExportModel } from './model';

/** Quality tabular PDF report: title + meta, dark header, grouped sections
 *  (bold group rows carrying per-group count + subtotals), right-aligned
 *  numerics, a grand-total foot, and page numbers. */
export async function toPdf(model: ExportModel): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;

  // Schedule / pivot presentation (issue #1790 round 2): grouping columns
  // become leading columns, one row per group-value tuple, then Count and
  // any configured sums — matching the on-screen schedule view exactly.
  const cols = model.schedule?.columns ?? model.columns;
  const landscape = cols.length > 5;
  const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });

  doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
  doc.text(model.title || 'List', 40, 42);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(130);
  doc.text(`${model.totals.count.toLocaleString()} elements · ${model.generatedAt}`, 40, 58);
  doc.setTextColor(0);

  const head = [cols.map((c) => c.label)];
  const cell = (vals: CellValue[], i: number) => displayCell(vals[i]);
  const body: Array<Array<string | { content: string; styles: Record<string, unknown> }>> = [];

  if (model.schedule) {
    for (const r of model.schedule.rows) body.push(cols.map((_, i) => cell(r, i)));
  } else if (model.groups) {
    // Nested (multi-criteria) grouping: sub-group headers indent one step per
    // level and carry their own count; member rows sit on leaf groups only.
    for (const g of model.groups) {
      body.push(model.columns.map((c, i) => ({
        content: i === 0 ? `${'    '.repeat(g.level)}${g.label}  (${g.count})` : (c.summed ? displayCell(g.sums[c.id]) : ''),
        styles: { fontStyle: 'bold', fillColor: [226, 232, 240] as unknown as number[] },
      })));
      for (const r of g.rows) body.push(model.columns.map((_, i) => cell(r, i)));
    }
  } else {
    for (const r of model.rows) body.push(model.columns.map((_, i) => cell(r, i)));
  }

  const foot = model.sumColumnIds.length > 0
    ? [cols.map((c, i) => {
        if (i === 0) return `Total (${model.totals.count})`;
        if (model.schedule && c.id === '__count') return displayCell(model.totals.count);
        return c.summed ? displayCell(model.totals.sums[c.id]) : '';
      })]
    : undefined;

  const columnStyles: Record<number, { halign: 'right' }> = {};
  cols.forEach((c, i) => { if (c.numeric) columnStyles[i] = { halign: 'right' }; });

  autoTable(doc, {
    head,
    body,
    foot,
    startY: 72,
    margin: { left: 40, right: 40, top: 70, bottom: 40 },
    styles: { fontSize: 8, cellPadding: 3, overflow: 'ellipsize', lineColor: [226, 232, 240], lineWidth: 0.5 },
    headStyles: { fillColor: [51, 65, 85], textColor: 255, fontStyle: 'bold' },
    footStyles: { fillColor: [241, 245, 249], textColor: 20, fontStyle: 'bold' },
    columnStyles,
    didDrawPage: () => {
      doc.setFontSize(8); doc.setTextColor(150);
      const w = doc.internal.pageSize.getWidth();
      const h = doc.internal.pageSize.getHeight();
      doc.text(`Page ${doc.getNumberOfPages()}`, w - 60, h - 20);
      doc.setTextColor(0);
    },
  });

  return doc.output('blob');
}
