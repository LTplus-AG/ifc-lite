/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough of the Document panel's table block (#5142)
// against a dev server: open the panel, add a table (a copy of the Wall
// Schedule preset), check the preview shows the rows, replace it with the
// Door Schedule preset, set a caption and a row cap, export the PDF, export
// and re-import the template. Screenshots + findings.txt under
// WALKTHROUGH_OUT (default <tmp>/ifc-lite-document-table-walkthrough).
// Run, with `pnpm exec vite --port 5288 --strictPort` up in apps/viewer:
//   WALKTHROUGH_BASE=http://localhost:5288 node tests/e2e/document-table-walkthrough.manual.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-document-table-walkthrough');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5288';
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

await page.getByRole('tab', { name: /analy/i }).first().click();
await page.getByRole('button', { name: /^Document/ }).first().click();
await page.waitForSelector('[data-document-panel]', { timeout: 15000 });
await page.waitForTimeout(1000);

// Add a table block: a copy of the first preset (no saved lists yet).
await page.getByRole('button', { name: /Add block/ }).click();
await page.getByRole('menuitem', { name: /Table/ }).click();
await page.waitForTimeout(300);
log('block kinds', await state('s.documents.find(d => d.id === s.activeDocumentId).blocks.map(b => b.kind)'));
const block = await state('s.documents.find(d => d.id === s.activeDocumentId).blocks.find(b => b.kind === "table")');
log('table block', JSON.stringify({ list: block?.source.list.name, from: block?.source.fromListId, cols: block?.source.list.columns.length, snapshot: 'expressIdsByModel' in (block?.source.list ?? {}) }));
if (block?.source.list.name !== 'Wall Schedule') note(`expected the Wall Schedule preset, got ${block?.source.list.name}`);
await page.waitForSelector('[data-block-table] table', { timeout: 20000 });
await page.waitForTimeout(500);
const head = await page.locator('[data-block-table] th').allTextContents();
const rowCount = await page.locator('[data-block-table] tbody tr[data-role="row"]').count();
const firstRow = await page.locator('[data-block-table] tbody tr[data-role="row"]').first().locator('td').allTextContents();
log('preview head', head);
log('preview rows', rowCount, 'first', firstRow);
if (rowCount === 0) note('the wall schedule table has no rows in the preview');
if (!head.some((h) => /\(m|\(mm/.test(h))) note(`no unit in any column label: ${head.join(', ')}`);
await shot('table-wall-schedule');

// Caption, and cap to 2 rows: the "… n more rows" line appears.
const editor = page.locator('[data-table-block-editor]');
await setValue(editor.locator('input[aria-label="Table caption"]'), 'Walls, first two');
const rows = editor.locator('input[aria-label^="Rows to print"]');
await rows.fill('2');
await rows.press('Enter');
await page.waitForSelector('[data-block-table] tr[data-role="more"]', { timeout: 20000 }).catch(() => note('no "… n more rows" line after capping at 2'));
await page.waitForTimeout(500);
const moreText = await page.locator('[data-block-table] tr[data-role="more"] td').first().textContent().catch(() => null);
log('capped rows', await page.locator('[data-block-table] tbody tr[data-role="row"]').count(), 'more', moreText);
log('summary', await editor.locator('[data-table-summary]').textContent());
await shot('table-wall-schedule-capped');

// Replace with the Door Schedule preset: the sample has no doors, so the block says so instead of printing an empty grid.
const replace = editor.locator('select[aria-label="List this table prints"]');
const optionValues = await replace.locator('option').evaluateAll((os) => os.map((o) => [o.value, o.textContent]));
log('replace options', optionValues.map(([v]) => v));
const door = optionValues.find(([, label]) => /Door/.test(label ?? ''));
if (!door) note('no Door Schedule preset offered');
else await replace.selectOption(door[0]);
await page.waitForTimeout(1500);
const doorMessage = await page.locator('[data-block-table] [data-table-message]').first().textContent().catch(() => null);
log('door schedule message', doorMessage);
if (!doorMessage) note('the door schedule (no doors in the sample) shows neither rows nor a message');
await shot('table-door-schedule-empty');
// Back to the walls for the export.
const wall = optionValues.find(([v, label]) => v && /^Wall Schedule$/.test(label ?? ''));
await replace.selectOption(wall[0]);
await page.waitForSelector('[data-block-table] table', { timeout: 20000 });

// Export PDF (the button must be enabled: nothing is resolving).
const exportBtn = page.locator('[data-document-export]');
log('export enabled', await exportBtn.isEnabled(), await exportBtn.textContent());
const [pdf] = await Promise.all([
  page.waitForEvent('download', { timeout: 90000 }),
  exportBtn.click(),
]);
const pdfPath = `${OUT}/${pdf.suggestedFilename()}`;
await pdf.saveAs(pdfPath);
log('pdf saved', pdfPath);
await page.waitForTimeout(800);
await shot('after-export');

// Template round trip keeps the embedded list.
const [file] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  (async () => { await page.getByRole('button', { name: 'Document actions' }).click(); await page.getByRole('menuitem', { name: /Export template/ }).click(); })(),
]);
const templatePath = `${OUT}/${file.suggestedFilename()}`;
await file.saveAs(templatePath);
await page.locator('[data-document-import]').setInputFiles(templatePath);
await page.waitForTimeout(1500);
const imported = await state('s.documents[s.documents.length - 1].blocks.filter(b => b.kind === "table").map(b => ({ list: b.source.list.name, id: b.source.list.id, max: b.maxRows, caption: b.caption }))');
log('imported tables', JSON.stringify(imported));
if (imported.length !== 1 || imported[0].max !== 2) note(`template round trip lost the table block: ${JSON.stringify(imported)}`);
await page.waitForSelector('[data-block-table] table', { timeout: 20000 });
await shot('template-reimported');

