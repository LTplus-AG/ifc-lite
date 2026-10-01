/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const fs = require('node:fs');
const crypto = require('node:crypto');
const child = require('node:child_process');
const wt = '/home/louistrue/wt/6549-saved-chart-main-integration-session6503';
const { chromium } = require(wt + '/node_modules/@playwright/test');
const out = '/tmp/6232-takeover/6549-native-final';
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
 const source = child.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim();
 const context = await chromium.launchPersistentContext('/tmp/6232-takeover/6549-chrome-own-profile-session6503-af', { executablePath: '/usr/bin/google-chrome', headless: true, viewport: { width: 1440, height: 1000 }, acceptDownloads: true, args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] });
 const logs = []; let page;
 try {
  page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error') logs.push({ type: 'console', text: message.text().slice(0, 1200) }); });
  page.on('pageerror', (error) => logs.push({ type: 'pageerror', text: error.message }));
  await page.goto('http://127.0.0.1:52657/');
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__);
  await page.locator('input[type=file][accept^=".ifc"]').first().setInputFiles(wt + '/apps/viewer/public/samples/building-architecture.ifc');
  await page.waitForFunction(() => [...__ifc_lite_viewer_store__.getState().models.values()].some((model) => model.ifcDataStore), null, { timeout: 60000 });
  await page.evaluate(async () => { const { loadDemoRevB } = await import('/src/lib/tours/demo-kit.ts'); await loadDemoRevB(); });
  await page.waitForFunction(() => [...__ifc_lite_viewer_store__.getState().models.values()].filter((model) => model.ifcDataStore).length === 2, null, { timeout: 60000 });
  const models = await page.evaluate(() => [...__ifc_lite_viewer_store__.getState().models.values()].map((model) => ({ id: model.id, name: model.name, fingerprint: model.sourceFingerprint, entities: model.ifcDataStore?.entityCount })));
  const base = models.find((model) => model.name === 'building-architecture.ifc');
  const revision = models.find((model) => model.name === 'building-architecture-rev-b.ifc');
  if (!base || !revision) throw Error('Canonical public A/B metadata not present');
  await page.evaluate(() => { const state = __ifc_lite_viewer_store__.getState(); state.floatPanel('compare'); state.setFloatingPanelRect('compare', { x: 20, y: 70, w: 700, h: 900 }); });
  const run = async (a, b, name) => {
   await page.getByLabel('A', { exact: true }).selectOption(a);
   await page.getByLabel('B', { exact: true }).selectOption(b);
   await page.getByRole('button', { name: 'Data', exact: true }).click();
   const previous = await page.evaluate(() => __ifc_lite_viewer_store__.getState().compareRunSeq);
   await page.getByRole('button', { name: 'Run comparison', exact: true }).click();
   await page.waitForFunction((seq) => { const state = __ifc_lite_viewer_store__.getState(); return state.compareRunSeq > seq && state.compareResult && !state.compareRunning; }, previous, { timeout: 60000 });
   await page.getByLabel('Comparison name', { exact: true }).fill(name);
   const count = await page.evaluate(() => __ifc_lite_viewer_store__.getState().savedComparisons.length);
   await page.getByRole('button', { name: 'Save comparison', exact: true }).click();
   await page.waitForFunction((count) => __ifc_lite_viewer_store__.getState().savedComparisons.length === count + 1, count);
   return page.evaluate((name) => __ifc_lite_viewer_store__.getState().savedComparisons.find((entry) => entry.name === name), name);
  };
  const savedAB = await run(base.id, revision.id, 'Public A to B report');
  await page.evaluate(() => { const state = __ifc_lite_viewer_store__.getState(); state.closeFloatingPanel('compare'); state.upsertDashboard({ version: 2, id: 'saved-comparison-proof', name: 'Saved comparison chart proof', scope: { kind: 'all' }, charts: [], layout: [] }); state.setActiveDashboardId('saved-comparison-proof'); state.floatPanel('charts'); state.setFloatingPanelRect('charts', { x: 20, y: 70, w: 1400, h: 900 }); });
  await page.getByRole('button', { name: 'Add chart', exact: true }).first().click();
  await page.getByLabel('Source', { exact: true }).selectOption('compare');
  await page.getByLabel('Saved comparison', { exact: true }).selectOption(savedAB.id);
  await page.getByLabel('Chart title', { exact: true }).fill('Recorded public A to B');
  await page.screenshot({ path: out + '-source-picker.png' });
  await page.getByRole('button', { name: 'Save chart', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-chart-legend]')?.textContent.includes('added'));
  const chartSpec = await page.evaluate(() => __ifc_lite_viewer_store__.getState().dashboards.find((item) => item.id === 'saved-comparison-proof').charts[0]);
  if (chartSpec.comparisonId !== savedAB.id) throw Error('Chosen source did not persist');
  const derived = await page.evaluate(async ({ wt, revisionId }) => {
   const [{ MutablePropertyView, StoreEditor }, { StepExporter }, { EVENT_ADD_MODEL }] = await Promise.all([import('/@fs' + wt + '/packages/mutations/src/index.ts'), import('/@fs' + wt + '/packages/export/src/index.ts'), import('/src/lib/tours/events.ts')]);
   const model = __ifc_lite_viewer_store__.getState().models.get(revisionId); const store = model.ifcDataStore;
   const view = new MutablePropertyView(store.properties, model.id);
   const wall = store.entities.getExpressIdByGlobalId('1AQAupaRP1txwK1AGiN61V'); if (!wall) throw Error('Declared C source wall absent');
   const oldName = store.entities.getName(wall);
   new StoreEditor(store, view).setAttribute(wall, 'Name', 'Explicit browser chart revision C wall');
   const exported = new StepExporter(store, view).export({ schema: store.schemaVersion, applyMutations: true, includeGeometry: true, includeQuantities: true });
   const bytes = [...exported.content]; window.dispatchEvent(new CustomEvent(EVENT_ADD_MODEL, { detail: new File([exported.content], 'declared-chart-revision-c.ifc', { type: 'application/x-step' }) }));
   return { bytes, recipe: { source: model.name, GlobalId: '1AQAupaRP1txwK1AGiN61V', attribute: 'Name', oldName, newName: 'Explicit browser chart revision C wall', tools: 'MutablePropertyView + StoreEditor + StepExporter; normal add-model event/canonical loadFile' } };
  }, { wt, revisionId: revision.id });
  fs.writeFileSync(out + '-declared-revision-c.ifc', Buffer.from(derived.bytes));
  await page.waitForFunction(() => [...__ifc_lite_viewer_store__.getState().models.values()].some((model) => model.name === 'declared-chart-revision-c.ifc' && model.ifcDataStore), null, { timeout: 60000 });
  const c = await page.evaluate(() => [...__ifc_lite_viewer_store__.getState().models.values()].find((model) => model.name === 'declared-chart-revision-c.ifc').id);
  await page.evaluate(() => { const state = __ifc_lite_viewer_store__.getState(); state.closeFloatingPanel('charts'); state.floatPanel('compare'); state.setFloatingPanelRect('compare', { x: 20, y: 70, w: 700, h: 900 }); });
  const savedBC = await run(revision.id, c, 'Declared B to C name change');
  await page.screenshot({ path: out + '-live-comparison.png' });
  await page.evaluate(() => { const state = __ifc_lite_viewer_store__.getState(); state.closeFloatingPanel('compare'); state.floatPanel('charts'); state.setFloatingPanelRect('charts', { x: 20, y: 70, w: 1400, h: 900 }); });
  await page.waitForFunction(() => document.querySelector('[data-chart-legend]')?.textContent.includes('added'));
  await page.screenshot({ path: out + '-recorded-dashboard.png' });
  const dashboard = await page.evaluate(() => ({ persisted: __ifc_lite_viewer_store__.getState().dashboards.find((item) => item.id === 'saved-comparison-proof'), legend: document.querySelector('[data-chart-legend]')?.textContent, subtitle: document.querySelector('[data-chart-subtitle]')?.textContent, currentCounts: __ifc_lite_viewer_store__.getState().compareResult.diff.counts }));
  const dashboardDownload = page.waitForEvent('download', { timeout: 60000 });
  await page.getByTitle('Print this dashboard to a PDF report', { exact: true }).click();
  await page.locator('[data-report-export]').click();
  const dashboardPdf = await dashboardDownload; await dashboardPdf.saveAs(out + '-dashboard.pdf'); if (await dashboardPdf.failure()) throw Error(await dashboardPdf.failure());
  await page.evaluate(async (chart) => { const { DOCUMENT_VERSION } = await import('/src/lib/document/types.ts'); const state = __ifc_lite_viewer_store__.getState(); state.closeFloatingPanel('charts'); const doc = { version: DOCUMENT_VERSION, id: 'recorded-doc-proof', name: 'Saved comparison document proof', page: { size: 'A4', orientation: 'portrait' }, blocks: [{ kind: 'chart', id: 'recorded-block', chart, snapshot: true }] }; if (!state.upsertDocument(doc)) throw Error('Canonical document writer refused actual authored source'); state.setActiveDocumentId(doc.id); state.floatPanel('document'); state.setFloatingPanelRect('document', { x: 20, y: 70, w: 1400, h: 900 }); }, chartSpec);
  await page.waitForFunction(() => document.querySelector('[data-preview-block="recorded-block"] svg')?.textContent.includes('added'));
  await page.screenshot({ path: out + '-document-preview.png' });
  const docBefore = await page.evaluate(() => ({ persisted: __ifc_lite_viewer_store__.getState().documents.find((item) => item.id === 'recorded-doc-proof'), preview: document.querySelector('[data-preview-block="recorded-block"]')?.textContent, checkboxDisabled: document.querySelector('[data-block-editor="recorded-block"] input[type="checkbox"]')?.disabled }));
  const download = page.waitForEvent('download', { timeout: 60000 }); await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const docPdf = await download; await docPdf.saveAs(out + '-document.pdf'); if (await docPdf.failure()) throw Error(await docPdf.failure());
  await page.reload(); await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__);
  await page.evaluate(() => { const state = __ifc_lite_viewer_store__.getState(); state.floatPanel('document'); state.setFloatingPanelRect('document', { x: 20, y: 70, w: 1400, h: 900 }); });
  await page.waitForFunction(() => document.querySelector('[data-preview-block="recorded-block"] svg')?.textContent.includes('added'));
  const docAfter = await page.evaluate(() => ({ models: __ifc_lite_viewer_store__.getState().models.size, persisted: __ifc_lite_viewer_store__.getState().documents.find((item) => item.id === 'recorded-doc-proof'), preview: document.querySelector('[data-preview-block="recorded-block"]')?.textContent }));
  if (JSON.stringify(docBefore.persisted) !== JSON.stringify(docAfter.persisted)) throw Error('Document binding changed after reload');
  await page.screenshot({ path: out + '-reloaded-no-models.png' });
  await page.evaluate((id) => { if (!__ifc_lite_viewer_store__.getState().deleteSavedComparison(id)) throw Error('Canonical history deletion refused'); }, savedAB.id);
  await page.waitForFunction(() => document.querySelector('[data-preview-block="recorded-block"]')?.textContent.includes('Saved comparison unavailable'));
  const missingNoticeCount = await page.evaluate(() => (document.querySelector('[data-preview-block="recorded-block"]')?.textContent.match(/Saved comparison unavailable in this browser/g) ?? []).length);
  if (missingNoticeCount !== 1) throw Error('Missing-source notice repeated in actual preview: ' + missingNoticeCount);
  await page.screenshot({ path: out + '-missing-source.png' });
  const missingEvent = page.waitForEvent('download', { timeout: 60000 }); await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const missingPdf = await missingEvent; await missingPdf.saveAs(out + '-missing-source.pdf'); if (await missingPdf.failure()) throw Error(await missingPdf.failure());
  const artifact = (suffix) => ({ path: out + suffix, bytes: fs.statSync(out + suffix).size, sha256: hash(fs.readFileSync(out + suffix)) });
  fs.writeFileSync(out + '-document.ifclite-document.json', JSON.stringify(docBefore.persisted, null, 2) + '\n');
  fs.writeFileSync(out + '-dashboard.ifclite-dashboard.json', JSON.stringify(dashboard.persisted, null, 2) + '\n');
  fs.writeFileSync(out + '-saved-comparisons.json', JSON.stringify([savedAB, savedBC]) + '\n');
  fs.writeFileSync(out + '-observations.json', JSON.stringify({ source, capturedAt: new Date().toISOString(), chrome: await context.browser()?.version(), inputHashes: { A: hash(fs.readFileSync(wt + '/apps/viewer/public/samples/building-architecture.ifc')), B: hash(fs.readFileSync(wt + '/apps/viewer/public/samples/building-architecture-rev-b.ifc')), C: artifact('-declared-revision-c.ifc') }, declaredRecipe: derived.recipe, route: 'Own-profile Chrome, actual canonical primary/federated file loads, actual mounted Compare run/save and chart source picker, real engines, unmodified native SVG/PDF exporters, actual download events.', limits: 'Own Linux Chrome software WebGPU is a document/data route. Any graphics-device loss or EPSG federation-alignment failure is retained in console errors/screenshots; no 3D, geospatial alignment, or performance claim.', models, savedReports: [{ id: savedAB.id, name: savedAB.name, rows: savedAB.report.rows }, { id: savedBC.id, name: savedBC.name, rows: savedBC.report.rows }], dashboard, docBefore, docAfter, missingNoticeCount, downloads: [artifact('-dashboard.pdf'), artifact('-document.pdf'), artifact('-missing-source.pdf')], logs }, null, 2) + '\n');
  console.log(JSON.stringify({ source, savedRows: [savedAB.report.rows.length, savedBC.report.rows.length], modelsAfterReload: docAfter.models, downloads: [artifact('-dashboard.pdf'), artifact('-document.pdf'), artifact('-missing-source.pdf')] }));
 } catch (error) { if (page) await page.screenshot({ path: out + '-failure.png' }); fs.writeFileSync(out + '-failure-logs.json', JSON.stringify(logs, null, 2)); throw error; }
 finally { await context.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
