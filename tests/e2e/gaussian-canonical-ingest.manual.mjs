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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.env.GAUSSIAN_BASE ?? 'http://127.0.0.1:5291';
const capture = process.env.GAUSSIAN_CAPTURE ?? '/_fixtures/seem-kirke-v1.ply';
const placement = process.env.GAUSSIAN_PLACEMENT ?? 'rx180';
// An IFC model added beside the capture keeps frames rendering after its removal.
const ifc = process.env.GAUSSIAN_IFC ?? 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc';
const out = process.env.GAUSSIAN_EVIDENCE ?? '/tmp/gaussian-8565-browser';
await mkdir(out, { recursive: true });
const browser = process.env.IFC_GPU_CDP_URL
  ? await chromium.connectOverCDP(process.env.IFC_GPU_CDP_URL)
  : await chromium.launch({ headless: true, args: [
    '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader',
    '--use-angle=swiftshader', '--disable-vulkan-surface', '--ignore-gpu-blocklist', '--enable-gpu',
  ] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
// #8566: observe real browser objects before application startup. Only the test
// destroys the currently configured device; production owns loss and recovery.
await context.addInitScript(() => {
  const observed = globalThis.__witnessDevices = { devices: [], contexts: new Map(), losses: [] };
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await request.apply(this, args);
    const id = observed.devices.push(device) - 1;
    void device.lost.then(info => observed.losses.push({ id, reason: info.reason, message: info.message }));
    return device;
  };
  const configure = GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure = function (configuration) {
    const result = configure.call(this, configuration);
    observed.contexts.set(this, configuration.device);
    return result;
  };
});
const page = await context.newPage();
const errors = [];
const gpuConsole = [];
const workers = { started: [], closed: [] };
page.on('pageerror', error => errors.push(error.message));
// Everything is recorded with its URL; only page exceptions and GPU-pattern
// console errors fail the witness, the rest is disclosed in result.json.
const consoleErrors = [];
const requestFailures = [];
page.on('console', message => {
  if (message.type() !== 'error') return;
  consoleErrors.push({ text: message.text(), url: message.location()?.url ?? null });
  if (/gpu|webgpu|gaussian|validation|device lost/i.test(message.text())) gpuConsole.push(message.text());
});
page.on('requestfailed', request => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));
page.on('response', response => { if (response.status() >= 400) requestFailures.push({ url: response.url(), status: response.status() }); });
page.on('worker', worker => {
  workers.started.push(worker.url());
  worker.on('close', () => workers.closed.push(worker.url()));
});
const result = { base, capture, placement, errors, gpuConsole, consoleErrors, requestFailures, workers, checks: {}, frames: {},
  errorCollection: 'all console errors, page exceptions and failed/4xx/5xx requests recorded; fails only on page exceptions and GPU-pattern console errors' };

const visibility = (id, visible) => page.evaluate(({ id, visible }) =>
  globalThis.__ifc_lite_viewer_store__.getState().setModelVisibility(id, visible), { id, visible });
