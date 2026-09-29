/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Browser evidence for #6232 M2.5 (Model inspector): every inspector edit is ONE Ctrl+Z.
// Run from the repository root against `vite --port 5437` in apps/viewer, with
// tests/models/ara3d/AC20-FZK-Haus.ifc served as /_fixtures/AC20-FZK-Haus.ifc.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const out = process.env.PROOF_OUT ?? '/tmp/m25-proof';
fs.mkdirSync(out, { recursive: true });
const base = process.env.PROOF_URL ?? 'http://127.0.0.1:5437/';
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(60000);
const log = [];
const note = (m) => { console.log(m); log.push(m); };
page.on('console', (m) => { if (m.type() === 'error') log.push('console.error: ' + m.text().slice(0, 300)); });
const shot = async (name) => { await page.waitForTimeout(600); await page.screenshot({ path: `${out}/${name}.png` }); note(`screenshot ${name}.png`); };
const st = (fn, arg) => page.evaluate(fn, arg);
try {
  await page.goto(base + '?model=/_fixtures/AC20-FZK-Haus.ifc');
  await page.waitForFunction(async () => {
    window.__s ??= (await import('/src/store/index.ts')).useViewerStore;
    const s = window.__s.getState();
    return s.models.size === 1 && [...s.models.values()][0].loadState === 'complete';
  }, null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  // Probe helpers, evaluated in the page.
  await st(async () => {
    const k = await import('/src/lib/commands/modeling/authored-kinds.ts');
    window.__probe = (id) => {
      const s = window.__s.getState(); const m = [...s.models.values()][0];
      const live = { dataStore: m.ifcDataStore, view: s.mutationViews.get(m.id) };
      const t = k.typeOf(live, id); const ls = k.layerSetOf(live, id); const w = s.readWallEndpoints(m.id, id);
      return { name: k.entityName(live, id), type: t === null ? null : k.entityName(live, t), layers: ls ? ls.layers.map((l) => [l.materialId === null ? null : k.entityName(live, l.materialId), +l.thickness.toFixed(3)]) : null, thickness: w ? +w.thickness.toFixed(3) : null, meshes: (m.geometryResult?.meshes ?? []).filter((x) => x.expressId === s.toGlobalId(m.id, id) || x.expressId === id).reduce((n, x) => n + x.indices.length / 3, 0), undo: s.undoStacks.get(m.id)?.length ?? 0 };
    };
  });
  const modelId = await st(() => [...window.__s.getState().models.keys()][0]);
  note('model ' + modelId);
  // Edit mode and the Model workspace.
  await st(() => { const s = window.__s.getState(); s.setEditEnabled?.(true); window.__s.setState({ editEnabled: true }); return s.enterModelWorkspace(); });
  // A wall authored on the real model through the Wall command's own builder (rectangle profile, so its size is editable).
  const wall = await st(() => {
    const s = window.__s.getState(); const m = [...s.models.values()][0];
    const r = s.addWall(m.id, s.session.storeyId, { Start: [-2, -4, 0], End: [8, -4, 0], Thickness: 0.2, Height: 2.7, Name: 'Garden wall' });
    return r.expressId;
  });
  note('authored wall #' + wall);
  await st((id) => { const s = window.__s.getState(); const m = [...s.models.values()][0]; s.setSelectedEntityId(s.toGlobalId(m.id, id)); }, wall);
  await page.waitForSelector('[data-inspector-title]');
  const probe = () => st((id) => window.__probe(id), wall);
  note('initial ' + JSON.stringify(await probe()));
  await shot('01-selected-wall');

  const undoApi = async () => { await st(() => { const s = window.__s.getState(); s.undo([...s.models.keys()][0]); }); await page.waitForTimeout(500); };
  const step = async (label, edit, file) => {
    const before = await probe();
    await edit();
    await page.waitForTimeout(700);
    const after = await probe();
    await shot(file + '-after');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(700);
    let undone = await probe();
    let via = 'Ctrl+Z';
    if (undone.undo !== before.undo) { await undoApi(); undone = await probe(); via = 'store.undo'; }
    await shot(file + '-undone');
    note(`${label}: before ${JSON.stringify(before)}\n   after ${JSON.stringify(after)}\n   after ONE undo (${via}) ${JSON.stringify(undone)}`);
  };

  await step('NAME', async () => {
    const f = page.locator('[data-model-inspector] input').first();
    await f.fill('Garden wall — north');
    await f.press('Enter');
  }, '02-name');

  await step('TYPE (New type…)', async () => {
    await page.locator('[data-inspector-type]').click();
    await page.getByRole('option', { name: 'New type…' }).click();
    await page.getByLabel('Type name').fill('WT Brick 250');
    await page.getByRole('button', { name: 'Create' }).click();
  }, '03-type');

  await step('DIMENSION (thickness)', async () => {
    const f = page.getByLabel('Thickness in metres', { exact: true });
    await f.fill('0.35');
    await f.press('Enter');
  }, '04-thickness');

  await step('MATERIAL LAYERS', async () => {
    const t1 = page.getByLabel('Layer 1 thickness in metres');
    await t1.fill('0.115');
    await page.getByLabel('Layer 1 material').click();
    await page.getByRole('option', { name: 'New material…' }).click();
    await page.getByLabel('Material name').fill('Brick');
    await page.getByRole('button', { name: 'Layer', exact: true }).click();
    await page.getByLabel('Layer 2 thickness in metres').fill('0.12');
    await page.getByLabel('Layer 2 material').click();
    await page.getByRole('option', { name: 'New material…' }).click();
    await page.getByLabel('Material name').nth(1).fill('Mineral wool');
    await page.locator('[data-inspector-apply-layers]').click();
  }, '05-layers');

  // A wall from the file (ArchiCAD, IfcArbitraryClosedProfileDef): its existing layers read back, name and type edit.
  const fileWall = 15042;
  await st((id) => { const s = window.__s.getState(); const m = [...s.models.values()][0]; s.setSelectedEntityId(s.toGlobalId(m.id, id)); }, fileWall);
  await page.waitForTimeout(800);
  note('file wall #15042 ' + JSON.stringify(await st((id) => window.__probe(id), fileWall)));
  await shot('06-file-wall');
  const fprobe = () => st((id) => window.__probe(id), fileWall);
  const stepFile = async (label, edit, file) => {
    const before = await fprobe(); await edit(); await page.waitForTimeout(700); const after = await fprobe();
    await shot(file + '-after'); await page.keyboard.press('Control+z'); await page.waitForTimeout(700); const undone = await fprobe();
    await shot(file + '-undone');
    note(`${label}: before ${JSON.stringify(before)}\n   after ${JSON.stringify(after)}\n   after ONE Ctrl+Z ${JSON.stringify(undone)}`);
  };
  await stepFile('FILE WALL NAME', async () => { const f = page.locator('[data-model-inspector] input').first(); await f.fill('Wand-Int-ERDG-4 (renamed)'); await f.press('Enter'); }, '07-file-name');
  await stepFile('FILE WALL TYPE -> No type', async () => { await page.locator('[data-inspector-type]').click(); await page.getByRole('option', { name: 'No type' }).click(); }, '08-file-type');
} catch (e) {
  note('FAILED ' + (e?.stack ?? e));
  await page.screenshot({ path: `${out}/failure.png` });
} finally {
  fs.writeFileSync(`${out}/log.txt`, log.join('\n'));
  await browser.close();
}
