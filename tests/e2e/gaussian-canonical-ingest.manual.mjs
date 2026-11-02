/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8565: canonical Gaussian ingestion in the real production viewer bundle.
// Build with VITE_GAUSSIAN_SPLATS=internal-unqualified, serve apps/viewer/dist
// with the capture under /_fixtures/, then run under ifc-gpu-check. The capture
// enters through `?model=` -> useIfcLoader.loadFile, the canonical loader, and
// is decoded by the production worker bundle. Not a timing or release witness.
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
const workers = [];
page.on('pageerror', error => errors.push(error.message));
page.on('worker', worker => workers.push(worker.url()));
const result = { base, capture, placement, errors, workers, checks: {} };

/** Renderer-owned colour readback, decoded in the page: pixels unlike the corner background. */
const splatPixels = () => page.evaluate(async () => {
  const url = await globalThis.__ifc_lite_capture_color_frame__?.();
  if (!url) return null;
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const background = data.slice(0, 3);
  let differing = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.abs(data[i] - background[0]) + Math.abs(data[i + 1] - background[1]) + Math.abs(data[i + 2] - background[2]) > 24) differing++;
  }
  return { differing, total: data.length / 4 };
});
const stats = () => page.evaluate(() => {
  const s = globalThis.__ifc_lite_render_stats__?.();
  return s ? { adapter: s.adapter, gaussian: s.gaussianSplats } : null;
});
const settle = async (label) => {
  const before = (await stats())?.gaussian?.drawnFrames ?? 0;
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.zoomIn?.());
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.zoomOut?.());
  await page.waitForTimeout(400);
  const after = await stats();
  result.checks[`${label}.frames`] = { before, after: after?.gaussian?.drawnFrames };
  return after;
};

try {
  const query = `model=${encodeURIComponent(capture)}${placement ? `&gaussianPlacement=${placement}` : ''}`;
  await page.goto(`${base}/?${query}`);
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
      } else if (model?.loadState === 'complete' && !state.loading) {
        const { handle, ...record } = model.gaussianSplat;
        resolve({ ok: true, phases, decodeToPublishMs: performance.now() - started, id: model.id, name: model.name,
          loadPath: model.loadPath, loadFormat: model.loadFormat, handle: { ...handle }, frozen: Object.isFrozen(handle),
          record: { ...record, placement: [...record.placement] }, entityCount: model.ifcDataStore?.entityCount ?? 0 });
      } else if (performance.now() - started > 300_000) resolve({ ok: false, error: 'timeout', phases });
      else setTimeout(tick, 20);
    };
    tick();
  }));
  result.load = outcome;
  assert.equal(outcome.ok, true, `canonical load failed: ${outcome.error}; page errors: ${errors.join('; ')}`);
  assert.equal(outcome.loadPath, 'gaussian');
  assert.equal(outcome.frozen, true, 'the renderer-issued handle itself is on the model');
  assert.equal(outcome.entityCount, 0, 'no IFC entity is invented for a capture');
  assert.equal(outcome.record.calibration, 'uncalibrated');
  assert.equal(outcome.record.placementOrigin, placement ? 'explicit' : 'source');
  assert.ok(workers.some(url => /gaussianDecode/.test(url)), `production decoder worker chunk ran: ${workers.join(', ')}`);

  const resident = await settle('resident');
  result.checks.resident = resident;
  assert.equal(resident?.gaussian?.assets, 1);
  assert.equal(resident.gaussian.splats, outcome.record.count);
  assert.ok(resident.gaussian.gpuBytes > 0, 'resident on the current device');
  assert.ok(resident.gaussian.drawnFrames > 0, 'the viewer frame drew the splat pass');
  const visible = await splatPixels();
  result.checks.visiblePixels = visible;
  assert.ok(visible && visible.differing > visible.total * 0.02, 'the capture is visible in renderer-owned pixels');
  await page.screenshot({ path: `${out}/01-loaded.png` });

  await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().setModelVisibility(id, false), outcome.id);
  const hidden = await settle('hidden');
  const hiddenPixels = await splatPixels();
  result.checks.hidden = { stats: hidden, pixels: hiddenPixels };
  assert.equal(hidden.gaussian.visibleAssetSplats, 0);
  assert.ok(hiddenPixels.differing < visible.differing * 0.1, 'hiding the model hides the capture');
  await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().setModelVisibility(id, true), outcome.id);
  await settle('shown');

  // Centre clipping (disclosed limitation): a vertical plane through the
  // placed capture's centre culls whole Gaussians by centre; no caps.
  const plane = await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const record = [...state.models.values()].find(m => m.gaussianSplat).gaussianSplat;
    const { min, max } = record.sourceCenterBounds, m = record.placement;
    const c = [0, 1, 2].map(i => (min[i] + max[i]) / 2);
    const point = [0, 1, 2].map(r => m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2] + m[12 + r]);
    state.setSectionPlaneFromFace([1, 0, 0], point);
    return point;
  });
  const clipped = await settle('clipped');
  const clippedPixels = await splatPixels();
  result.checks.centreClip = { plane, stats: clipped, pixels: clippedPixels };
  assert.ok(clippedPixels.differing > 0 && clippedPixels.differing < visible.differing, 'the section plane culls part of the capture by centre');
  await page.screenshot({ path: `${out}/02-centre-clipped.png` });
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setSectionPlaneEnabled(false));
  await settle('unclipped');

  await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().removeModel(id), outcome.id);
  const removed = await settle('removed');
  const removedPixels = await splatPixels();
  result.checks.removed = { stats: removed, pixels: removedPixels };
  assert.equal(removed.gaussian.assets, 0, 'removal frees the renderer asset');
  assert.equal(removed.gaussian.gpuBytes, 0);
  assert.ok(removedPixels.differing < visible.differing * 0.1, 'nothing of the capture is drawn after removal');
  await page.screenshot({ path: `${out}/03-removed.png` });
  assert.deepEqual(errors, [], `uncaught page errors: ${errors.join('; ')}`);
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
