/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough of the Flow panel (#5167) against a dev server.
// Not a CI test: it drives the real UI — the React Flow canvas, the run
// against the loaded model, the change set and its single undo step — and
// saves a screenshot per step plus `findings.txt`. Run, with
// `pnpm exec vite --port 5311 --strictPort` up in apps/viewer:
//   node tests/e2e/flow-walkthrough.manual.mjs
// Env: WALKTHROUGH_BASE (default http://localhost:5311), WALKTHROUGH_OUT
// (default <tmp>/ifc-lite-flow-walkthrough).
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-flow-walkthrough');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5311';
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
page.on('dialog', (d) => { log('dialog', d.type(), d.message()); void d.accept(d.type() === 'prompt' ? 'Walkthrough audit' : undefined); });
let step = 0;
const shot = async (name) => { step += 1; const p = `${OUT}/${String(step).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: p }); log('shot', p); };
const state = (expr) => page.evaluate(({ k, e }) => new Function('s', `return (${e});`)(globalThis[k].getState()), { k: STORE, e: expr });
const act = (expr) => page.evaluate(({ k, e }) => { new Function('s', `${e};`)(globalThis[k].getState()); }, { k: STORE, e: expr });

await page.goto(`${BASE}/?model=/samples/building-architecture.ifc`);
await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 60000 });
await page.waitForFunction((k) => { const s = globalThis[k].getState(); return s.models.size > 0 && !s.loading && (s.geometryResult?.meshes?.length ?? 0) > 0; }, STORE, { timeout: 120000 });
await page.waitForTimeout(3000);
log('model loaded, meshes', await state('s.geometryResult?.meshes?.length'));
await shot('model-loaded');

// 1. Open the Flow panel from the Analyze tab.
await page.getByRole('tab', { name: /analy/i }).first().click().catch(async () => { await page.getByText('Analyze', { exact: true }).first().click(); });
await page.waitForTimeout(300);
const flowBtn = page.getByRole('button', { name: /^Flow/ }).first();
await flowBtn.click();
await page.waitForTimeout(500);
if (!(await state('s.flowPanelVisible'))) note('Flow ribbon button did not open the panel');
await page.locator('[data-flow-panel]').waitFor({ timeout: 10000 });
await shot('flow-panel-open');

// 2. Import the fixture graph (the same file the CLI test runs).
const fixture = readFileSync(new URL('../../packages/cli/src/__fixtures__/flows/fire-rating-audit.flow.json', import.meta.url), 'utf-8');
await page.locator('[data-flow-panel] input[type=file]').setInputFiles({ name: 'fire-rating-audit.flow.json', mimeType: 'application/json', buffer: Buffer.from(fixture) });
await page.waitForFunction((k) => globalThis[k].getState().flowDoc?.id === 'fire-rating-audit', STORE, { timeout: 5000 });
await page.waitForTimeout(800);
const nodeCount = await page.locator('[data-flow-node]').count();
log('canvas nodes', nodeCount);
if (nodeCount !== 9) note(`expected 9 canvas nodes for the fixture, saw ${nodeCount}`);
await shot('fixture-imported');

// 3. Run it. Expect 4 walls without FireRating, one no-op-free colorize, 4 writes in the change set.
const pendingBefore = await state('[...s.undoStacks.values()].reduce((n, st) => n + st.length, 0)');
await page.getByRole('button', { name: /^Run/ }).click();
await page.waitForFunction((k) => globalThis[k].getState().flowLastRun !== null || globalThis[k].getState().flowLastError !== null, STORE, { timeout: 30000 });
await page.waitForTimeout(800);
const run = await state('({ ok: s.flowLastRun?.ok, writes: s.flowLastRun?.writes, statuses: s.flowLastRun?.reports.map(r => r.nodeId + ":" + r.status), outputs: s.flowLastRun?.graphOutputs.map(o => [o.label, o.data?.kind, o.data?.value]), error: s.flowLastError })');
log('run', JSON.stringify(run));
if (!run.ok) note(`run not ok: ${JSON.stringify(run)}`);
if (run.statuses?.some((x) => x.endsWith(':noop'))) note('a node reported noop in the browser — viewer features should be available');
const missing = run.outputs?.find((o) => o[0] === 'Walls without FireRating')?.[2];
if (missing !== 4) note(`expected 4 walls without FireRating, got ${missing}`);
// The table is built AFTER the write, so it must show what the run wrote, not the parsed nulls.
const table = run.outputs?.find((o) => o[0] === 'Wall table')?.[2];
const written = table?.rows?.map((r) => r['Pset_WallCommon.FireRating']) ?? [];
if (written.length !== 4 || written.some((v) => v !== 'REI60')) note(`the table read back ${JSON.stringify(written)} instead of the REI60 the run just wrote`);
const pendingAfter = await state('[...s.undoStacks.values()].reduce((n, st) => n + st.length, 0)');
log('undo stack', pendingBefore, '→', pendingAfter);
if (pendingAfter - pendingBefore !== 4) note(`expected 4 mutations on the undo stack, got ${pendingAfter - pendingBefore}`);
const tags = await state('new Set([...s.undoStacks.values()].flat().map(m => s.mutationBatchTags.get(m.id))).size');
if (tags !== 1) note(`expected one batch tag over the run's mutations, saw ${tags}`);
const colorized = await state('s.colorOverrides ? Object.keys(s.colorOverrides).length : (s.entityColors?.size ?? "n/a")');
log('colorized', colorized);
await shot('after-run');

// 4. Inspect a node: select the count node, check its output preview.
await page.locator('[data-flow-node="missingCount"]').click();
await page.waitForTimeout(400);
const inspectorText = await page.locator('[data-flow-inspector]').innerText();
if (!/4/.test(inspectorText)) note('inspector does not show the count output');
await shot('inspector-count');

// 5. One undo reverts the whole run.
await act('s.undo(s.activeModelId)');
await page.waitForTimeout(500);
const pendingUndone = await state('[...s.undoStacks.values()].reduce((n, st) => n + st.length, 0)');
log('after one undo', pendingUndone);
if (pendingUndone !== pendingBefore) note(`one undo should revert the whole run; undo stack is ${pendingUndone}, expected ${pendingBefore}`);
await shot('after-undo');

// 6. Add a node from the palette and connect it on the canvas by dragging handles.
await page.locator('[data-flow-palette] input').fill('count');
await page.getByRole('button', { name: /Add Count/ }).click();
await page.waitForTimeout(400);
const added = await state('s.flowDoc.nodes.at(-1)');
log('added node', JSON.stringify(added));
if (added?.type !== 'core.count') note('palette add did not create core.count');
const from = page.locator('[data-flow-node="walls"] .react-flow__handle-right').first();
const to = page.locator(`[data-flow-node="${added.id}"] .react-flow__handle-left`).first();
const a = await from.boundingBox();
const b = await to.boundingBox();
if (a && b) {
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}
const edges = await state('s.flowDoc.edges.length');
log('edges after drag-connect', edges);
if (edges !== 10) note(`drag-connect did not add an edge (edges=${edges})`);
await shot('drag-connected');

// 7. Save and export; the export is byte-comparable to a CLI document.
await page.getByRole('button', { name: /^Save/ }).click();
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /^Export/ }).click()]);
const exported = JSON.parse(readFileSync(await download.path(), 'utf-8'));
if (exported.flowVersion !== 1 || exported.nodes.length !== 10) note('export is not the edited document');
log('exported', exported.name, exported.nodes.length, 'nodes');
await shot('saved-exported');

if (errors.length) note(`console/page errors: ${errors.slice(0, 5).join(' | ')}`);
writeFileSync(join(OUT, 'findings.txt'), findings.length ? findings.join('\n') : 'no findings\n');
log(findings.length ? `${findings.length} finding(s)` : 'no findings');
await browser.close();
