/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Text that reaches the PDF writers' standard fonts (WinAnsi). jsPDF encodes a
 * string holding any code point above U+00FF as two bytes per character, so
 * ONE `ș` turns the whole string (ASCII included) into NUL-interleaved bytes.
 * These tests drive the exported writers and read the text operators back.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jsPDF } from 'jspdf';
import type { ColumnDefinition, ListRow } from '@ifc-lite/lists';
import type { DxfUnderlayRenderData } from '@/hooks/useDxfUnderlay.js';
import { drawElementTagsPdf } from '@/lib/drawing/element-tag-export';
import { buildExportModel } from '@/lib/lists/export/model';
import { createListArtifact } from '@/lib/lists/export';
import { drawDxfUnderlaysPdf } from './drawing-vector-underlays.js';
import { browserReportSeams } from './report/generate-report-pdf.js';

const ROOM = 'Sală de ședințe – Etaj 2, 25 m²';
// ă ș ț are outside WinAnsi, so they keep their base letter; the en dash and m² are WinAnsi and stay.
// jsPDF writes the WinAnsi byte for the en dash (0x96) and m² (0xB2) as one raw character each.
const PRINTED = 'Sala de sedinte \x96 Etaj 2, 25 m²';

/** The string operands of every Tj in a PDF's raw text, as jsPDF wrote them. */
function shown(raw: string): string[] {
  return [...raw.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => m[1]);
}
/** What a viewer would show: the operand with its escapes undone. */
function printed(operand: string): string {
  return operand.replace(/\\(.)/g, '$1');
}
function assertPrinted(raw: string, expected: string): void {
  const found = shown(raw).map(printed);
  assert.ok(found.includes(expected), `expected a Tj of ${JSON.stringify(expected)}, got ${JSON.stringify(found)}`);
  assert.ok(!raw.includes('\u0000'), 'no NUL-interleaved (two-byte) text in the page');
}

describe('PDF text with characters outside WinAnsi', () => {
  it('element tags (space names) print readable text', () => {
    const doc = new jsPDF();
    drawElementTagsPdf(doc, [{ position: { x: 1, y: 1 }, text: ROOM } as never], (x, y) => ({ x, y }));
    assertPrinted(doc.output(), PRINTED);
  });

  it('DXF underlay text prints readable text', () => {
    const doc = new jsPDF({ unit: 'mm', format: [100, 100] });
    const data: DxfUnderlayRenderData[] = [{ id: 'dxf', opacity: 1, lines: [], fills: [], texts: [{
      x: 2, y: 3, dirX: 1, dirY: 0, height: 0.5, text: ROOM, color: '#000000', align: 'left', valign: 'baseline' }] }];
    drawDxfUnderlaysPdf(doc, data, (x, y) => ({ x: 50 + x * 10, y: 50 - y * 10 }), 10);
    const raw = doc.output();
    assert.ok(shown(raw).map(printed).includes(PRINTED), JSON.stringify(shown(raw)));
    assert.ok(!raw.includes('\u0000'));
  });

  it('list (schedule) PDF prints title, headers and cells readable', async () => {
    const columns: ColumnDefinition[] = [{ id: 'name', source: 'attribute', propertyName: 'Nume' }];
    const rows: ListRow[] = [{ entityId: 1, modelId: 'm', values: [ROOM] }];
    const model = buildExportModel({ title: 'Săli și birouri', columns, rows, numericCols: [false], columnWidths: [120], generatedAt: 'now' });
    const { blob } = await createListArtifact('pdf', model);
    const raw = Buffer.from(await blob.arrayBuffer()).toString('latin1');
    const found = shown(raw).map(printed);
    assert.ok(found.includes(PRINTED), JSON.stringify(found));
    assert.ok(found.includes('Sali si birouri'), JSON.stringify(found));
    assert.ok(!raw.includes('\u0000'));
  });

  it('report PDF text and tables print readable text', async () => {
    // The seam builds a DOMParser eagerly; no chart SVG is drawn here, so a bare stand-in will do.
    (globalThis as { DOMParser?: unknown }).DOMParser ??= class {};
    const doc = await (await browserReportSeams(null)).createDoc('a4', 'portrait');
    doc.text(ROOM, 40, 40);
    doc.table({ startY: 60, margin: { left: 40, right: 40 }, head: [['Etaj', 'Număr']], body: [[ROOM, '3']] });
    const raw = Buffer.from(await doc.output().arrayBuffer()).toString('latin1');
    const found = shown(raw).map(printed);
    assert.ok(found.includes(PRINTED), JSON.stringify(found));
    assert.ok(found.includes('Numar'), JSON.stringify(found));
    assert.ok(!raw.includes('\u0000'));
  });

  it('control: WinAnsi-only text is untouched', () => {
    const doc = new jsPDF();
    drawElementTagsPdf(doc, [{ position: { x: 1, y: 1 }, text: 'Büro Größe 25 m²' } as never], (x, y) => ({ x, y }));
    assertPrinted(doc.output(), 'Büro Größe 25 m²');
  });
});
