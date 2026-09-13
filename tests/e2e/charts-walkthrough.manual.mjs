/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough of the Charts panel (#3944) against a dev server.
// Not a CI test: it drives the real UI — WebGPU, the ECharts canvas, jsPDF,
// the clash run — and saves a screenshot per step plus `findings.txt` for
// review. It is what caught the defects the unit tests could not (a
// StrictMode double mount, a camera frame that never resolved, an SVG the
// PDF refused). Run, with `pnpm exec vite --port 5199` up in apps/viewer:
//   node tests/e2e/charts-walkthrough.manual.mjs
// Env: WALKTHROUGH_BASE (default http://localhost:5199), WALKTHROUGH_OUT
// (default <tmp>/ifc-lite-charts-walkthrough).
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-charts-walkthrough');
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
const act = (expr) => page.evaluate(({ k, e }) => { new Function('s', `${e};`)(globalThis[k].getState()); }, { k: STORE, e: expr });

await page.goto(`${BASE}/?model=/samples/building-architecture.ifc`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 120000 });
await page.waitForTimeout(4000);
log('model loaded, meshes', await state('s.geometryResult?.meshes?.length'));
await shot('model-loaded');

// Open the Charts panel via the ribbon Analyze tab.
await page.getByRole('tab', { name: /analy/i }).first().click().catch(async () => { await page.getByText('Analyze', { exact: true }).first().click(); });
await page.waitForTimeout(300);
await shot('analyze-tab');
const chartsBtn = page.getByRole('button', { name: /^Charts/ }).first();
await chartsBtn.click();
await page.waitForSelector('[data-charts-panel]', { timeout: 15000 });
await page.waitForFunction(() => { const hosts = document.querySelectorAll('[data-chart-host]'); return hosts.length > 0 && [...hosts].every((h) => h.querySelector('canvas')); }, undefined, { timeout: 60000 }).catch(() => note('not every chart host got a canvas within 60 s'));
await page.waitForTimeout(1200);
await shot('charts-panel-open');
log('hosts/canvases', await page.evaluate(() => [document.querySelectorAll('[data-chart-host]').length, document.querySelectorAll('[data-chart-host] canvas').length]));
log('subtitles', await page.locator('[data-chart-subtitle]').allTextContents());
log('dashboards', await state('s.dashboards.map(d=>d.name)'));

// Chart → 3D: click the first bucket of the first chart through the sr-only legend (same path as a bar click).
const legend = page.locator('[data-chart-id]').first().locator('[data-chart-legend] button').first();
log('clicking bucket', await legend.textContent());
await legend.evaluate((b) => b.click());
await page.waitForTimeout(800);
log('selected', await state('s.selectedEntityIds.size'), 'ghost', await state('s.ghostExceptEntities?.size ?? null'), 'owned', await state('s.chartVisibilityOwned?.channel ?? null'), 'slice', await state('s.chartSlice?.size ?? null'));
await shot('bucket-click-ghost');
log('other chart subtitles after slice', await page.locator('[data-chart-subtitle]').allTextContents());

// A real pointer click on the first bar of the canvas (ECharts hit-test → selectchanged).
await page.getByRole('button', { name: /Clear slice/ }).click().catch(() => {});
await page.waitForTimeout(300);
const hostBox = await page.locator('[data-chart-host]').first().boundingBox();
if (hostBox) {
  await page.mouse.click(hostBox.x + hostBox.width * 0.12, hostBox.y + hostBox.height * 0.5);
  await page.waitForTimeout(800);
  const sel = await state('s.selectedEntityIds.size');
  log('canvas bar click selected', sel);
  if (sel === 0) note('a pointer click on the first bar did not select anything');
  await shot('canvas-bar-click');
}

// Focus mode → isolate.
await page.locator('select[aria-label="Focus mode"]').selectOption('isolate');
await page.waitForTimeout(800);
log('isolated', await state('s.isolatedEntities?.size ?? null'), 'ghost', await state('s.ghostExceptEntities?.size ?? null'));
await shot('focus-isolate');
await page.locator('select[aria-label="Focus mode"]').selectOption('ghost');

// Colour in 3D.
await page.getByLabel(/Colour in 3D/).check({ force: true }).catch(async () => { await page.locator('[data-charts-panel] input[type=checkbox]').first().check({ force: true }); });
await page.waitForTimeout(800);
log('overlay layer', await state("s.overlayLayers.get('charts')?.colorOverrides?.size ?? null"));
await shot('colour-in-3d');

// Clear slice.
const clear = page.getByRole('button', { name: /Clear slice/ });
if (await clear.count()) { await clear.click(); await page.waitForTimeout(500); }
log('after clear: slice', await state('s.chartSlice'), 'ghost', await state('s.ghostExceptEntities'), 'selected', await state('s.selectedEntityIds.size'));
await shot('slice-cleared');

// 3D → chart: pick a wall through the store's selection channel (a viewport pick writes the same channel).
const someIds = await state("Array.from(s.geometryResult.meshes.slice(0, 3).map(m => m.expressId))");
await act(`s.setSelectedEntityIds(${JSON.stringify(someIds)})`);
await page.waitForTimeout(800);
await shot('3d-pick-highlights-chart');

// Scope → visible; hide something first via store.
await page.locator('select[aria-label="Scope"]').selectOption('visible');
await page.waitForTimeout(800);
log('visible-scope subtitles', await page.locator('[data-chart-subtitle]').allTextContents());
await shot('scope-visible');
await page.locator('select[aria-label="Scope"]').selectOption('all');

