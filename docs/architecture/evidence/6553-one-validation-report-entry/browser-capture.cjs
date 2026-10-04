/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// node browser-capture.cjs <worktree> <out dir> <dev server port>
// Drives the real viewer (Vite dev server, bundled Chromium) through the Documentation tab's Add block menu
// and the block's source picker, with one saved report of each kind and both live sources present.
const fs = require('node:fs');
const [wt, out, port] = process.argv.slice(2);
if (!wt || !out || !port) throw Error('Pass worktree, output directory and server port');
const { chromium } = require(wt + '/node_modules/@playwright/test');
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1520, height: 1040 } });
  const facts = { errors: [] };
  page.on('pageerror', (err) => facts.errors.push(err.message));
  await page.goto('http://127.0.0.1:' + port);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__);
  await page.evaluate(async () => {
    const { DOCUMENT_VERSION } = await import('/src/lib/document/types.ts');
    const s = __ifc_lite_viewer_store__.getState();
    const ids = { kind: 'ids-report', id: 's-ids', sourceKind: 'ids', sourceName: 'Design IDS', generatedAt: '2026-01-15T10:00:00.000Z', summary: { checked: 4, passed: 1, failed: 3, passRate: 25 }, checks: [{ id: 'a', shortDescription: 'Walls', checked: 4, passed: 1, failed: 3, passRate: 25, rules: [] }] };
    const rules = { kind: 'ids-report', id: 's-rules', sourceKind: 'rules', sourceName: 'Delivery rules', generatedAt: '2026-01-16T10:00:00.000Z', summary: { checked: 2, passed: 2, failed: 0, passRate: 100 }, checks: [{ id: 'b', shortDescription: 'Unique names', checked: 2, passed: 2, failed: 0, passRate: 100, rules: [] }] };
    const manual = { kind: 'manual-report', id: 's-manual', checklistName: 'Site review', generatedAt: '2026-01-17T10:00:00.000Z', summary: { total: 1, pass: 1, fail: 0, warning: 0, unanswered: 0 }, groups: [{ id: 'g', name: 'Delivery', counts: { total: 1, pass: 1, fail: 0, warning: 0, unanswered: 0 }, items: [{ id: 'i', text: 'Uploaded on time', status: 'pass' }] }] };
    for (const [snapshot, name] of [[ids, 'Saved IDS'], [rules, 'Saved information validation'], [manual, 'Saved manual']]) {
      const id = await s.saveValidationReport(snapshot, name);
      if (!id || __ifc_lite_viewer_store__.getState().validationReportsStorage.items[id] !== 'saved') throw Error('Evidence report was not committed');
    }
    s.setManualChecklist({ version: 1, name: 'Site review', groups: [{ id: 'g', name: 'Delivery', items: [{ id: 'i', text: 'Uploaded on time' }] }] });
    __ifc_lite_viewer_store__.setState({ idsValidationReport: { source: { kind: 'ids', document: { info: { title: 'Current IDS run' }, specifications: [] } }, modelInfo: [], timestamp: new Date(), summary: { totalSpecifications: 0, passedSpecifications: 0, failedSpecifications: 0, totalEntitiesChecked: 0, totalEntitiesPassed: 0, totalEntitiesFailed: 0, overallPassRate: 0 }, specificationResults: [] } });
    if (!(await s.upsertDocument({ version: DOCUMENT_VERSION, id: 'evidence', name: 'Evidence', page: { size: 'A4', orientation: 'portrait' }, blocks: [] }))) throw Error('Evidence document was not committed');
    s.setActiveDocumentId('evidence');
    s.floatPanel('document');
    s.setFloatingPanelRect('document', { x: 20, y: 65, w: 1470, h: 950 });
  });
  await page.getByTitle('Add a block to the page', { exact: true }).click();
  facts.menuItems = await page.getByRole('menuitem').allTextContents();
  await page.screenshot({ path: out + '/menu.png', clip: { x: 900, y: 60, width: 620, height: 520 } });
  await page.getByRole('menuitem', { name: 'Validation report', exact: true }).click();
  await page.waitForSelector('select[aria-label="Saved report source"]');
  facts.pickerOptions = await page.locator('select[aria-label="Saved report source"] option').allTextContents();
  facts.addedBlock = await page.evaluate(() => { const b = __ifc_lite_viewer_store__.getState().documents[0].blocks[0]; return { kind: b.kind, sourceKind: b.sourceKind, savedReportId: b.savedReportId ? 'set' : null, name: b.sourceName ?? b.checklistName }; });
  await page.screenshot({ path: out + '/block-editor.png', clip: { x: 20, y: 65, width: 520, height: 560 } });
  const picker = page.getByLabel('Saved report source', { exact: true });
  await picker.selectOption({ label: 'Current IDS validation run (live)' });
  facts.afterLive = await page.evaluate(() => { const b = __ifc_lite_viewer_store__.getState().documents[0].blocks[0]; return { kind: b.kind, savedReportId: b.savedReportId ?? null, name: b.sourceName }; });
  facts.refreshButtons = await page.getByRole('button', { name: /^Refresh/ }).allTextContents();
  await page.screenshot({ path: out + '/live-source.png', clip: { x: 20, y: 65, width: 520, height: 560 } });
  fs.writeFileSync(out + '/facts.json', JSON.stringify(facts, null, 2));
  await browser.close();
  console.log(JSON.stringify(facts, null, 2));
})().catch((err) => { console.error(err); process.exit(1); });
