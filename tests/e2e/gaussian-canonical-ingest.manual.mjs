/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8565: canonical Gaussian ingestion in the real production viewer bundle.
// Build with VITE_GAUSSIAN_SPLATS=internal-unqualified, serve apps/viewer/dist
// with the capture under /_fixtures/, then run under ifc-gpu-check. The capture
// enters through `?model=` -> useIfcLoader.loadFile and the production decoder
// worker chunk. Frames are renderer-owned readbacks with an unchanged camera:
// the hidden frame is the reference for the splat contribution. Internal,
// unqualified evidence only: not a timing, hardware-budget or release witness.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.env.GAUSSIAN_BASE ?? 'http://127.0.0.1:5291';
const capture = process.env.GAUSSIAN_CAPTURE ?? '/_fixtures/seem-kirke-v1.ply';
const placement = process.env.GAUSSIAN_PLACEMENT ?? 'rx180';
const out = process.env.GAUSSIAN_EVIDENCE ?? '/tmp/gaussian-8565-browser';
await mkdir(out, { recursive: true });
const browser = process.env.IFC_GPU_CDP_URL
  ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)
  : await chromium.launch({ headless: true, args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
    '--use-angle=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
const gpuConsole = [];
const workers = { started: [], closed: [] };
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error' && /gpu|webgpu|gaussian|validation|device lost/i.test(message.text())) gpuConsole.push(message.text());
});
page.on('worker', worker => {
  workers.started.push(worker.url());
  worker.on('close', () => workers.closed.push(worker.url()));
});
const result = { base, capture, placement, errors, gpuConsole, workers, checks: {} };

const visibility = (id, visible) => page.evaluate(({ id, visible }) =>
  globalThis.__ifc_lite_viewer_store__.getState().setModelVisibility(id, visible), { id, visible });
const stats = () => page.evaluate(() => {
  const s = globalThis.__ifc_lite_render_stats__?.();
  return s ? { adapter: s.adapter, gaussian: s.gaussianSplats } : null;
});
/** Store one renderer-owned frame in the page under `label`. */
const frame = (label) => page.evaluate(async (label) => {
  const url = await globalThis.__ifc_lite_capture_color_frame__?.();
  if (!url) return null;
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  (globalThis.__witnessFrames ??= {})[label] = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  return { width: bitmap.width, height: bitmap.height };
}, label);
/** Pixel comparisons between stored frames, done in the page. */
const compare = (a, b, outside) => page.evaluate(({ a, b, outside }) => {
  const f = globalThis.__witnessFrames, x = f[a], y = f[b];
  const differs = (p, q, i) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 6;
  let differing = 0, escaped = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (differs(x, y, i)) {
      differing++;
      // `outside`: [frame, reference] whose equal pixels are outside the contribution.
      if (outside && !differs(f[outside[0]], f[outside[1]], i)) escaped++;
    }
  }
  return { differing, escaped, total: x.length / 4 };
}, { a, b, outside });
const drawn = async (label, previous) => {
  for (let i = 0; i < 50; i++) {
    const s = await stats();
    if ((s?.gaussian?.drawnFrames ?? 0) > previous) return s;
    await page.waitForTimeout(100);
  }
  throw new Error(`${label}: no new Gaussian pass was drawn`);
};