// Editor: add a chart.
await page.getByRole('button', { name: /Add chart/ }).click();
await page.waitForSelector('[data-chart-editor]');
await shot('editor-open');
await page.locator('[data-chart-editor] select[aria-label="Chart type"]').selectOption('treemap');
await page.locator('[data-chart-editor] input[aria-label="Chart title"]').fill('Elements treemap');
await page.getByRole('button', { name: 'Save chart' }).click();
await page.waitForTimeout(1200);
log('chart count', await state('s.dashboards[0].charts.length'));
await shot('editor-saved-treemap');

// Presets: Coordination (needs a clash run for data) — run clash via the store? Use preset switch and see empty-state messaging.
await page.locator('select[aria-label="Dashboard"]').selectOption({ label: 'Coordination' });
await page.waitForTimeout(1200);
log('coordination subtitles', await page.locator('[data-chart-subtitle]').allTextContents());
await shot('preset-coordination-no-data');

// Delivery preset (IDS) – no data yet either; Schedule preset.
await page.locator('select[aria-label="Dashboard"]').selectOption({ label: 'Schedule' });
await page.waitForTimeout(1000);
await shot('preset-schedule');
// Back to overview.
const overviewId = await state("s.dashboards.find(d => d.name === 'Model overview').id");
await page.locator('select[aria-label="Dashboard"]').selectOption(overviewId);
await page.waitForTimeout(800);

// Grid: drag the first card by its title bar to the right.
const handle = page.locator('.chart-drag-handle').first();
const box = await handle.boundingBox();
if (box) {
  const before = await state('JSON.stringify(s.dashboards.find(d=>d.name==="Model overview").layout)');
  await page.mouse.move(box.x + 20, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 8, { steps: 12 });
  await page.mouse.move(box.x + 700, box.y + 8, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await state('JSON.stringify(s.dashboards.find(d=>d.name==="Model overview").layout)');
  log('layout changed by drag:', before !== after);
  if (before === after) note('dragging a card did not change the saved layout');
  await shot('grid-after-drag');
}

// Dashboard menu: export file.
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 15000 }),
  (async () => { await page.getByRole('button', { name: 'Dashboard actions' }).click(); await page.getByRole('menuitem', { name: /Export file/ }).click(); })(),
]);
log('dashboard file download:', download.suggestedFilename());
await shot('dashboard-exported');

// Report: open dialog, export PDF (real jsPDF + svg2pdf + WebGPU snapshot).
await page.getByRole('button', { name: /^Report/ }).click();
await page.waitForSelector('[data-report-dialog]');
await shot('report-dialog');
await page.locator('[data-report-dialog] select[aria-label="Orientation"]').selectOption('landscape');
const [pdf] = await Promise.all([
  page.waitForEvent('download', { timeout: 90000 }),
  page.locator('[data-report-export]').click(),
]);
const pdfPath = `${OUT}/report.pdf`;
await pdf.saveAs(pdfPath);
log('report pdf saved', pdfPath);
await page.waitForTimeout(1000);
await shot('after-report-export');
log('camera restored? ghost', await state('s.ghostExceptEntities'), 'owned', await state('s.chartVisibilityOwned'));

// Clash: open the clash panel, run "Detect all clashes", export the CSV, then the Coordination dashboard has data.
await act('s.setClashPanelVisible(true)');
await page.waitForTimeout(800);
await shot('clash-panel');
const runBtn = page.getByRole('button', { name: /Detect all clashes/ }).first();
if (await runBtn.count()) {
  await runBtn.click();
  await page.waitForFunction((k) => globalThis[k].getState().clashResult !== null, STORE, { timeout: 120000 }).catch(() => note('clash run did not produce a result in 120 s'));
  await page.waitForTimeout(800);
  log('clashes', await state('s.clashResult?.clashes.length ?? null'));
  await shot('clash-run');
  const [csv] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
    page.getByRole('button', { name: /^CSV$/ }).first().click().catch(() => note('CSV button not found in clash panel')),
  ]);
  if (csv) { const p = `${OUT}/${csv.suggestedFilename()}`; await csv.saveAs(p); log('csv saved', p); } else note('clash CSV download did not fire');
  await act('s.setClashPanelVisible(false)');
  // Coordination dashboard now has clash data.
  const coordId = await state("s.dashboards.find(d => d.name === 'Coordination')?.id");
  if (coordId) await page.locator('select[aria-label="Dashboard"]').selectOption(coordId);
  else await page.locator('select[aria-label="Dashboard"]').selectOption('preset:Coordination');
  await page.waitForTimeout(1500);
  log('coordination subtitles with clashes', await page.locator('[data-chart-subtitle]').allTextContents());
  log('empty hints', await page.locator('[data-chart-empty]').allTextContents());
  await shot('coordination-with-clashes');
  const clashLegend = page.locator('[data-chart-id]').first().locator('[data-chart-legend] button').first();
  if (await clashLegend.count()) { await clashLegend.evaluate((b) => b.click()); await page.waitForTimeout(800); log('clash bucket selected', await state('s.selectedEntityIds.size'), 'ghost', await state('s.ghostExceptEntities?.size ?? null')); await shot('clash-bucket-selected'); }
} else note('Detect all clashes button not found');

writeFileSync(`${OUT}/findings.txt`, [...findings, '', 'page errors:', ...errors].join('\n'));
log('page errors', errors.length, errors.slice(0, 10));
log('findings', findings);
await browser.close();
