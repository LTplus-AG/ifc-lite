/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const fs = require('node:fs'), cp = require('node:child_process');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const [wt, out, port] = process.argv.slice(2);
if (!wt || !out || !port) throw Error('Pass owned worktree, output directory and port');
const { chromium } = require(wt + '/node_modules/@playwright/test');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const samples = wt + '/apps/viewer/public/samples/';
const xml = fs.readFileSync(samples + 'building-architecture.ids', 'utf8');
const rule = name => ({ version: 1, name, rules: [{ id: 'wall-name', name: 'Wall name',
  applicability: { groups: [{ rules: [{ kind: 'ifcType', values: ['IfcWall'], op: 'in' }], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [{ kind: 'attribute', name: 'Name', op: 'isSet', value: '' }], combinator: 'AND' }], authoredAs: 'chips' } },
}] });
fs.mkdirSync(out, { recursive: true });
const facts = { source: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim(),
  capturedAt: new Date().toISOString(), cohorts: [], artifacts: [], errors: [],
  route: 'Real SketchUp IFC primary file input; declared canonical loadDemoRevB for N. Check sources imported through actual file inputs. UI selection/copy/edit/delete/run/save/download and same-profile reload.',
  limits: 'Own-profile Linux Chrome with software WebGPU. Functional UI/data evidence, no hardware 3D or performance claim. Generated rule inputs and quota XML derivative are declared.' };
