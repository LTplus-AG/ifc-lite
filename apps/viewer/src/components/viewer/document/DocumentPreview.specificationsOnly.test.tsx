/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as jspdf from 'jspdf';
import { cleanup, render } from '@/test/render';
import { documentPreviewReady } from '@/test/document-preview';
import { captureTranslation, registerLocale, setLocale } from '@/i18n/registry';
import { DOCUMENT_VERSION, type DocumentSpec, type IdsReportBlock } from '@/lib/document/types';
import { generateDocumentPdf } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { pageBox } from '@/lib/export/report/compose';
import { RING_COLORS } from '@/lib/validation/manual/ring';
import { DocumentPreview } from './DocumentPreview';

// Declared frozen report invariant: two specifications, three requirements.
// The saved snapshot's names/counts stay literal when document chrome translates.
const requirement = (id: string, name: string) => ({ id, name, shortDescription: `${name} must exist`,
  checked: 6, passed: 6, failed: 0, passRate: 100 });
const report: IdsReportBlock = { kind: 'ids-report', id: 'report', variant: 'compact', scale: 1.5,
  sourceName: 'Design IDS', benchmarks: true, generatedAt: '2026-01-15T10:00:00.000Z',
  summary: { checked: 12, passed: 12, failed: 0, passRate: 100 },
  checks: [
    { id: 's1', severity: 'warning', shortDescription: 'Geschoss', checked: 6, passed: 6, failed: 0,
      passRate: 100, rules: [requirement('r1', 'Status'), requirement('r2', 'Material')] },
    { id: 's2', shortDescription: 'Raum', checked: 6, passed: 6, failed: 0,
      passRate: 100, rules: [requirement('r3', 'Raumname')] },
  ],
};

afterEach(() => { cleanup(); setLocale('en'); });

async function printedText(blob: Blob): Promise<Array<{ str: string; size: number }>> {
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const parsed = await task.promise;
    const text: Array<{ str: string; size: number }> = [];
    let paintedRing = false;
    // jsPDF's numeric stroke channels use two decimal places, at most two RGB levels of rounding.
    const passStroke = (color: string): boolean => /^#[0-9a-f]{6}$/i.test(color) && [1, 3, 5].every(offset =>
      Math.abs(parseInt(color.slice(offset, offset + 2), 16) - parseInt(RING_COLORS.pass.slice(offset, offset + 2), 16)) <= 2);
    for (let number = 1; number <= parsed.numPages; number++) {
      const page = await parsed.getPage(number);
      try {
        text.push(...(await page.getTextContent()).items.flatMap(item => 'str' in item ? [{ str: item.str, size: item.transform[0] }] : []));
        const operators = await page.getOperatorList();
        let strokeColor = ''; const savedColors: string[] = [];
        for (let i = 0; i < operators.fnArray.length; i++) {
          const op = operators.fnArray[i], args = operators.argsArray[i];
          if (op === pdf.OPS.save) savedColors.push(strokeColor);
          else if (op === pdf.OPS.restore) strokeColor = savedColors.pop() ?? '';
          else if (op === pdf.OPS.setStrokeRGBColor) strokeColor = args[0];
          else if (op === pdf.OPS.constructPath && args[0] === pdf.OPS.stroke && passStroke(strokeColor)) {
            const bounds = args[2];
            // 44pt ring × 1.5 scale, minus its 8pt stroke: a 58pt circle, unlike the thin compact bars.
            paintedRing ||= bounds != null && Math.abs(bounds[2] - bounds[0] - 58) < 0.01
              && Math.abs(bounds[3] - bounds[1] - 58) < 0.01;
          }
        }
      }
      finally { page.cleanup(); }
    }
    assert.ok(paintedRing, 'actual PDF paints the scaled circular pass ring with its status colour (#6610)');
    return text;
  } finally { await task.destroy(); }
}

it('preserves specifications-only, captured locale and block scale in canonical preview and actual PDF (#6560, #6660)', async () => {
  registerLocale('ids-canonical-union-x', { 'document.preview.idsReportWarningTag': 'Achtung' });
  setLocale('ids-canonical-union-x');
  const labels = captureTranslation();
  const pdfWindow = window as Window & { jspdf?: typeof jspdf };
  const prior = pdfWindow.jspdf; pdfWindow.jspdf = jspdf;
  try {
    const seams = await browserReportSeams(null);
    for (const specificationsOnly of [false, true]) {
      const document: DocumentSpec = { version: DOCUMENT_VERSION, id: `specifications-${specificationsOnly}`, name: 'Design review',
        page: { size: 'A4', orientation: 'portrait' }, blocks: [{ ...report, specificationsOnly }] };
      const input = { document, labels, bindings: { models: [], activeModelId: null, today: new Date('2026-10-02T12:00:00Z') },
        aggregations: new Map(), chartMessages: new Map(), topics: new Map(), tables: new Map(), snapshotIds: () => [] };
      const ui = render(<DocumentPreview {...input} selectedBlockId={null} onSelectBlock={() => {}} />);
      await documentPreviewReady();
      const glyphs = Array.from(ui.querySelectorAll('[data-preview-block="report"] span'), node => node.textContent?.trim() ?? '');
      assert.ok(ui.querySelector('[data-validation-benchmark] img'), 'the actual composed benchmark ring remains visible');
      const pdf = await generateDocumentPdf(input, seams);
      const printed = await printedText(pdf.blob);
      for (const items of [glyphs, printed.map(item => item.str)]) {
        assert.ok(items.includes('(Achtung) Geschoss'), 'the warning is localized before measurement');
        assert.ok(items.includes('Raum'), 'the second specification remains literal');
        for (const name of ['Status', 'Material', 'Raumname']) {
          assert.equal(items.includes(name), !specificationsOnly, `${name}: requirement visibility follows the saved choice`);
        }
      }
      const warning = Array.from(ui.querySelectorAll<HTMLElement>('[data-preview-block="report"] span'))
        .find(node => node.textContent?.trim() === '(Achtung) Geschoss');
      assert.ok(warning);
      const printedWarning = printed.find(item => item.str === '(Achtung) Geschoss');
      assert.ok(printedWarning);
      assert.ok(Math.abs(printedWarning.size - 13.5) < 0.01, 'the actual PDF preserves the saved 1.5 type factor');
      assert.ok(Math.abs(parseFloat(warning.style.fontSize) - printedWarning.size * 560 / pageBox(document.page).w) < 0.01,
        'the composed preview uses the same scaled type size');
      cleanup();
    }
  } finally { pdfWindow.jspdf = prior; }
});
