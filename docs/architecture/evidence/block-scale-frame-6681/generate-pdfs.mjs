/* Generates the evidence PDFs of #6681 through the viewer's own export path in a real Chromium:
 * `prepareDocument` + `exportPreparedDocument` (real jsPDF and svg2pdf), against a running Vite dev server.
 *   EVIDENCE_TAG=main|branch EVIDENCE_OUT=<dir> EVIDENCE_BASE=http://127.0.0.1:5178/ node docs/architecture/evidence/block-scale-frame-6681/generate-pdfs.mjs
 * The 3D snapshot is a stub capture returning a small solid PNG (read from EVIDENCE_PNG); it is placed by the
 * same `addImage(png, 'PNG', x, y, w, h)` call a real capture is, so its box in the PDF is the box the composer chose. */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.EVIDENCE_BASE ?? 'http://127.0.0.1:5178/';
const OUT = process.env.EVIDENCE_OUT ?? '.';
const TAG = process.env.EVIDENCE_TAG ?? 'main';
const PNG_B64 = readFileSync(process.env.EVIDENCE_PNG ?? new URL('./snapshot-stub.png', import.meta.url)).toString('base64');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
await page.goto(BASE);
await page.waitForFunction(() => Boolean(globalThis.__ifc_lite_viewer_store__), null, { timeout: 120000 });

const chart = (id, title) => ({ id, title, source: 'ids', type: 'bar', dimension: 'Specification', measure: { agg: 'count' } });
const docs = {
  'finding1-landscape-snapshot-200': { version: 11, id: 'f1', name: 'Frame evidence', page: { size: 'A4', orientation: 'landscape' },
    blocks: [{ kind: 'chart', id: 'c', chart: chart('k1', 'Findings by specification'), snapshot: true, scale: 2 }] },
  'finding2-two-half-charts-150': { version: 11, id: 'f2', name: 'Pair evidence', page: { size: 'A4', orientation: 'portrait' },
    blocks: [{ kind: 'chart', id: 'a', chart: chart('ka', 'Chart A'), snapshot: false, height: 600, width: 'half', scale: 1.5 },
      { kind: 'chart', id: 'b', chart: chart('kb', 'Chart B'), snapshot: false, height: 600, width: 'half', scale: 1.5 }] },
};

for (const [name, doc] of Object.entries(docs)) {
  const b64 = await page.evaluate(async ({ doc, png }) => {
    const store = globalThis.__ifc_lite_viewer_store__;
    const entity = (i) => ({ modelId: 'm', expressId: i + 1, entityType: 'IfcWall', entityName: `Wall ${i}`, globalId: `g${i}`, passed: i % 3 === 0, requirementResults: [] });
    store.setState({ idsValidationReport: { source: { kind: 'ids' }, timestamp: new Date('2026-10-02T00:00:00Z'), specificationResults: [
      { specification: { id: 's1', name: 'Walls need a fire rating' }, entityResults: Array.from({ length: 8 }, (_, i) => entity(i)) },
      { specification: { id: 's2', name: 'Doors need a width' }, entityResults: Array.from({ length: 5 }, (_, i) => entity(i + 20)) }] } });
    const { prepareDocument } = await import('/src/lib/document/prepare-document.ts');
    const { exportPreparedDocument } = await import('/src/lib/document/export-prepared-document.ts');
    const { browserReportSeams } = await import('/src/lib/export/report/generate-report-pdf.ts');
    const { browserImageSize } = await import('/src/lib/document/generate-document-pdf.ts');
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const input = await prepareDocument(doc, store.getState(), { today: new Date('2026-10-02T00:00:00Z') });
    const seams = { ...await browserReportSeams(async () => bytes), imageSize: browserImageSize };
    const result = await exportPreparedDocument(input, { seams });
    const buffer = new Uint8Array(await result.blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buffer.length; i += 0x8000) bin += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    return btoa(bin);
  }, { doc, png: PNG_B64 });
  writeFileSync(`${OUT}/${name}-${TAG}.pdf`, Buffer.from(b64, 'base64'));
  console.log('wrote', `${OUT}/${name}-${TAG}.pdf`);
}
await browser.close();
if (errors.length) console.log('page errors:', errors);