const stats = () => page.evaluate(() => {
  const s = globalThis.__ifc_lite_render_stats__?.();
  return s ? { adapter: s.adapter, gaussian: s.gaussianSplats } : null;
});
/** Store one renderer-owned frame in the page under `label`. */
const frame = async (label) => { const info = await frameIn(label); result.frames[label] = info; return info; };
const frameIn = (label) => page.evaluate(async (label) => {
  const url = await globalThis.__ifc_lite_capture_color_frame__?.();
  if (!url) return null;
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  (globalThis.__witnessFrames ??= {})[label] = data;
  // The camera every mesh draw used for this frame; compared frames must share it.
  (globalThis.__witnessCameras ??= {})[label] = globalThis.__ifc_lite_view_projection__?.() ?? null;
  return { width: bitmap.width, height: bitmap.height, corner: Array.from(data.slice(0, 3)) };
}, label);
/** Pixel comparisons between stored frames, done in the page. */
const compare = (a, b, outside) => page.evaluate(({ a, b, outside }) => {
  const f = globalThis.__witnessFrames, x = f[a], y = f[b];
  const cameras = globalThis.__witnessCameras;
  for (const label of [a, b, ...(outside ?? [])]) {
    const camera = cameras[label], reference = cameras[a];
    if (!camera || camera.length !== 16 || camera.some((value, i) => value !== reference[i])) {
      throw new Error(`frame ${label} was not drawn with the reference camera of ${a}`);
    }
  }
  const delta = (p, q, i) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
  const width = Math.round(Math.sqrt(x.length / 4)); // diagnostic only; frames are square-ish
  let differing = 0, exactDiffering = 0, escaped = 0;
  const samples = [];
  for (let i = 0; i < x.length; i += 4) {
    const d = delta(x, y, i);
    if (d !== 0 || x[i + 3] !== y[i + 3]) exactDiffering++;
    if (d > 6) {
      differing++;
      // `outside`: [frame, reference] whose equal pixels are outside the contribution.
      if (outside) {
        const reference = delta(f[outside[0]], f[outside[1]], i);
        if (reference <= 6) {
          escaped++;
          samples.push({ pixel: i / 4, column: (i / 4) % width, delta: d, referenceDelta: reference });
        }
      }
    }
  }
  return { differing, exactDiffering, escaped, total: x.length / 4, samples, sameCamera: true };
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

  // A real device loss must pass through the mounted viewport's recovery
  // subscription. No reload, direct recoverDevice call or fabricated state.
  await frame('beforeLoss'); await frame('beforeLossStable');
  assert.equal((await compare('beforeLoss', 'beforeLossStable')).exactDiffering, 0, 'pre-loss reference is stable');
  const lossTarget = await page.evaluate(() => {
    const o = globalThis.__witnessDevices;
    const active = [...o.contexts].filter(([ctx]) => ctx.canvas instanceof HTMLCanvasElement && ctx.canvas.isConnected);
    const devices = [...new Set(active.map(([, device]) => device))];
    if (devices.length !== 1) throw new Error(`Expected one live canvas device, got ${devices.length}`);
    const device = devices[0], id = o.devices.indexOf(device);
    if (id < 0) throw new Error('Configured device was not observed at requestDevice');
    const model = [...globalThis.__ifc_lite_viewer_store__.getState().models.values()].find(m => m.gaussianSplat);
    globalThis.__witnessBeforeLoss = { model, sourceFile: model.sourceFile, contexts: active.map(([ctx]) => ctx), metadata: JSON.stringify(model.gaussianSplat),
      frames: globalThis.__ifc_lite_render_stats__().gaussianSplats.drawnFrames, device, id };
    device.destroy();
    return { id, devicesRequested: o.devices.length };
  });
  result.checks.deviceRecovery = { lossTarget, status: 'awaiting-production-recovery' };
  await page.waitForFunction(() => {
    const o = globalThis.__witnessDevices, before = globalThis.__witnessBeforeLoss;
    return o.losses.some(loss => loss.id === before.id)
      && [...o.contexts].some(([ctx, device]) => ctx.canvas instanceof HTMLCanvasElement && ctx.canvas.isConnected && before.contexts.includes(ctx) && device !== before.device)
      && globalThis.__ifc_lite_gaussian_handle_state__?.(globalThis.__witnessHandle)?.state === 'resident'
      && globalThis.__ifc_lite_render_stats__?.().gaussianSplats.drawnFrames > before.frames;
  }, null, { timeout: 120_000 });
  const recovery = await page.evaluate(() => {
    const o = globalThis.__witnessDevices, before = globalThis.__witnessBeforeLoss;
    const model = globalThis.__ifc_lite_viewer_store__.getState().models.get(before.model.id);
    return { losses: o.losses, devicesRequested: o.devices.length,
      sameHandle: model?.gaussianSplat?.handle === globalThis.__witnessHandle,
      sameSource: model?.sourceFile === before.sourceFile,
      sameDisplay: model?.name === before.model.name && model?.visible === before.model.visible,
      sameProvenance: model?.sourceHandle === before.model.sourceHandle && model?.sourceFingerprint === before.model.sourceFingerprint,
      sameMetadata: JSON.stringify(model?.gaussianSplat) === before.metadata,
      models: globalThis.__ifc_lite_viewer_store__.getState().models.size };
  });
  result.checks.deviceRecovery = { lossTarget, ...recovery, stats: await stats() };
  assert.equal(recovery.losses.find(loss => loss.id === lossTarget.id)?.reason, 'destroyed');
  assert.ok(recovery.devicesRequested > lossTarget.devicesRequested, 'production requested a successor device');
  assert.ok(recovery.sameHandle && recovery.sameSource && recovery.sameMetadata && recovery.sameDisplay && recovery.sameProvenance, 'recovery retains capture identity and metadata');
  assert.equal(recovery.models, 1);
  assert.equal(result.checks.deviceRecovery.stats.gaussian.assets, 1);
  assert.ok(result.checks.deviceRecovery.stats.gaussian.gpuBytes > 0);
  assert.equal(workers.started.filter(url => /gaussianDecode\.worker/.test(url)).length, 1, 'recovery does not decode/reload the capture');
  await frame('afterLoss');
  result.checks.deviceRecovery.frame = await compare('beforeLoss', 'afterLoss');
  assert.equal(result.checks.deviceRecovery.frame.exactDiffering, 0, 'recovery restores exact RGBA with the same camera');

  // Six world-axis faces, using transformed source-centre bounds. Containment
  // and total exclusion have authoritative frame references. Partial cuts only
  // diagnose changed contribution; they do not prove an exact kept-splat set.
  const boxBounds = await page.evaluate(() => {
    const record = [...globalThis.__ifc_lite_viewer_store__.getState().models.values()].find(m => m.gaussianSplat).gaussianSplat;
    const { min, max } = record.sourceCenterBounds, m = record.placement;
    const corners = Array.from({ length: 8 }, (_, bits) => {
      const c = [0, 1, 2].map(i => (bits & (1 << i)) ? max[i] : min[i]);
      return [0, 1, 2].map(r => m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2] + m[12 + r]);
    });
    return { min: [0, 1, 2].map(i => Math.min(...corners.map(c => c[i]))),
      max: [0, 1, 2].map(i => Math.max(...corners.map(c => c[i]))) };
  });
  const containing = { min: boxBounds.min.map((v, i) => v - Math.max(1, boxBounds.max[i] - v)),
    max: boxBounds.max.map((v, i) => v + Math.max(1, v - boxBounds.min[i])) };
  const setBox = async (box) => {
    await page.evaluate(box => {
      const state = globalThis.__ifc_lite_viewer_store__.getState();
      if (box) state.setSectionBox(box); else state.setSectionPlaneEnabled(false);
      const next = globalThis.__ifc_lite_viewer_store__.getState();
      next.setSectionPlaneShowGizmo(next.sectionPlane.id, false);
    }, box);
    await page.waitForTimeout(300); // allow the mounted viewport to consume store changes
  };
  await frame('boxReference'); await frame('boxStable');
  assert.equal((await compare('boxReference', 'boxStable')).exactDiffering, 0, 'clip-box reference is stable');
  await visibility(outcome.id, false); await page.waitForTimeout(300); await frame('boxHidden');
  await visibility(outcome.id, true); await drawn('box-visible', (await stats()).gaussian.drawnFrames);
  const boxChecks = result.checks.clipBox = { referenceSemantics: 'exact RGBA, identical view-projection',
    partialSemantics: 'thresholded pixel-change diagnostic only; no authoritative kept-splat reference', faces: [] };
  await setBox(containing); await frame('boxContained');
  boxChecks.contained = await compare('boxReference', 'boxContained');
  assert.equal(boxChecks.contained.exactDiffering, 0, 'a box containing every centre preserves the full frame');
  for (const axis of [0, 1, 2]) for (const side of ['min', 'max']) {
    const label = `box-${axis}-${side}`, excluded = structuredClone(containing), partial = structuredClone(containing);
    const span = boxBounds.max[axis] - boxBounds.min[axis];
    assert.ok(span > 0, `fixture must span axis ${axis} for a meaningful partial control`);
    excluded[side][axis] = side === 'min' ? boxBounds.max[axis] + Math.max(0.5, span * 0.5) : boxBounds.min[axis] - Math.max(0.5, span * 0.5);
    partial[side][axis] = (boxBounds.min[axis] + boxBounds.max[axis]) / 2;
    await setBox(excluded); await frame(`${label}-excluded`);
    const empty = await compare(`${label}-excluded`, 'boxHidden');
    assert.equal(empty.exactDiffering, 0, `${label}: exclusion of every centre matches the hidden reference`);
    await setBox(partial); await frame(`${label}-partial`);
    const kept = await compare(`${label}-partial`, 'boxHidden'), changed = await compare(`${label}-partial`, 'boxReference');
    assert.ok(kept.differing > 0 && changed.differing > 0, `${label}: partial clipping keeps a contribution and changes the frame`);
    await setBox(null); await frame(`${label}-restored`);
    const restored = await compare(`${label}-restored`, 'boxReference');
    assert.equal(restored.exactDiffering, 0, `${label}: disabling the box restores exact RGBA`);
    boxChecks.faces.push({ axis, side, excluded, partial, empty, keptDiagnostic: kept, changedDiagnostic: changed, restored });
  }

  // Disclosed centre clipping: a vertical plane through the placed capture's
  // centre, its gizmo hidden. Alpha compositing lets a culled near splat hide a
  // far one, so a pixel can gain colour once clipped over one background. This
  // is a thresholded differential DIAGNOSTIC, not a proof: it reports pixels
  // that escape the unclipped contribution over the dark and the light theme
  // background and requires none over both. Blind spots: a wrong fragment can
  // match one background, low alpha can stay below the threshold, and 8-bit
  // clamping/tone mapping break any affine compositing model. Kept-subset
  // correctness is the renderer's own test (gaussian-splat-layer.test.ts).
  const clipOn = () => page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const record = [...state.models.values()].find(m => m.gaussianSplat).gaussianSplat;
    const { min, max } = record.sourceCenterBounds, m = record.placement;
    const c = [0, 1, 2].map(i => (min[i] + max[i]) / 2);
    const point = [0, 1, 2].map(r => m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2] + m[12 + r]);
    state.setSectionPlaneFromFace([1, 0, 0], point);
    const next = globalThis.__ifc_lite_viewer_store__.getState();
    next.setSectionPlaneShowGizmo(next.sectionPlane.id, false);
    return point;
  });
  const clipOff = () => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setSectionPlaneEnabled(false));
  const measure = async (suffix) => {
    let last = (await stats()).gaussian.drawnFrames;
    await clipOff(); await page.waitForTimeout(300);
    await frame(`visible${suffix}`);
    await visibility(outcome.id, false); await page.waitForTimeout(300);
    await frame(`hidden${suffix}`);
    await visibility(outcome.id, true); last = (await drawn(`shown${suffix}`, last)).gaussian.drawnFrames;
    const plane = await clipOn(); last = (await drawn(`clipped${suffix}`, last)).gaussian.drawnFrames;
    await frame(`clipped${suffix}`);
    await page.screenshot({ path: `${out}/02-centre-clipped${suffix || '-dark'}.png` });
    await visibility(outcome.id, false); await page.waitForTimeout(300);
    await frame(`clippedHidden${suffix}`);
    await visibility(outcome.id, true); await drawn(`clipped-again${suffix}`, last);
    const full = await compare(`visible${suffix}`, `hidden${suffix}`);
    const kept = await compare(`clipped${suffix}`, `clippedHidden${suffix}`, [`visible${suffix}`, `hidden${suffix}`]);
    await clipOff();
    return { plane, full, kept };
  };
  // The initial theme follows prefers-color-scheme; set both explicitly.
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setTheme('dark'));
  await page.waitForTimeout(500);
  const dark = await measure('');
  await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().setTheme('light'));
  await page.waitForTimeout(500);
  const light = await measure('Light');
  const backgrounds = await compare('hidden', 'hiddenLight');
  assert.ok(backgrounds.differing > backgrounds.total * 0.9, 'the two measurements really use different backgrounds');
  const lightEscaped = new Set(light.kept.samples.map(sample => sample.pixel));
  const both = dark.kept.samples.filter(sample => lightEscaped.has(sample.pixel));
  result.checks.centreClip = {
    dark: { plane: dark.plane, full: dark.full.differing, kept: dark.kept.differing, escaped: dark.kept.samples },
    light: { full: light.full.differing, kept: light.kept.differing, escaped: light.kept.samples },
    escapedOverBoth: both, backgroundsDiffer: backgrounds.differing,
  };
  for (const run of [dark, light]) {
    assert.ok(run.kept.differing > 0, 'the kept side still contributes');
    assert.ok(run.kept.differing < run.full.differing, 'the plane culls part of the capture');
  }
  assert.deepEqual(both, [], 'diagnostic: no pixel escapes the unclipped contribution over both backgrounds');
  const unclipped = await stats();

  // Phase B: an IFC model beside the capture, through the real Add-model input.
  // IFC frames refine after load, so wait until two consecutive capture-hidden
  // frames are identical; that settled frame is the removal reference.
  await page.locator('#file-input-add').setInputFiles({ name: 'AC20-FZK-Haus.ifc', mimeType: 'application/x-step', buffer: await readFile(ifc) });
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return state.models.size === 2 && !state.loading && !state.geometryStreamingActive;
  }, null, { timeout: 120_000 });
  result.checks.ifcBeside = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.values()]
    .map(m => ({ name: m.name, capture: Boolean(m.gaussianSplat), entities: m.ifcDataStore?.entityCount ?? 0 })));
  await page.screenshot({ path: `${out}/03-ifc-beside-capture.png` });
  await visibility(outcome.id, false);
  let settled = null;
  for (let attempt = 0; attempt < 40 && !settled; attempt++) {
    await page.waitForTimeout(500);
    await frame('ifcA'); await frame('ifcB');
    const noise = await compare('ifcA', 'ifcB');
    if (noise.differing === 0) settled = { attempts: attempt + 1 };
  }
  result.checks.ifcSettled = settled;
  assert.ok(settled, 'the IFC-only frame settles to a repeatable reference');
  await visibility(outcome.id, true);
  await drawn('ifc-shown', (await stats()).gaussian.drawnFrames - 1);
  await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().removeModel(id), outcome.id);
  await page.waitForTimeout(500);
  await frame('removed');
  const removed = await stats();
  const baseline = await compare('removed', 'ifcB');
  const handleAfter = await page.evaluate(() => globalThis.__ifc_lite_gaussian_handle_state__?.(globalThis.__witnessHandle));
  result.checks.removed = { stats: removed, baseline, handleAfter, unclipped: unclipped.gaussian };
  assert.equal(removed.gaussian.assets, 0, 'removal frees the renderer asset');
  assert.equal(removed.gaussian.gpuBytes, 0);
  assert.deepEqual(handleAfter, { state: 'invalid' }, 'no surviving handle');
  assert.equal(baseline.differing, 0, 'the frame returns to the settled capture-free reference');
  assert.equal(result.checks.ifcBeside.length, 2);
  assert.ok(decoder.every(url => workers.closed.includes(url)), 'the decoder worker ended with its request');
  await page.screenshot({ path: `${out}/04-capture-removed.png` });
  assert.deepEqual(errors, [], `uncaught page errors: ${errors.join('; ')}`);
  assert.deepEqual(gpuConsole, [], `GPU errors: ${gpuConsole.join('; ')}`);
  result.verdict = 'pass';
} catch (error) {
  result.verdict = 'fail';
  result.failure = String(error?.stack ?? error);
  throw error;
} finally {
  // Preserve real lifecycle observations even if recovery times out or a pixel
  // assertion fails. Never hide a failed read behind a claimed recovery pass.
  result.deviceObservations = await page.evaluate(() => {
    const o = globalThis.__witnessDevices;
    return o ? { requested: o.devices.length, losses: o.losses,
      configuredDeviceIds: [...o.contexts.values()].map(device => o.devices.indexOf(device)),
      handleState: globalThis.__ifc_lite_gaussian_handle_state__?.(globalThis.__witnessHandle) ?? null } : null;
  }).catch(error => ({ observationError: String(error) }));
  await writeFile(`${out}/result.json`, JSON.stringify(result, null, 2));
  await context.close();
  await browser.close();
}