// Edit in Lists hands the copy to the Lists panel.
await editor.locator('[data-table-edit-in-lists]').first().click();
await page.waitForTimeout(1000);
log('list panel visible', await state('s.listPanelVisible'), 'draft', await state('s.pendingListDraft?.name ?? null'));
await shot('edit-in-lists');

// The PDF itself.
await page.goto(`file:///${pdfPath.replace(/\\/g, '/')}`);
await page.waitForTimeout(2500);
await shot('pdf-page-1');

// A long table: a class-less list (every entity) capped at 120 rows must paginate with the head
// repeated and nothing past the footer — the real jsPDF/autotable row height against the composer's.
// A bigger model for this part (WALKTHROUGH_LONG_MODEL, served from apps/viewer/public — not committed).
await page.goto(`${BASE}/?model=${process.env.WALKTHROUGH_LONG_MODEL ?? '/samples/_duplex-walkthrough.ifc'}`);
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 180000 });
await page.waitForTimeout(3000);
await page.evaluate((k) => {
  const s = globalThis[k].getState();
  const list = { id: 'document-list-long', name: 'Every entity', createdAt: 0, updatedAt: 0, entityTypes: [], conditions: [], columns: [
    { id: 'name', source: 'attribute', propertyName: 'Name' }, { id: 'class', source: 'attribute', propertyName: 'Class' }, { id: 'guid', source: 'attribute', propertyName: 'GlobalId' },
  ] };
  const doc = { version: 3, id: 'document-long', name: 'Long table', page: { size: 'A4', orientation: 'portrait' }, blocks: [
    { kind: 'text', id: 'b-title', style: 'title', text: 'Long table' },
    { kind: 'table', id: 'b-table', source: { kind: 'list', list }, maxRows: 120, caption: 'Capped at 120 rows' },
    { kind: 'text', id: 'b-after', style: 'body', text: 'Text after the table.' },
  ] };
  s.upsertDocument(doc);
  s.setActiveDocumentId('document-long');
}, STORE);
await page.getByRole('tab', { name: /analy/i }).first().click();
await page.getByRole('button', { name: /^Document/ }).first().click();
await page.waitForSelector('[data-document-panel]', { timeout: 15000 });
await page.waitForSelector('[data-block-table] table', { timeout: 30000 });
await page.waitForTimeout(500);
log('long table preview rows', await page.locator('[data-block-table] tbody tr[data-role="row"]').count(), 'more', await page.locator('[data-block-table] tr[data-role="more"] td').first().textContent().catch(() => null));
const [longPdf] = await Promise.all([
  page.waitForEvent('download', { timeout: 90000 }),
  page.locator('[data-document-export]').click(),
]);
const longPath = `${OUT}/${longPdf.suggestedFilename()}`;
await longPdf.saveAs(longPath);
log('long pdf saved', longPath);
for (const n of [1, 2, 3, 4]) {
  await page.goto(`file:///${longPath.replace(/\\/g, '/')}#page=${n}&zoom=90`);
  await page.waitForTimeout(2000);
  await shot(`long-pdf-page-${n}`);
}

writeFileSync(`${OUT}/findings.txt`, [...findings, '', 'page errors:', ...errors].join('\n'));
log('page errors', errors.length, errors.slice(0, 10));
log('findings', findings);
await browser.close();
