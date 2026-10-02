/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* Generates the evidence PDFs of the block heading follow-ups through the viewer's own export path in a
 * real Chromium: `prepareDocument` + `exportPreparedDocument` (real jsPDF and svg2pdf, real Helvetica
 * metrics), against a running Vite dev server.
 *   EVIDENCE_TAG=main|branch EVIDENCE_OUT=<dir> EVIDENCE_BASE=http://127.0.0.1:5178/ node docs/architecture/evidence/block-heading-follow-ups/generate-pdfs.mjs
 * Two documents: a BCF topic with no authored title at heading size 24 on a yellow strip, and a half-width
 * chart beside a half-width text block, both at heading size 18 on a yellow strip. */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.EVIDENCE_BASE ?? 'http://127.0.0.1:5178/';
const OUT = process.env.EVIDENCE_OUT ?? '.';
const TAG = process.env.EVIDENCE_TAG ?? 'main';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
await page.goto(BASE);
await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 120000 });

const STRIP = { titleBackgroundColor: '#ffff00' };
const chart = (id, title) => ({ id, title, source: 'ids', type: 'bar', dimension: 'Specification', measure: { agg: 'count' } });
const docs = {
  'f1-topic-fallback-title': { version: 11, id: 'f1', name: 'Topic evidence', page: { size: 'A4', orientation: 'portrait' },
    blocks: [{ kind: 'topic', id: 't', guid: 'topic-1', snapshot: false, titleFontSize: 24, ...STRIP },
      { kind: 'text', id: 'after', style: 'body', text: 'Text after the topic block.' }] },
  'f3-chart-beside-text': { version: 11, id: 'f3', name: 'Row evidence', page: { size: 'A4', orientation: 'portrait' },
    blocks: [{ kind: 'chart', id: 'c', chart: chart('k1', 'Findings by specification'), snapshot: false, height: 160, width: 'half', title: 'Findings by specification', titleFontSize: 18, ...STRIP },
      { kind: 'text', id: 'n', style: 'body', text: 'Notes beside the chart.', width: 'half', title: 'Notes on the findings', titleFontSize: 18, ...STRIP }] },
};

for (const [name, doc] of Object.entries(docs)) {
  const b64 = await page.evaluate(async ({ doc }) => {
    const store = globalThis.__ifc_lite_viewer_store__;
    const entity = (i) => ({ modelId: 'm', expressId: i + 1, entityType: 'IfcWall', entityName: `Wall ${i}`, globalId: `g${i}`, passed: i % 3 === 0, requirementResults: [] });
    store.setState({
      idsValidationReport: { source: { kind: 'ids' }, timestamp: new Date('2026-10-02T00:00:00Z'), specificationResults: [
        { specification: { id: 's1', name: 'Walls need a fire rating' }, entityResults: Array.from({ length: 8 }, (_, i) => entity(i)) },
        { specification: { id: 's2', name: 'Doors need a width' }, entityResults: Array.from({ length: 5 }, (_, i) => entity(i + 20)) }] },
      bcfProject: { version: '3.0', name: 'p', topics: new Map([['topic-1', { guid: 'topic-1', title: 'Fire door in corridor 2.14 is missing its closer and label', description: 'Coordinate with the door supplier.', topicStatus: 'Open', viewpoints: [], comments: [] }]]) },
    });
    const { prepareDocument } = await import('/src/lib/document/prepare-document.ts');
    const { exportPreparedDocument } = await import('/src/lib/document/export-prepared-document.ts');
    const { browserReportSeams } = await import('/src/lib/export/report/generate-report-pdf.ts');
    const { browserImageSize } = await import('/src/lib/document/generate-document-pdf.ts');
    const input = await prepareDocument(doc, store.getState(), { today: new Date('2026-10-02T00:00:00Z') });
    const seams = { ...await browserReportSeams(async () => new Uint8Array()), imageSize: browserImageSize };
    const result = await exportPreparedDocument(input, { seams });
    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buffer.length; i += 0x8000) bin += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    return btoa(bin);
  }, { doc });
  writeFileSync(`${OUT}/${name}-${TAG}.pdf`, Buffer.from(b64, 'base64'));
  console.log('wrote', `${OUT}/${name}-${TAG}.pdf`);
}
await browser.close();
if (errors.length) console.log('page errors:', errors);
