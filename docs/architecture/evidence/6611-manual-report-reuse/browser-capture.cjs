/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const fs = require('node:fs'), cp = require('node:child_process'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const [wt, out, port] = process.argv.slice(2);
if (!wt || !out || !port) throw Error('Pass owned worktree, output directory and dev-server port');
const { chromium } = require(wt + '/node_modules/@playwright/test');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(out, { recursive: true });
const facts = { source: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim(), capturedAt: new Date().toISOString(), route: 'Real public IFC canonical file inputs at1/N; declared human checklist/initial answers through canonical store actions. Actual Save report, Delete checklist, page reload, Edit a copy, comment/verdict editing, saved-source picker and completed PDF downloads.', renderingLimits: 'Own-profile Linux Chrome with software WebGPU. Document/data evidence only; no hardware3D or performance claim.', cohorts: [], artifacts: [], errors: [] };
const artifact = path => ({ path: path.split('/').at(-1), bytes: fs.statSync(path).size, sha256: hash(fs.readFileSync(path)) });
(async () => {
 for (const count of [1, 2]) {
  const context = await chromium.launchPersistentContext(out + '-' + count + '-profile', { executablePath: '/usr/bin/google-chrome', headless: true, viewport: { width: 1520, height: 1040 }, acceptDownloads: true, args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'] });
  let page; const runtimeResponses = [];
  const cohort = { count, states: [] }; facts.cohorts.push(cohort);
  try {
   page = await context.newPage();
   page.on('console', msg => { if (msg.type() === 'error') facts.errors.push({ count, type: 'console', message: msg.text().slice(0, 1000) }); });
   page.on('pageerror', err => facts.errors.push({ count, type: 'pageerror', message: err.message }));
   page.on('response', response => { if (response.url().includes('ifc-lite_bg') && response.url().includes('.wasm')) runtimeResponses.push({ url: response.url(), status: response.status() }); });
   const waitStore = () => page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__);
   const loadModels = async () => {
    await page.locator('input[type=file][accept^=".ifc"]').first().setInputFiles(wt + '/apps/viewer/public/samples/building-architecture.ifc');
    await page.waitForFunction(() => { const s = __ifc_lite_viewer_store__.getState(); return [...s.models.values()].some(m => m.ifcDataStore && m.sourceFingerprint) && !s.isLoading; }, null, { timeout: 90000 });
    if (count === 2) {
     await page.evaluate(async () => { const { loadDemoRevB } = await import('/src/lib/tours/demo-kit.ts'); await loadDemoRevB(); });
     await page.waitForFunction(() => { const s = __ifc_lite_viewer_store__.getState(); return [...s.models.values()].filter(m => m.ifcDataStore && m.sourceFingerprint).length === 2 && !s.isLoading; }, null, { timeout: 90000 });
    }
   };
   const openValidation = () => page.evaluate(() => { const s = __ifc_lite_viewer_store__.getState(); s.floatPanel('validation'); s.setFloatingPanelRect('validation', { x: 20, y: 65, w: 1470, h: 950 }); });
   const observe = async label => {
    const state = await page.evaluate(() => { const s = __ifc_lite_viewer_store__.getState(); return { models: [...s.models.values()].map(m => ({ id: m.id, name: m.name, fingerprint: m.sourceFingerprint, entities: m.ifcDataStore?.entityCount })), activeModelId: s.activeModelId, library: s.manualLibrary, reports: s.savedValidationReports }; });
    cohort.states.push({ label, state }); return state;
   };
   const shot = async label => { const path = out + '/' + count + '-' + label + '.png'; await page.screenshot({ path }); facts.artifacts.push(artifact(path)); };
   await page.goto('http://127.0.0.1:' + port); await waitStore(); await loadModels();
   cohort.initialSource = await page.evaluate(() => {
    const s = __ifc_lite_viewer_store__.getState(); const source = [...s.models.values()].find(m => m.name === 'building-architecture.ifc');
    if (!source?.sourceFingerprint || !source.ifcDataStore || source.ifcDataStore.entityCount < 400) throw Error('Real source model was not decoded');
    s.setActiveModel(source.id);
    s.setManualChecklist({ version: 1, name: 'Delivery reuse ' + s.models.size, groups: [{ id: 'delivery', name: 'Delivery', items: [{ id: 'uploaded', text: 'Uploaded on time', description: 'Check the recorded delivery.' }, { id: 'names', text: 'Naming convention' }, { id: 'followup', text: 'Follow-up note' }] }] });
    s.setManualAnswer(source.sourceFingerprint, 'uploaded', { status: 'pass' });
    s.setManualAnswer(source.sourceFingerprint, 'names', { status: 'warning', comment: 'Recorded prefix needs review' });
    s.setManualAnswer(source.sourceFingerprint, 'followup', { status: null, comment: 'Unanswered note must survive' });
    return { id: source.id, fingerprint: source.sourceFingerprint };
   });
   await openValidation(); await page.getByRole('button', { name: 'Save report', exact: true }).click();
   const initial = await observe('original-saved'); assert.equal(initial.reports.length, 1);
   const original = JSON.stringify(initial.reports[0]); const originalId = initial.reports[0].id; cohort.originalReportSha256 = hash(original);
   await page.locator('[data-testid="manual-check"]').filter({ hasText: 'Naming convention' }).waitFor(); await shot('original'); await page.getByRole('button', { name: 'Delete checklist', exact: true }).click();
   await page.reload(); await waitStore(); await openValidation();
   await page.locator('[data-saved-validation-reports] summary').click();
   await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Edit a copy' && b.disabled));
   const reopened = await observe('history-only-reload'); assert.equal(reopened.library.checklists.length, 0); assert.equal(JSON.stringify(reopened.reports[0]), original);
   await loadModels(); await openValidation();
   const models = await page.evaluate(() => [...__ifc_lite_viewer_store__.getState().models.values()].map(m => ({ id: m.id, name: m.name, fingerprint: m.sourceFingerprint })));
   const source = models.find(m => m.fingerprint === cohort.initialSource.fingerprint); assert.ok(source); assert.notEqual(source.id, cohort.initialSource.id);
   if (count === 2) { const peer = models.find(m => m.id !== source.id); assert.ok(peer); await page.evaluate(id => __ifc_lite_viewer_store__.getState().setActiveModel(id), peer.id); cohort.preRecoveryPeer = { id: peer.id, method: 'Canonical setActiveModel action as declared active-peer precondition; loadDemoRevB itself retains original active model.' }; assert.equal(await page.evaluate(() => __ifc_lite_viewer_store__.getState().activeModelId), peer.id); }
   await page.getByRole('button', { name: 'Edit a copy', exact: true }).click();
   await page.getByLabel('Comment on Naming convention', { exact: true }).waitFor();
   assert.equal(await page.getByLabel('Comment on Naming convention', { exact: true }).inputValue(), 'Recorded prefix needs review');
   if (count === 2) assert.equal(await page.getByLabel('Model', { exact: true }).inputValue(), source.id);
   await observe('editable-copy');
   await page.getByLabel('Comment on Naming convention', { exact: true }).fill('Edited current copy');
   await page.locator('[data-testid="manual-check"]').filter({ hasText: 'Naming convention' }).getByRole('button', { name: 'Pass', exact: true }).click();
   await page.getByRole('button', { name: 'Save report', exact: true }).click();
   const edited = await observe('edited-copy-saved'); assert.equal(JSON.stringify(edited.reports.find(r => r.id === originalId)), original); assert.equal(edited.reports.length, 2);
   const newReport = edited.reports.find(r => r.id !== originalId); assert.equal(newReport.snapshot.modelFingerprint, source.fingerprint); assert.equal(newReport.snapshot.groups[0].items[1].status, 'pass'); assert.equal(newReport.snapshot.groups[0].items[1].comment, 'Edited current copy'); assert.equal(newReport.snapshot.groups[0].items[2].status, null); assert.equal(newReport.snapshot.groups[0].items[2].comment, 'Unanswered note must survive');
   await shot('edited-copy');
   await page.evaluate(async count => { const { DOCUMENT_VERSION } = await import('/src/lib/document/types.ts'); const s = __ifc_lite_viewer_store__.getState(); s.upsertDocument({ version: DOCUMENT_VERSION, id: 'reuse-proof-' + count, name: 'Saved manual reuse proof ' + count, page: { size: 'A4', orientation: 'portrait' }, blocks: [] }); s.setActiveDocumentId('reuse-proof-' + count); s.floatPanel('document'); s.setFloatingPanelRect('document', { x: 20, y: 65, w: 1470, h: 950 }); }, count);
   await page.getByTitle('Add a block to the page', { exact: true }).click(); await page.getByRole('menuitem', { name: 'Validation report', exact: true }).click();
   for (const [label, id] of [['original', originalId], ['edited', newReport.id]]) {
    await page.getByLabel('Saved report source', { exact: true }).selectOption(id);
    await page.waitForFunction(id => __ifc_lite_viewer_store__.getState().documents.find(d => d.id === __ifc_lite_viewer_store__.getState().activeDocumentId)?.blocks[0]?.savedReportId === id, id);
    const pdfEvent = page.waitForEvent('download', { timeout: 60000 }); await page.getByRole('button', { name: 'Export PDF', exact: true }).click(); const download = await pdfEvent; const path = out + '/' + count + '-' + label + '.pdf'; await download.saveAs(path); assert.equal(await download.failure(), null); facts.artifacts.push(artifact(path));
    await shot(label + '-pdf-preview');
    cohort.states.push({ label: label + '-pdf-preview', preview: await page.locator('[data-document-preview] [data-block-manual-report]').textContent() });
   }
   cohort.runtime = [];
   for (const url of new Set(runtimeResponses.map(r => r.url))) { const response = await context.request.get(url); const bytes = await response.body(); assert.equal(response.status(), 200); cohort.runtime.push({ url, observedStatuses: runtimeResponses.filter(r => r.url === url).map(r => r.status), witnessStatus: response.status(), bytes: bytes.length, sha256: hash(bytes), scope: 'Separate served-resource byte witness after user operations, not original worker response body; no timing measurement.' }); }
   assert.ok(cohort.runtime.length); cohort.chrome = await context.browser()?.version();
  } catch (error) { if (page) await page.screenshot({ path: out + '/' + count + '-failure.png' }); fs.writeFileSync(out + '/failed-attempt.json', JSON.stringify({ facts, message: String(error) }, null, 2)); throw error; }
  finally { await context.close(); }
 }
 facts.inputs = ['building-architecture.ifc', 'building-architecture-rev-b.ifc'].map(name => ({ name, bytes: fs.statSync(wt + '/apps/viewer/public/samples/' + name).size, sha256: hash(fs.readFileSync(wt + '/apps/viewer/public/samples/' + name)) }));
 fs.writeFileSync(out + '/facts.json', JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify({ source: facts.source, artifacts: facts.artifacts.length, cohorts: facts.cohorts.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
