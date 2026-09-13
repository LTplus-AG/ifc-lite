/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough of the Document panel (#4594) against a dev
// server: open it from the ribbon, check the seeded title resolves, insert a
// field, add a chart and a logo, switch presets, export the PDF and the
// template file, re-import the template. Screenshots + findings.txt under
// WALKTHROUGH_OUT (default <tmp>/ifc-lite-document-walkthrough). Run, with
// `pnpm exec vite --port 5199` up in apps/viewer:
//   node tests/e2e/document-walkthrough.manual.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-document-walkthrough');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5199';
const log = (...a) => console.log('[walk]', ...a);
const findings = [];
const note = (s) => { findings.push(s); log('FINDING:', s); };

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
let step = 0;
const shot = async (name) => { step += 1; const p = `${OUT}/${String(step).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: p }); log('shot', p); };
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });
const setValue = (locator, value) => locator.evaluate((el, v) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

await page.goto(`${BASE}/?model=/samples/building-architecture.ifc`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 120000 });
await page.waitForTimeout(3000);

// Open from the ribbon.
await page.getByRole('tab', { name: /analy/i }).first().click();
await page.getByRole('button', { name: /^Document/ }).first().click();
await page.waitForSelector('[data-document-panel]', { timeout: 15000 });
await page.waitForTimeout(1200);
await shot('document-panel-open');
log('documents', await state('s.documents.map(d => d.name)'));
const title = await page.locator('[data-preview-block] [data-block-text]').first().textContent();
log('seeded title resolves to', JSON.stringify(title));
if (!title || title.includes('[')) note(`seeded title did not resolve: ${title}`);

// Insert a field into the body block and type around it.
const body = page.locator('[data-block-editor]').nth(1);
await body.locator('select[aria-label="Insert field"]').selectOption('Count[IfcWall]');
await page.waitForTimeout(300);
const textarea = body.locator('textarea');
await setValue(textarea, 'Walls: {Count[IfcWall]} · Storeys: {Count[IfcBuildingStorey]} · Roof: {IfcBuildingStorey["Roof"].Name}');
await page.waitForTimeout(800);
const bodyPreview = await page.locator('[data-preview-block] [data-block-text]').nth(1).textContent();
log('body preview', JSON.stringify(bodyPreview));
if (!/Walls: \d+/.test(bodyPreview ?? '')) note('the inserted field did not resolve in the preview');
if (!(await page.locator('[data-unresolved]').count())) note('the unresolved binding is not marked in the preview');
await shot('field-inserted');

// Storeys and the selected element are offered by the picker.
const options = await body.locator('select[aria-label="Insert field"] option').allTextContents();
log('picker options', options.length, options.filter((o) => /Storey|Selected/.test(o)).slice(0, 6));
const someIds = await state('Array.from(s.geometryResult.meshes.slice(0, 1).map(m => m.expressId))');
await page.evaluate(({ k, ids }) => globalThis[k].getState().setSelectedEntityIds(ids), { k: STORE, ids: someIds });
await page.waitForTimeout(600);
const withSel = await body.locator('select[aria-label="Insert field"] option').allTextContents();
log('with a selection', withSel.filter((o) => /Selected/.test(o)).length, withSel.filter((o) => /Selected/.test(o)).slice(0, 10));
if (!withSel.some((o) => /Selected element/.test(o))) note('the selected element is not offered as a field');
await body.locator('select[aria-label="Insert field"]').selectOption({ label: 'Selected element · Name' });
await page.waitForTimeout(600);
log('body preview with element', JSON.stringify(await page.locator('[data-preview-block] [data-block-text]').nth(1).textContent()));
await shot('selected-element-field');

// Add a chart block and a logo.
await page.getByRole('button', { name: /Add block/ }).click();
await page.getByRole('menuitem', { name: 'Chart' }).click();
await page.waitForTimeout(1200);
log('chart svg in preview', await page.locator('[data-chart-svg] svg').count());
if (!(await page.locator('[data-chart-svg] svg').count())) note('the chart block has no SVG in the preview');
await page.getByRole('button', { name: /Add block/ }).click();
await page.getByRole('menuitem', { name: /Image/ }).click();
await page.waitForTimeout(400);
// A logo drawn in the page (a real PNG, 200×80).
const pngDataUrl = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 80; const g = c.getContext('2d'); g.fillStyle = '#0063B1'; g.fillRect(0, 0, 200, 80); g.fillStyle = '#fff'; g.font = 'bold 32px sans-serif'; g.fillText('LOGO', 50, 52); return c.toDataURL('image/png'); });
const png = Buffer.from(pngDataUrl.split(',')[1], 'base64');
await page.locator('[data-image-input]').last().setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
await page.waitForTimeout(800);
log('blocks', await state('s.documents.find(d => d.id === s.activeDocumentId).blocks.map(b => b.kind)'));
await shot('chart-and-logo');

// Export PDF.
const [pdf] = await Promise.all([
  page.waitForEvent('download', { timeout: 90000 }),
  page.locator('[data-document-export]').click(),
]);
const pdfPath = `${OUT}/${pdf.suggestedFilename()}`;
await pdf.saveAs(pdfPath);
log('pdf saved', pdfPath);
await page.waitForTimeout(800);
await shot('after-export');
log('camera restored? ghost', await state('s.ghostExceptEntities'));

// Preset: Cover sheet; export the template; re-import it.
await page.locator('select[aria-label="Document"]').selectOption('preset:Cover sheet');
await page.waitForTimeout(1200);
await shot('cover-sheet-preset');
log('cover sheet texts', (await page.locator('[data-preview-block] [data-block-text]').allTextContents()).slice(0, 4));
const [file] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  (async () => { await page.getByRole('button', { name: 'Document actions' }).click(); await page.getByRole('menuitem', { name: /Export template/ }).click(); })(),
]);
const templatePath = `${OUT}/${file.suggestedFilename()}`;
await file.saveAs(templatePath);
log('template saved', templatePath);
await page.locator('[data-document-import]').setInputFiles(templatePath);
await page.waitForTimeout(1000);
log('documents after import', await state('s.documents.map(d => d.name)'));
if ((await state('s.documents.length')) !== 3) note('the imported template did not add a document');
await shot('template-imported');

// Landscape A3.
await page.locator('select[aria-label="Page size"]').selectOption('A3');
await page.locator('select[aria-label="Orientation"]').selectOption('landscape');
await page.waitForTimeout(600);
await shot('a3-landscape');

writeFileSync(`${OUT}/findings.txt`, [...findings, '', 'page errors:', ...errors].join('\n'));
log('page errors', errors.length, errors.slice(0, 10));
log('findings', findings);
await browser.close();