try {
  await page.goto(`${base}/?model=${encodeURIComponent(capture)}${placement ? `&gaussianPlacement=${placement}` : ''}`);
  await page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__);
  const outcome = await page.evaluate(() => new Promise((resolve) => {
    const store = globalThis.__ifc_lite_viewer_store__;
    const phases = [];
    const started = performance.now();
    const tick = () => {
      const state = store.getState();
      const phase = state.progress?.phase;
      if (phase && phases.at(-1) !== phase) phases.push(phase);
      const models = [...state.models.values()];
      const model = models.find(m => m.gaussianSplat);
      if (models.some(m => m.loadState === 'error') || (state.error && !state.loading)) {
        resolve({ ok: false, error: String(state.error ?? models.map(m => m.loadError).join(', ')), phases });
      } else if (model && (model.loadState ?? 'complete') === 'complete' && !state.loading) {
        globalThis.__witnessHandle = model.gaussianSplat.handle;
        const { handle, ...record } = model.gaussianSplat;
        resolve({ ok: true, phases, id: model.id, name: model.name, loadPath: model.loadPath, loadFormat: model.loadFormat,
          handle: { ...handle }, frozen: Object.isFrozen(handle), record: { ...record, placement: [...record.placement] },
          entityCount: model.ifcDataStore?.entityCount ?? 0, models: models.length });
      } else if (performance.now() - started > 300_000) resolve({ ok: false, error: 'timeout', phases });
      else setTimeout(tick, 20);
    };
    tick();
  }));
  result.load = outcome;
  assert.equal(outcome.ok, true, `canonical load failed: ${outcome.error}; page errors: ${errors.join('; ')}`);
  assert.deepEqual(outcome.phases.slice(-3), ['Decoding Gaussian PLY capture', 'Uploading Gaussian capture', 'Complete']);
  assert.equal(outcome.loadPath, 'gaussian');
  assert.equal(outcome.frozen, true, 'the renderer-issued handle itself is on the model');
  assert.equal(outcome.entityCount, 0, 'no IFC entity is invented for a capture');
  assert.equal(outcome.record.calibration, 'uncalibrated');
  assert.equal(outcome.record.placementOrigin, placement ? 'explicit' : 'source');
  const decoder = workers.started.filter(url => /gaussianDecode\.worker/.test(url));
  assert.equal(decoder.length, 1, `one production decoder worker chunk ran: ${workers.started.join(', ')}`);

  const first = await drawn('resident', 0);
  const state = await page.evaluate(() => globalThis.__ifc_lite_gaussian_handle_state__?.(globalThis.__witnessHandle));
  result.checks.resident = { stats: first, state };
  assert.deepEqual(state, { state: 'resident' }, 'uploaded on the current device generation');
  assert.equal(first.gaussian.assets, 1);
  assert.equal(first.gaussian.splats, outcome.record.count);
  assert.ok(first.gaussian.gpuBytes > 0);

  await frame('visible');
  await page.screenshot({ path: `${out}/01-loaded.png` });
  await visibility(outcome.id, false);
  const hidden = await drawn('hidden', first.gaussian.drawnFrames).catch(async () => stats());
  await frame('hidden');
  await visibility(outcome.id, true);
  const shown = await drawn('shown', hidden?.gaussian?.drawnFrames ?? 0);
  await frame('shown');
  const contribution = await compare('visible', 'hidden');
  const restored = await compare('visible', 'shown');
  result.checks.hideShow = { hidden: hidden?.gaussian, shown: shown.gaussian, contribution, restored };
  assert.equal(hidden?.gaussian?.visibleAssetSplats, 0);
  assert.ok(contribution.differing > contribution.total * 0.02, 'the splat pass contributes pixels beyond the background');
  assert.equal(restored.differing, 0, 'show restores the exact reference frame');

  // Disclosed centre clipping: a vertical plane through the placed capture's centre.
  const plane = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const record = [...state.models.values()].find(m => m.gaussianSplat).gaussianSplat;
    const { min, max } = record.sourceCenterBounds, m = record.placement;
    const c = [0, 1, 2].map(i => (min[i] + max[i]) / 2);
    const point = [0, 1, 2].map(r => m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2] + m[12 + r]);
    state.setSectionPlaneFromFace([1, 0, 0], point);
    return point;
  });
  const clippedStats = await drawn('clipped', shown.gaussian.drawnFrames);
  await frame('clipped');
  await page.screenshot({ path: `${out}/02-centre-clipped.png` });
  // The plane draws its own gizmo/outline: the clipped contribution is taken
  // against the same plane with the capture hidden, then must lie inside the
  // unclipped contribution (visible vs hidden without the plane).
  await visibility(outcome.id, false);
  await page.waitForTimeout(300);
  await frame('clippedHidden');
  await visibility(outcome.id, true);
  await drawn('clipped-again', clippedStats.gaussian.drawnFrames);
  const kept = await compare('clipped', 'clippedHidden', ['visible', 'hidden']);
  result.checks.centreClip = { plane, kept, unclipped: contribution };
  assert.ok(kept.differing > 0, 'the kept side still contributes');
  assert.ok(kept.differing < contribution.differing, 'the plane culls part of the capture');
  assert.equal(kept.escaped, 0, 'clipping never draws outside the unclipped contribution');
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setSectionPlaneEnabled(false));
  const unclipped = await drawn('unclipped', (await stats()).gaussian.drawnFrames);

  await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().removeModel(id), outcome.id);
  await page.waitForTimeout(300);
  await frame('removed');
  const removed = await stats();
  const baseline = await compare('removed', 'hidden');
  const handleAfter = await page.evaluate(() => globalThis.__ifc_lite_gaussian_handle_state__?.(globalThis.__witnessHandle));
  result.checks.removed = { stats: removed, baseline, handleAfter, unclipped: unclipped.gaussian };
  assert.equal(removed.gaussian.assets, 0, 'removal frees the renderer asset');
  assert.equal(removed.gaussian.gpuBytes, 0);
  assert.deepEqual(handleAfter, { state: 'invalid' }, 'no surviving handle');
  assert.equal(baseline.differing, 0, 'the frame returns to the capture-free reference');
  assert.ok(decoder.every(url => workers.closed.includes(url)), 'the decoder worker ended with its request');
  await page.screenshot({ path: `${out}/03-removed.png` });
  assert.deepEqual(errors, [], `uncaught page errors: ${errors.join('; ')}`);
  assert.deepEqual(gpuConsole, [], `GPU errors: ${gpuConsole.join('; ')}`);
  result.verdict = 'pass';
} catch (error) {
  result.verdict = 'fail';
  result.failure = String(error?.stack ?? error);
  throw error;
} finally {
  await writeFile(`${out}/result.json`, JSON.stringify(result, null, 2));
  await context.close();
  await browser.close();
}
