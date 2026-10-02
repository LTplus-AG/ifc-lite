/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const [wt, out, port] = process.argv.slice(2);
if (!wt || !out || !port) throw Error('Pass owned worktree, output directory and server port');
const { chromium } = require(wt + '/node_modules/@playwright/test');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(out, { recursive: true });
(async () => {
 const context = await chromium.launchPersistentContext(out + '-profile', { executablePath: '/usr/bin/google-chrome', headless: true, viewport: { width: 1520, height: 1040 }, acceptDownloads: true, args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] });
 const facts = { source: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim(), capturedAt: new Date().toISOString(), route: 'Real public IFC primary/federated canonical loads. Checklist and declared human answers set through existing store actions; actual Document Add block, stamp checkbox, Refresh, saved-source picker, downloaded template import and downloaded unmodified jsPDF PDFs.', renderingLimits: 'Own-profile Linux Chrome software WebGPU; document/data evidence, no hardware 3D or performance claim.', models: [], states: [], artifacts: [], errors: [] };
 let page; const observedWasm = [];
 const artifact = path => ({ path: path.split('/').at(-1), bytes: fs.statSync(path).size, sha256: hash(fs.readFileSync(path)) });
 try {
  page = await context.newPage();
  page.on('console', msg => { if (msg.type() === 'error') facts.errors.push({ type: 'console', message: msg.text().slice(0, 1200) }); });
  page.on('pageerror', err => facts.errors.push({ type: 'pageerror', message: err.message }));
  page.on('response', response => { if (response.url().includes('ifc-lite_bg') && response.url().includes('.wasm')) observedWasm.push({ url: response.url(), status: response.status() }); });
  await page.goto('http://127.0.0.1:' + port);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__);
  await page.locator('input[type=file][accept^=".ifc"]').first().setInputFiles(wt + '/apps/viewer/public/samples/building-architecture.ifc');
  await page.waitForFunction(() => { const s = __ifc_lite_viewer_store__.getState(); return [...s.models.values()].some(m => m.ifcDataStore && m.sourceFingerprint) && !s.isLoading; }, null, { timeout: 90000 });
  const setup = async count => page.evaluate(async count => {
   const { DOCUMENT_VERSION } = await import('/src/lib/document/types.ts');
   const s = __ifc_lite_viewer_store__.getState();
   const models = [...s.models.values()].filter(m => m.ifcDataStore);
   const model = models.at(-1); s.setActiveModel(model.id);
   s.setManualChecklist({ version: 1, name: 'Delivery review ' + count, groups: [{ id: 'delivery', name: 'Delivery', items: [{ id: 'uploaded', text: 'Uploaded on time' }, { id: 'names', text: 'Naming convention' }] }] });
   s.setManualAnswer(model.sourceFingerprint, 'uploaded', { status: 'pass' });
   s.setManualAnswer(model.sourceFingerprint, 'names', { status: 'warning', comment: 'Review retained prefix' });
   if (!s.upsertDocument({ version: DOCUMENT_VERSION, id: 'stamp-proof-' + count, name: 'Manual stamp proof ' + count, page: { size: 'A4', orientation: 'portrait' }, blocks: [] })) throw Error('Canonical document writer refused setup');
   s.setActiveDocumentId('stamp-proof-' + count); s.floatPanel('document'); s.setFloatingPanelRect('document', { x: 20, y: 65, w: 1470, h: 950 });
   return models.map(m => ({ name: m.name, fingerprint: m.sourceFingerprint, entities: m.ifcDataStore.entityCount }));
  }, count);
  const block = () => page.evaluate(() => { const s = __ifc_lite_viewer_store__.getState(); return s.documents.find(d => d.id === s.activeDocumentId).blocks.find(b => b.kind === 'manual-report'); });
  const observe = async label => { const snapshot = await block(); const preview = await page.locator('[data-block-manual-report]').textContent(); const flag = await page.getByRole('checkbox', { name: 'Show stamp information', exact: true }).isChecked(); facts.states.push({ label, snapshot, preview, checkbox: flag }); return snapshot; };
  const screenshot = async label => { const path = out + '/' + label + '.png'; await page.screenshot({ path }); facts.artifacts.push(artifact(path)); };
  const pdf = async label => { const promised = page.waitForEvent('download', { timeout: 60000 }); await page.getByRole('button', { name: 'Export PDF', exact: true }).click(); const download = await promised; const path = out + '/' + label + '.pdf'; await download.saveAs(path); assert.equal(await download.failure(), null); facts.artifacts.push(artifact(path)); };
  for (const count of [1, 2]) {
   if (count === 2) { await page.evaluate(async () => { const { loadDemoRevB } = await import('/src/lib/tours/demo-kit.ts'); await loadDemoRevB(); }); await page.waitForFunction(() => { const s = __ifc_lite_viewer_store__.getState(); return [...s.models.values()].filter(m => m.ifcDataStore && m.sourceFingerprint).length === 2 && !s.isLoading; }, null, { timeout: 90000 }); }
   facts.models = await setup(count);
   await page.getByTitle('Add a block to the page', { exact: true }).click(); await page.getByRole('menuitem', { name: 'Validation report', exact: true }).click();
   await page.waitForFunction(() => document.querySelector('[data-block-manual-report]')?.textContent.includes('Review retained prefix'));
   const before = await observe(count + '-shown'); assert.ok(!('showStamp' in before) || before.showStamp === undefined);
   assert.match(facts.states.at(-1).preview, /Model:.*Recorded:.*Models:/s);
   await screenshot(count + '-shown'); await pdf(count + '-shown');
   await page.getByRole('checkbox', { name: 'Show stamp information', exact: true }).uncheck();
   const hidden = await observe(count + '-hidden'); assert.equal(hidden.showStamp, false); const { showStamp, ...evidence } = hidden; assert.deepEqual(evidence, before); assert.doesNotMatch(facts.states.at(-1).preview, /Model:|Models:|Recorded:/);
   await screenshot(count + '-hidden'); await pdf(count + '-hidden');
   if (count === 2) {
    await page.evaluate(fp => __ifc_lite_viewer_store__.getState().setManualAnswer(fp, 'names', { status: 'pass', comment: 'Reviewed and approved' }), before.modelFingerprint);
    await page.getByRole('button', { name: 'Refresh from current checklist', exact: true }).click();
    const refreshed = await observe('2-refreshed'); assert.equal(refreshed.showStamp, false); assert.equal(refreshed.groups[0].items[1].status, 'pass');
    const savedId = await page.evaluate(() => { const s = __ifc_lite_viewer_store__.getState(); const b = s.documents.find(d => d.id === s.activeDocumentId).blocks[0]; return s.saveValidationReport({ ...b, showStamp: true, checklistName: 'Saved review evidence' }, 'Saved review evidence'); }); assert.ok(savedId);
    await page.getByLabel('Saved report source', { exact: true }).selectOption(`saved:${savedId}`);
    const selected = await observe('2-saved-source'); assert.equal(selected.showStamp, false); assert.equal(selected.checklistName, 'Saved review evidence');
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: 'Document actions', exact: true }).click(); await page.getByRole('menuitem', { name: 'Export template…', exact: true }).click(); const download = await event; const path = out + '/hidden.ifclite-document.json'; await download.saveAs(path); assert.equal(await download.failure(), null); facts.artifacts.push(artifact(path));
    assert.equal(JSON.parse(fs.readFileSync(path)).blocks[0].showStamp, false);
    await page.locator('input[data-document-import]').setInputFiles(path); await page.waitForFunction(() => [...document.querySelectorAll('[data-toast-seq]')].some(e => e.textContent.includes('Imported document')));
    const imported = await observe('2-imported');
    const persistedEvidence = value => { const { id, ...rest } = value; return JSON.parse(JSON.stringify(rest)); };
    assert.notEqual(imported.id, selected.id, 'canonical import allocates a fresh block identity');
    assert.deepEqual(persistedEvidence(imported), persistedEvidence(selected), 'all recorded data and presentation survive real JSON import');
    await screenshot('2-imported-hidden'); await pdf('2-imported-hidden');
    await page.getByRole('checkbox', { name: 'Show stamp information', exact: true }).check(); const restored = await observe('2-reshown'); assert.equal(restored.showStamp, true); assert.deepEqual(restored.groups, selected.groups); assert.match(facts.states.at(-1).preview, /Model:.*Recorded:.*Models:/s); await pdf('2-reshown');
   }
  }
  facts.inputs = ['building-architecture.ifc', 'building-architecture-rev-b.ifc'].map(name => ({ name, sha256: hash(fs.readFileSync(wt + '/apps/viewer/public/samples/' + name)) }));
  facts.chrome = await context.browser()?.version();
  facts.runtime = [];
  for (const url of new Set(observedWasm.map(item => item.url))) { const response = await context.request.get(url); const bytes = await response.body(); assert.equal(response.status(), 200); facts.runtime.push({ url, observedStatuses: observedWasm.filter(item => item.url === url).map(item => item.status), witnessStatus: response.status(), bytes: bytes.length, sha256: hash(bytes), scope: 'Separate served-resource byte witness after document operations; no performance measurement.' }); }
  assert.ok(facts.runtime.length, 'real IFC worker runtime was observed');
  fs.writeFileSync(out + '/facts.json', JSON.stringify(facts, null, 2) + '\n');
  console.log(JSON.stringify({ source: facts.source, states: facts.states.length, artifacts: facts.artifacts.length, models: facts.models }));
 } catch (error) { if (page) await page.screenshot({ path: out + '/failure.png' }); fs.writeFileSync(out + '/failed-attempt.json', JSON.stringify({ facts, message: String(error) }, null, 2)); throw error; }
 finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