const artifact = path => ({ path: path.split('/').at(-1), bytes: fs.statSync(path).size, sha256: hash(fs.readFileSync(path)) });
(async () => {
  for (const count of [1, 2]) {
    const context = await chromium.launchPersistentContext(out + '-' + count + '-profile', {
      executablePath: '/usr/bin/google-chrome', headless: true, viewport: { width: 1520, height: 1040 },
      acceptDownloads: true, args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader'],
    });
    const cohort = { count, states: [], downloads: [] }; facts.cohorts.push(cohort);
    let page; const responses = [];
    try {
      page = await context.newPage();
      page.on('console', message => { if (message.type() === 'error') facts.errors.push({ count, type: 'console', message: message.text().slice(0, 1200) }); });
      page.on('pageerror', error => facts.errors.push({ count, type: 'pageerror', message: error.message }));
      page.on('response', response => { if (response.url().includes('ifc-lite_bg') && response.url().includes('.wasm')) responses.push({ url: response.url(), status: response.status() }); });
      const storeReady = () => page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__);
      const open = () => page.evaluate(() => {
        const s = __ifc_lite_viewer_store__.getState(); s.floatPanel('validation');
        s.setFloatingPanelRect('validation', { x: 20, y: 65, w: 1470, h: 950 });
      });
      const loadModels = async () => {
        await page.locator('input[type=file][accept^=".ifc"]').first().setInputFiles(samples + 'building-architecture.ifc');
        await page.waitForFunction(() => { const s = __ifc_lite_viewer_store__.getState(); return [...s.models.values()].some(m => m.ifcDataStore && m.sourceFingerprint) && !s.isLoading; }, null, { timeout: 90000 });
        if (count === 2) {
          await page.evaluate(async () => { const { loadDemoRevB } = await import('/src/lib/tours/demo-kit.ts'); await loadDemoRevB(); });
          await page.waitForFunction(() => { const s = __ifc_lite_viewer_store__.getState(); return [...s.models.values()].filter(m => m.ifcDataStore && m.sourceFingerprint).length === 2 && !s.isLoading; }, null, { timeout: 90000 });
        }
      };
      const observe = async label => {
        const state = await page.evaluate(() => {
          const s = __ifc_lite_viewer_store__.getState();
          return { models: [...s.models.values()].map(m => ({ id: m.id, name: m.name, fingerprint: m.sourceFingerprint, entities: m.ifcDataStore?.entityCount })),
            library: s.validationDefinitions, error: s.validationDefinitionsError,
            report: s.idsValidationReport, saved: s.savedValidationReports };
        });
        cohort.states.push({ label, state }); return state;
      };
      const active = (state, kind) => state.library.entries.find(entry => entry.id === state.library.active[kind]);
      const shot = async label => { const path = out + '/' + count + '-' + label + '.png'; await page.screenshot({ path }); facts.artifacts.push(artifact(path)); };
      const importFile = async (kind, text, name) => {
        const before = await page.evaluate(() => __ifc_lite_viewer_store__.getState().validationDefinitions.entries.length);
        await page.locator(kind === 'rules' ? 'input[accept=".rules.json,.json"]' : 'input[accept=".ids,.xml"]').first()
          .setInputFiles({ name, mimeType: kind === 'rules' ? 'application/json' : 'application/xml', buffer: Buffer.from(text) });
        await page.waitForFunction(before => { const s = __ifc_lite_viewer_store__.getState(); return s.validationDefinitions.entries.length === before + 1 && !s.idsAuditing && !s.idsLoading; }, before, { timeout: 60000 });
      };
      const runSave = async kind => {
        await page.getByRole('button', { name: kind === 'rules' ? 'Run' : 'Run Validation', exact: true }).click();
        await page.waitForFunction(kind => { const s = __ifc_lite_viewer_store__.getState(); return s.idsValidationReport?.source.kind === kind && !s.idsLoading; }, kind, { timeout: 60000 });
        await page.getByRole('button', { name: 'Save report', exact: true }).click();
      };
      const download = async (button, name) => {
        const event = page.waitForEvent('download'); await page.getByRole('button', { name: button, exact: true }).click();
        const saved = await event, path = out + '/' + count + '-' + name;
        await saved.saveAs(path); assert.equal(await saved.failure(), null);
        const data = fs.readFileSync(path); const record = artifact(path); facts.artifacts.push(record); cohort.downloads.push(record); return data;
      };
      await page.goto('http://127.0.0.1:' + port); await storeReady(); await loadModels(); await open();
      await importFile('rules', JSON.stringify(rule('Wall name check')), 'wall.rules.json');
      await runSave('rules');
      let state = await observe('rules-original-saved'); const firstRules = active(state, 'rules'); assert.ok(firstRules);
      const savedRules = JSON.stringify(state.saved), rulesBytes = JSON.stringify(firstRules);
      await importFile('rules', JSON.stringify(rule('Independent name check')), 'second.rules.json');
      await page.getByLabel('Select rule set', { exact: true }).selectOption(firstRules.id);
      await page.getByRole('button', { name: 'New from this check', exact: true }).click();
      await page.getByLabel('Rule set name', { exact: true }).fill('Edited independent copy');
      state = await observe('rules-copy-edited');
      assert.notEqual(active(state, 'rules').id, firstRules.id);
      assert.equal(JSON.stringify(state.library.entries.find(entry => entry.id === firstRules.id)), rulesBytes);
      assert.equal(JSON.stringify(state.saved), savedRules); assert.equal(state.report, null); await shot('rules-copy-edited');
      await page.getByRole('button', { name: 'Delete check', exact: true }).click();
      state = await observe('rules-copy-deleted'); assert.equal(active(state, 'rules').id, firstRules.id);
      const rulesDownload = await download('Save', 'wall.rules.json');
      const parsed = await page.evaluate(async raw => { const { importRuleSetFile } = await import('/src/lib/validation/rule-set-io-browser.ts'); return importRuleSetFile(new File([raw], 'download.rules.json')); }, rulesDownload.toString('utf8'));
      assert.ok(parsed.ok); assert.deepEqual(parsed.file, firstRules.file);
      await page.getByRole('tab', { name: 'IDS validation', exact: true }).click();
      await importFile('ids', xml, 'original.ids'); await runSave('ids');
      state = await observe('ids-original-saved'); const firstIds = active(state, 'ids'); assert.ok(firstIds);
      const savedAll = JSON.stringify(state.saved), idsBytes = JSON.stringify(firstIds);
      await importFile('ids', xml.replace('Building Architecture IDS', 'Independent delivery IDS'), 'second.ids');
      await page.getByRole('button', { name: 'New from this check', exact: true }).click();
      state = await observe('ids-copy'); assert.equal(active(state, 'ids').xml, xml.replace('Building Architecture IDS', 'Independent delivery IDS'));
      assert.equal(JSON.stringify(state.library.entries.find(entry => entry.id === firstIds.id)), idsBytes);
      assert.equal(JSON.stringify(state.saved), savedAll); assert.equal(state.report, null);
      await page.getByRole('button', { name: 'Delete check', exact: true }).click();
      await page.getByLabel('Select IDS document', { exact: true }).selectOption(firstIds.id);
      await page.waitForFunction(() => !__ifc_lite_viewer_store__.getState().idsAuditing);
      assert.equal(hash(await download('Download IDS', 'original.ids')), hash(Buffer.from(xml))); await shot('ids-selected');
      await page.reload(); await storeReady(); await open();
      await page.getByLabel('Select IDS document', { exact: true }).waitFor();
      state = await observe('persisted-reload');
      assert.equal(state.library.active.ids, firstIds.id); assert.equal(state.library.active.rules, firstRules.id);
      assert.equal(state.library.entries.length, 4); assert.equal(JSON.stringify(state.saved), savedAll);
      assert.equal(active(state, 'ids').xml, xml); await shot('persisted-reload');
      await loadModels(); await open();
      state = await observe('reloaded-real-models'); assert.equal(state.models.length, count); assert.equal(JSON.stringify(state.saved), savedAll);
      if (count === 2) {
        const persisted = await page.evaluate(() => localStorage.getItem('ifc-lite:validation:definition-library'));
        const padded = xml.replace('Building Architecture IDS', 'Declared quota control') + '\n<!--' + 'p'.repeat(6 * 1024 * 1024) + '-->\n';
        cohort.quotaInput = { scope: 'Declared generated derivative: original valid XML plus renamed title and a 6 MiB XML comment. Actual browser quota, not a simulated exception.', bytes: Buffer.byteLength(padded), sha256: hash(Buffer.from(padded)) };
        await importFile('ids', padded, 'quota-control.ids');
        const warning = await page.evaluate(() => __ifc_lite_viewer_store__.getState().validationDefinitionsError);
        assert.match(warning ?? '', /could not be saved.*quota/i);
        assert.ok(await page.getByRole('alert').filter({ hasText: warning }).count());
        assert.equal(await page.evaluate(() => localStorage.getItem('ifc-lite:validation:definition-library')), persisted);
        assert.equal(hash(await download('Download IDS', 'quota-control.ids')), hash(Buffer.from(padded)));
        cohort.quotaWarning = warning; await shot('quota-warning');
        await page.reload(); await storeReady(); await open();
        await page.getByLabel('Select IDS document', { exact: true }).waitFor();
        state = await observe('quota-reload-preserves-prior-source'); assert.equal(state.library.entries.length, 4);
        assert.equal(state.library.active.ids, firstIds.id); assert.equal(JSON.stringify(state.saved), savedAll);
      }
      cohort.runtime = [];
      for (const url of new Set(responses.map(response => response.url))) {
        const response = await context.request.get(url), bytes = await response.body(); assert.equal(response.status(), 200);
        cohort.runtime.push({ url, observedStatuses: responses.filter(row => row.url === url).map(row => row.status), witnessStatus: response.status(), bytes: bytes.length, sha256: hash(bytes), scope: 'Separate served-resource byte witness after all user operations; no timing boundary or original worker-body claim.' });
      }
      assert.ok(cohort.runtime.length); cohort.chrome = await context.browser()?.version();
    } catch (error) {
      if (page) await page.screenshot({ path: out + '/' + count + '-failure.png' });
      fs.writeFileSync(out + '/failed-attempt.json', JSON.stringify({ facts, message: String(error) }, null, 2)); throw error;
    } finally { await context.close(); }
  }
  facts.inputs = ['building-architecture.ifc', 'building-architecture-rev-b.ifc', 'building-architecture.ids'].map(name => ({ name, bytes: fs.statSync(samples + name).size, sha256: hash(fs.readFileSync(samples + name)) }));
  fs.writeFileSync(out + '/facts.json', JSON.stringify(facts, null, 2) + '\n'); console.log(JSON.stringify({ source: facts.source, cohorts: facts.cohorts.length, artifacts: facts.artifacts.length }));
})().catch(error => { console.error(error); process.exitCode = 1; });
