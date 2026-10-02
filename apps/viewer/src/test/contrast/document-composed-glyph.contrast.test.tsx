/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { after, afterEach, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { jsPDF } from 'jspdf';
import { DocumentPreview } from '@/components/viewer/document/DocumentPreview';
import { DOCUMENT_VERSION, type DocumentSpec } from '@/lib/document/types';
import { browserImageSize, generateDocumentPdf } from '@/lib/document/generate-document-pdf';
import { browserReportSeams } from '@/lib/export/report/generate-report-pdf';
import { render, cleanup, waitFor } from '@/test/render';
import { closeContrastBrowser, warmContrastBrowser, withThemedPage } from './render-harness';
import { assertRenderedTextClears, snapshotRenderedDom, THEMES } from './rendered-text-contrast';
import { WCAG_AA_NORMAL_TEXT } from './wcag';

before(warmContrastBrowser, { timeout: 300_000 });
after(closeContrastBrowser);
afterEach(cleanup);

const bindings = { models: [], activeModelId: null, today: new Date('2026-10-02T12:00:00Z') };
const chartMessages = new Map([['chart', 'Recorded comparison unavailable']]);
const counts = { total: 1, pass: 0, fail: 0, warning: 0, unanswered: 1 };
const sampleDocument: DocumentSpec = {
  version: DOCUMENT_VERSION, id: 'completed-contrast', name: 'Default paper heading',
  page: { size: 'A4', orientation: 'portrait' },
  // A stated document invariant, rather than fabricated validation output:
  // the author recorded one unanswered manual check and its own guidance.
  blocks: [
    { kind: 'text', id: 'body', style: 'body', text: 'Ordinary body ink' },
    { kind: 'text', id: 'caption', style: 'caption', text: 'Default caption ink' },
    { kind: 'text', id: 'authored', style: 'caption', text: 'Authored pale ink', textColor: '#969696' },
    { kind: 'manual-report', id: 'manual', checklistName: 'Recorded inspection', generatedAt: '2026-10-02T12:00:00Z',
      modelName: 'Recorded building', benchmarks: false, summary: counts,
      groups: [{ id: 'group', name: 'Recorded checks', counts, items: [{ id: 'check', text: 'Inspect the wall',
        status: null, description: 'Recorded check guidance', comment: 'Reviewer comment ink' }] }] },
    { kind: 'chart', id: 'chart', chart: { id: 'chart-source', title: 'Empty chart', source: 'elements',
      type: 'bar', dimension: 'IfcType', measure: { agg: 'count' } }, snapshot: false, height: 120 },
  ],
};

async function completed(spec = sampleDocument): Promise<string> {
  const ui = render(<DocumentPreview document={spec} bindings={bindings} aggregations={new Map()}
    chartMessages={chartMessages} topics={new Map()} selectedBlockId={null} onSelectBlock={() => {}} />);
  await waitFor(() => ui.querySelector('[data-preview-section]') !== null, 'completed compositor glyphs are mounted');
  assert.equal(ui.querySelectorAll('[data-preview-section]').length, 1);
  assert.equal(ui.querySelector('[aria-busy="true"]'), null, 'do not measure the pending SSR placeholder');
  return snapshotRenderedDom();
}

const defaultGlyphs = ['Default paper heading', 'Default caption ink', 'Recorded check guidance',
  'NOT CHECKED', /Model: Recorded building.*Recorded:/, /^Generated /, 'Page 1 / 1', 'Recorded comparison unavailable'];

for (const theme of THEMES) {
  it(`completed document metadata, caption, chart refusal and frame clear AA in ${theme} (#6610)`, async () => {
    await assertRenderedTextClears(theme, await completed(), defaultGlyphs, WCAG_AA_NORMAL_TEXT);
  });

  it(`authored pale colors remain literal while existing dark body/comment ink stays intact in ${theme} (#6610)`, async () => {
    const html = await completed({ ...sampleDocument, pageHeading: { text: 'Authored pale heading', textColor: '#969696' } });
    await assertRenderedTextClears(theme, html, ['Ordinary body ink', /Reviewer comment ink/], WCAG_AA_NORMAL_TEXT);
    await withThemedPage(theme, html, async page => {
      const paints = await page.evaluate(() => {
        const text = ['Authored pale ink', 'Authored pale heading', 'Ordinary body ink'];
        return text.map(value => {
          const element = [...document.body.querySelectorAll('*')].find(el => [...el.childNodes]
            .filter(node => node.nodeType === 3).map(node => node.textContent ?? '').join('').trim() === value);
          if (!element) throw new Error(`Missing actual glyph: ${value}`);
          return getComputedStyle(element).color;
        });
      });
      assert.deepEqual(paints, ['rgb(150, 150, 150)', 'rgb(150, 150, 150)', 'rgb(0, 0, 0)']);
    });
  });
}

async function printed(spec: DocumentSpec) {
  // svg2pdf's Node UMD looks up its real jsPDF dependency on window; no
  // generated PDF, SVG, text measurements or paint operators are replaced.
  const pdfWindow = window as Window & { jspdf?: { jsPDF: typeof jsPDF } };
  const prior = pdfWindow.jspdf;
  pdfWindow.jspdf = { jsPDF };
  let result: Awaited<ReturnType<typeof generateDocumentPdf>>;
  try {
    result = await generateDocumentPdf({ document: spec, bindings, aggregations: new Map(), chartMessages,
      topics: new Map(), tables: new Map(), snapshotIds: () => [] },
    { ...await browserReportSeams(null), imageSize: browserImageSize, now: () => bindings.today });
  } finally { pdfWindow.jspdf = prior; }
  const pdf = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const require = createRequire(import.meta.url);
  const task = pdf.getDocument({ data: new Uint8Array(await result.blob.arrayBuffer()), stopAtErrors: true,
    standardFontDataUrl: `${join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/` });
  try {
    const parsed = await task.promise;
    assert.equal(parsed.numPages, 1);
    assert.equal(result.pages, parsed.numPages);
    const page = await parsed.getPage(1);
    try {
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      const fills = operators.fnArray.flatMap((op, index) => op === pdf.OPS.setFillRGBColor
        ? [operators.argsArray[index]] : []);
      return { content, fills, height: page.view[3] - page.view[1] };
    } finally { page.cleanup(); }
  } finally { await task.destroy(); }
}

it('preview accessibility paint preserves actual PDF gray ink, standard-font size and glyph geometry (#6610)', async () => {
  const html = await completed();
  const actual = await printed(sampleDocument);
  // PDF.js exposes the actual fill operators, independently of the preview.
  for (const gray of [130, 150]) {
    const hex = `#${gray.toString(16).repeat(3)}`;
    assert.ok(actual.fills.some(args => args[0] === hex || (args[0] === gray && args[1] === gray && args[2] === gray)),
      `PDF keeps its existing gray ${gray}: ${JSON.stringify(actual.fills)}`);
  }
  await withThemedPage('light', html, async page => {
    const glyphs = await page.evaluate(() => {
      const paper = document.querySelector('[data-preview-section]');
      if (!paper) throw new Error('Missing completed paper');
      const bounds = paper.getBoundingClientRect();
      return ['Default caption ink', 'Ordinary body ink', 'Authored pale ink', 'Default paper heading', 'Page 1 / 1'].map(text => {
        const element = [...paper.querySelectorAll('*')].find(el => [...el.childNodes]
          .filter(node => node.nodeType === 3).map(node => node.textContent ?? '').join('').trim() === text);
        if (!element) throw new Error(`Missing actual glyph: ${text}`);
        const rect = element.getBoundingClientRect();
        return { text, x: rect.left - bounds.left, top: rect.top - bounds.top,
          size: Number.parseFloat(getComputedStyle(element).fontSize), paperHeight: bounds.height };
      });
    });
    for (const glyph of glyphs) {
      const item = actual.content.items.find(candidate => 'str' in candidate && candidate.str === glyph.text);
      assert.ok(item && 'str' in item, `Actual PDF contains ${glyph.text}`);
      const scale = glyph.paperHeight / actual.height;
      assert.ok(Math.abs(glyph.size - item.transform[0] * scale) < 0.02, 'font size stays shared with PDF');
      assert.ok(Math.abs(glyph.x - item.transform[4] * scale) < 0.02, 'horizontal placement stays shared with PDF');
      assert.ok(Math.abs(glyph.top + glyph.size - (actual.height - item.transform[5]) * scale) < 0.02,
        'baseline placement stays shared with PDF');
    }
  });
});

it('authored heading color/font survives actual PDF export instead of becoming accessibility ink (#6610)', async () => {
  const actual = await printed({ ...sampleDocument, pageHeading: { text: 'Authored purple heading', font: 'times', fontSize: 24, textColor: '#6b21a8' } });
  const heading = actual.content.items.find(item => 'str' in item && item.str === 'Authored purple heading');
  assert.ok(heading && 'str' in heading);
  assert.equal(heading.transform[0], 24);
  assert.equal(actual.content.styles[heading.fontName].fontFamily, 'serif');
  assert.ok(actual.fills.some(args => args[0] === '#6b21a8' || (args[0] === 107 && args[1] === 33 && args[2] === 168)),
    'real PDF operators preserve authored purple');
});
