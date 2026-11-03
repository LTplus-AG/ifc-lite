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
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.env.GAUSSIAN_BASE ?? 'http://127.0.0.1:5291';
const capture = process.env.GAUSSIAN_CAPTURE ?? '/_fixtures/seem-kirke-v1.ply';
const placement = process.env.GAUSSIAN_PLACEMENT ?? 'rx180';
// An IFC model added beside the capture keeps frames rendering after its removal.
const ifc = process.env.GAUSSIAN_IFC ?? 'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc';
const captureProbe = process.env.GAUSSIAN_CAPTURE_PROBE === '1';
const captureDiscriminator = process.env.GAUSSIAN_CAPTURE_DISCRIMINATOR === '1';
assert.ok(!(captureProbe && captureDiscriminator), 'Choose one fixed sequence');
const probeFrames = [];
const out = process.env.GAUSSIAN_EVIDENCE ?? '/tmp/gaussian-8565-browser';
await mkdir(out, { recursive: true });
if (captureDiscriminator) {
  // Test-only successor may consume the frozen eb4b production bundle. Fail
  // closed if ANY other tracked path changed; this is not a rebuild exemption.
  const manifestBytes = await readFile(process.env.GAUSSIAN_BUNDLE_MANIFEST);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  assert.equal(manifestSha256, '55b56fe06326a1adb0a8e4120f2032c5d3b3cc023e9fbd1b8ee1194e287747c6');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const productionSource = 'eb4badafc5acd7fee74110408f288c7c1a2c8a8a';
  assert.equal(manifest.sourceBinding.head, productionSource);
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  assert.equal(git('status', '--porcelain'), '', 'Witness requires clean exact source');
  assert.equal(git('diff', '--name-only', productionSource, 'HEAD', '--', '.', ':!tests/e2e/gaussian-canonical-ingest.manual.mjs'), '', 'Frozen bundle production sources differ');
  await writeFile(`${out}/witness-bundle-binding.json`, JSON.stringify({
    witnessSource: git('rev-parse', 'HEAD'), witnessSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
    productionSource, productionTree: manifest.sourceBinding.tree, manifestSha256,
    changedPaths: git('diff', '--name-only', productionSource, 'HEAD'),
  }, null, 2));
}
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
const deviceLossDiagnostics = [];
const requestFailures = [];
page.on('console', message => {
  if (/^\[(Renderer|Viewport)\] GPU device lost/.test(message.text())) deviceLossDiagnostics.push({ level: message.type(), text: message.text(), url: message.location()?.url ?? null });
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
const result = { base, capture, placement, deviceLossDiagnostics, errors, gpuConsole, consoleErrors, requestFailures, workers, checks: {}, frames: {},
  errorCollection: 'all console errors, page exceptions and failed/4xx/5xx requests recorded; fails only on page exceptions and GPU-pattern console errors' };

// Lifecycle stages are structural prerequisites. Visual failures are accumulated
// without suppressing exact predicates; no structural exception is swallowed.
const stageNames = ['load', 'hideShow', 'recovery', 'clipBox', 'centreClip', 'ifcCoexistence', 'removal', 'runtime'];
result.stageSemantics = 'Structural/lifecycle execution only; visual predicates have independent verdicts';
result.stages = Object.fromEntries(stageNames.map(name => [name, { status: 'not-reached', reason: 'Earlier stage has not completed' }]));
const visualNames = ['visible contribution', 'hide/show thresholded restoration', 'hide/show exact restoration',
  'pre-loss exact stability', 'recovery exact restoration', 'clip-box exact reference stability', 'clip-box exact containment',
  ...[0, 1, 2].flatMap(axis => ['min', 'max'].flatMap(side => ['exact exclusion', 'partial diagnostic', 'exact disable restoration'].map(check => `box-${axis}-${side} ${check}`))),
  'distinct backgrounds diagnostic', 'centre clipping dark diagnostic', 'centre clipping light diagnostic',
  'centre clipping escaped pixels diagnostic', 'IFC reference thresholded stability', 'IFC reference exact stability',
  'removal thresholded reference', 'removal exact reference'];
result.visual = visualNames.map(name => ({ name, status: 'not-reached', reason: 'Prerequisite stage has not completed' }));
let activeStage = null;
const beginStage = (name) => {
  assert.deepEqual(errors, [], 'page runtime failure before next stage');
  assert.deepEqual(gpuConsole, [], 'GPU runtime failure before next stage');
  if (activeStage) result.stages[activeStage] = { status: 'pass' };
  activeStage = name; result.stages[name] = { status: 'running' };
};
const visual = (name, pass, evidence, semantics = 'authoritative exact RGBA predicate') => {
  const index = result.visual.findIndex(check => check.name === name);
  assert.ok(index >= 0, `Unregistered visual check: ${name}`);
  result.visual[index] = { name, status: pass ? 'pass' : 'fail', semantics, evidence };
};

const visibility = (id, visible) => page.evaluate(({ id, visible }) =>
  globalThis.__ifc_lite_viewer_store__.getState().setModelVisibility(id, visible), { id, visible });
const stats = () => page.evaluate(() => {
  const s = globalThis.__ifc_lite_render_stats__?.();
  return s ? { adapter: s.adapter, gaussian: s.gaussianSplats } : null;
});
/** Store one renderer-owned frame in the page under `label`. */
const frame = async (label) => {
  if (captureProbe) return diagnosticFrame(label);
  const info = await frameIn(label);
  assert.ok(info, `${label}: renderer capture unavailable`);
  const { png, decoded, ...metadata } = info;
  await writeFile(`${out}/${label}.png`, Buffer.from(png.split(',')[1], 'base64'));
  await writeFile(`${out}/${label}-decoded.rgba`, Buffer.from(decoded, 'base64'));
  await writeFile(`${out}/${label}-metadata.json`, JSON.stringify(metadata, null, 2));
  result.frames[label] = metadata; return metadata; };
// #8566 / original d394: opt in with GAUSSIAN_CAPTURE_PROBE=1 in a rebuilt
// internal bundle. Fixed five-frame probe, stops before device destruction.
// No settling loop, extra frame request, tolerance or sorting change. Original
// zero criterion retained, including PNG conversion and same-submit copies.
// Observer effects: duplicate 1 MiB copy, pass-call proxies, O(N) index hash,
// PNG/base64 transport and disk writes delay subsequent requests; not timing evidence.
// At 512x512: 15 MiB raw copies + 15 MiB lossless delta maps + five PNGs
// (roughly <=6 MiB) and bounded metadata. No full source arrays are retained.
// Attachment IDs are process-local identities, not cross-run equality proofs.
// Sort FNV32 is a diagnostic checksum, not collision-proof content identity;
// source arrays are not exposed; preserve fixture/source/bundle SHA256 bindings.
// Fixed five-frame probe. Persist each boundary before any comparison can fail.
async function diagnosticFrame(label, ordinary = false) {
  const captured = await page.evaluate(async (ordinary) => {
    const observe = () => {
      const s = globalThis.__ifc_lite_viewer_store__.getState();
      const keys = ['theme', 'visualEnhancementsEnabled', 'centrelineOverlayEnabled',
        'contactShadingQuality', 'contactShadingIntensity', 'contactShadingRadius',
        'separationLinesEnabled', 'separationLinesQuality', 'separationLinesIntensity',
        'separationLinesRadius', 'pointCloudEdlEnabled', 'pointCloudEdlStrength', 'sectionPlane'];
      if (keys.some(key => s[key] === undefined)) throw new Error('Capture settings unavailable');
      return { worldViewProjection: globalThis.__ifc_lite_view_projection__?.(),
        settings: JSON.stringify(Object.fromEntries(keys.map(key => [key, s[key]]))), at: performance.now() };
    };
    const before = observe();
    // Deliberately invoke distinct existing APIs. Ordinary API calls
    // captureColorFrame() with no diagnostic option, returning only a PNG URL.
    const returned = ordinary ? await globalThis.__ifc_lite_capture_color_frame__?.()
      : await globalThis.__ifc_lite_capture_color_diagnostic__?.();
    if (ordinary ? typeof returned !== 'string'
      : !returned || typeof returned !== 'object' || typeof returned.raw !== 'string' || typeof returned.duplicate !== 'string') {
      throw new Error('Capture route returned an unexpected shape');
    }
    const frame = ordinary ? { png: returned } : returned;
    if (typeof frame.png !== 'string' || !frame.png.startsWith('data:image/png;base64,')) throw new Error('Capture PNG unavailable');
    const bitmap = await createImageBitmap(await (await fetch(frame.png)).blob());
    const width = bitmap.width, height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0); bitmap.close();
    const decoded = ctx.getImageData(0, 0, width, height).data;
    let binary = '';
    for (let i = 0; i < decoded.length; i += 0x8000) binary += String.fromCharCode(...decoded.subarray(i, i + 0x8000));
    return { ...frame, width, height, decoded: btoa(binary), decodedAt: performance.now(),
      route: ordinary ? 'ordinary-png-string' : 'diagnostic-raw-duplicate-object',
      observations: { before, after: observe(), atomic: false } };
  }, ordinary);
  const kinds = ordinary ? ['decoded'] : ['raw', 'duplicate', 'decoded'];
  const buffers = Object.fromEntries(kinds.map(k => [k, Buffer.from(captured[k], 'base64')]));
  for (const [kind, bytes] of Object.entries(buffers)) await writeFile(`${out}/${label}-${kind}.rgba`, bytes);
  await writeFile(`${out}/${label}.png`, Buffer.from(captured.png.split(',')[1], 'base64'));
  const metadata = { label, width: captured.width, height: captured.height, ...captured.metadata, decodedAt: captured.decodedAt,
    route: captured.route, observations: captured.observations,
    unavailable: ordinary ? ['raw GPU RGBA', 'same-submit duplicate', 'atomic frame metadata', 'sort hash'] : [],
    sha256: Object.fromEntries(Object.entries(buffers).map(([k, b]) => [k, createHash('sha256').update(b).digest('hex')])) };
  await writeFile(`${out}/${label}-metadata.json`, JSON.stringify(metadata, null, 2));
  probeFrames.push({ label, ...buffers }); result.frames[label] = metadata;
  return metadata;
}
async function compareProbeBytes(comparisons, name, a, b) {
  assert.equal(a.length, b.length);
  const mask = Buffer.alloc(a.length); const channels = [0, 0, 0, 0]; let pixels = 0, max = 0;
  for (let i = 0; i < a.length; i += 4) {
    let changed = false;
    for (let c = 0; c < 4; c++) { const d = Math.abs(a[i+c] - b[i+c]); mask[i+c] = d;
      if (d) { channels[c]++; changed = true; max = Math.max(max, d); } }
    if (changed) pixels++;
  }
  await writeFile(`${out}/${name}-absolute-delta.rgba`, mask);
  comparisons.push({ name, exactDiffering: pixels, channels, maxChannelDelta: max, exactZero: pixels === 0 });
}
async function finishProbe() {
  const comparisons = [];
  const compareBytes = (name, a, b) => compareProbeBytes(comparisons, name, a, b);
  for (const [i, f] of probeFrames.entries()) {
    await compareBytes(`${f.label}-duplicate`, f.raw, f.duplicate);
    await compareBytes(`${f.label}-decode`, f.raw, f.decoded);
    if (i) await compareBytes(`${probeFrames[i-1].label}-${f.label}`, probeFrames[i-1].raw, f.raw);
  }
  await compareBytes('visible-shown', probeFrames[0].raw, probeFrames[2].raw);
  result.checks.captureProbe = { comparisons, criterion: 'zero byte differences; visibility transitions are expected nonzero controls',
    sequence: probeFrames.map(f => f.label), stoppedBeforeLoss: true };
  await writeFile(`${out}/capture-comparisons.json`, JSON.stringify(result.checks.captureProbe, null, 2));
  const required = comparisons.filter(c => /-duplicate$|-decode$|beforeLoss-beforeLossStable|shown-beforeLoss|visible-shown/.test(c.name));
  assert.ok(required.every(c => c.exactZero), 'fixed capture probe exact-zero controls failed; all deltas retained');
}
// #8566: existing frozen bundle, fixed D,D,O,O,H sequence; no new renderer
// instrumentation or settling loops. Order/time and readback/PNG/I/O overhead
// confound pair differences: this cannot establish observer causation.
// GAUSSIAN_CAPTURE_DISCRIMINATOR=1 requires GAUSSIAN_BUNDLE_MANIFEST.
// At 512x512 retain 9 MiB RGBA + 10 MiB delta maps + five PNGs (~6 MiB);
// reserve 64 MiB for metadata/logs. Ordinary PNG encoding/readback still observes
// rendering; only the full diagnostic proxy/index-hash/duplicate path is absent.
async function runCaptureDiscriminator(modelId) {
  await diagnosticFrame('D1'); await diagnosticFrame('D2');
  await diagnosticFrame('O1', true); await diagnosticFrame('O2', true);
  await visibility(modelId, false);
  await diagnosticFrame('hidden', true);
  const [d1, d2, o1, o2, hidden] = probeFrames;
  const comparisons = [];
  for (const d of [d1, d2]) {
    await compareProbeBytes(comparisons, `${d.label}-duplicate`, d.raw, d.duplicate);
    await compareProbeBytes(comparisons, `${d.label}-decode`, d.raw, d.decoded);
  }
  await compareProbeBytes(comparisons, 'D1-D2', d1.raw, d2.raw);
  await compareProbeBytes(comparisons, 'O1-O2', o1.decoded, o2.decoded);
  for (const f of [d1, d2, o1, o2]) await compareProbeBytes(comparisons, `${f.label}-hidden`, f.decoded, hidden.decoded);
  const reference = result.frames.D1.observations.before;
  const stateEqual = Object.values(result.frames).every(m =>
    [m.observations.before, m.observations.after].every(o =>
      o.settings === reference.settings && JSON.stringify(o.worldViewProjection) === JSON.stringify(reference.worldViewProjection)));
  const exactControlsPass = comparisons.filter(c => !c.name.endsWith('-hidden')).every(c => c.exactZero);
  const contributionPass = comparisons.filter(c => c.name.endsWith('-hidden')).every(c => c.exactDiffering > 0);
  result.checks.captureDiscriminator = { exactControlsPass, contributionPass, sequence: probeFrames.map(f => f.label), comparisons, stateEqual,
    stoppedBeforeLoss: true, ordinaryRawUnavailable: true,
    criterion: 'Both visible pairs and diagnostic same-frame controls require zero; each visible-hidden control requires nonzero.',
    limitations: 'Ordinary camera/settings observations bracket asynchronous readback, not atomic GPU state. Fixed order/time and observer overhead prevent causal attribution; ordinary variation can show full diagnostic observer unnecessary in this scene.' };
  await writeFile(`${out}/capture-comparisons.json`, JSON.stringify(result.checks.captureDiscriminator, null, 2));
  assert.deepEqual(probeFrames.map(f => f.label), ['D1', 'D2', 'O1', 'O2', 'hidden']);
  assert.ok(reference.worldViewProjection?.length === 16 && stateEqual, 'Camera/settings observations must remain equal');
  assert.ok(result.frames.D1.rteEye?.length === 3 && result.frames.D1.rteViewProjection?.length === 16, 'Atomic diagnostic camera unavailable');
  assert.deepEqual(result.frames.D1.rteEye, result.frames.D2.rteEye);
  assert.deepEqual(result.frames.D1.rteViewProjection, result.frames.D2.rteViewProjection);
  assert.ok(exactControlsPass, 'Exact pair/boundary criterion failed; every frame retained');
  assert.ok(contributionPass, 'Visible-hidden contribution missing');
  assert.deepEqual(errors, [], 'Page errors'); assert.deepEqual(gpuConsole, [], 'GPU errors');
}
const frameIn = (label) => page.evaluate(async (label) => {
  const url = await globalThis.__ifc_lite_capture_color_frame__?.();
  if (!url) return null;
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  (globalThis.__witnessFrames ??= {})[label] = data;
  // Bracketing API is unavailable here: this camera is observed after decode,
  // not atomic submitted-frame state. Equality is necessary, not proof of it.
  (globalThis.__witnessCameras ??= {})[label] = globalThis.__ifc_lite_view_projection__?.() ?? null;
  let binary = '';
  for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return { width: bitmap.width, height: bitmap.height, corner: Array.from(data.slice(0, 3)),
    png: url, decoded: btoa(binary), cameraAfterDecode: globalThis.__witnessCameras[label], atomic: false };
}, label);
/** Pixel comparisons between stored frames, done in the page. */
const compare = (a, b, outside) => page.evaluate(({ a, b, outside }) => {
  const f = globalThis.__witnessFrames, x = f[a], y = f[b];
  const cameras = globalThis.__witnessCameras;
  if (!x || !y || x.length !== y.length) throw new Error('Missing or incompatible captured frames');
  const sameCamera = [a, b, ...(outside ?? [])].every(label => {
    const camera = cameras[label], reference = cameras[a];
    return camera?.length === 16 && reference?.length === 16 && camera.every((value, i) => value === reference[i]);
  });
  const delta = (p, q, i) => Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]);
  const width = Math.round(Math.sqrt(x.length / 4)); // diagnostic only; frames are square-ish
  let thresholdedDiffering = 0, exactDiffering = 0, escaped = 0;
  const samples = [];
  for (let i = 0; i < x.length; i += 4) {
    const d = delta(x, y, i);
    if (d !== 0 || x[i + 3] !== y[i + 3]) exactDiffering++;
    if (d > 6) {
      thresholdedDiffering++;
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
  return { thresholdedDiffering, threshold: 'RGB L1 > 6', exactDiffering, escaped, total: x.length / 4, samples, sameCamera, cameraObservation: 'after decode, not atomic' };
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
  beginStage('load');
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

  if (captureDiscriminator) {
    await runCaptureDiscriminator(outcome.id);
    result.verdict = 'discriminator-pass';
  } else {
  beginStage('hideShow');
  await frame('visible');
  await page.screenshot({ path: `${out}/01-loaded.png` });
  await visibility(outcome.id, false);
  const hidden = await stats(); // Hidden assets need no Gaussian draw; capture requests the reference frame.
  await frame('hidden');
  await visibility(outcome.id, true);
  const shown = await drawn('shown', hidden?.gaussian?.drawnFrames ?? 0);
  await frame('shown');
  if (captureProbe) {
    await frame('beforeLoss'); await frame('beforeLossStable');
    await finishProbe();
    assert.deepEqual(errors, [], 'uncaught page errors');
    assert.deepEqual(gpuConsole, [], 'GPU errors');
    result.verdict = 'diagnostic-pass';
  } else {
  const contribution = await compare('visible', 'hidden');
  const restored = await compare('visible', 'shown');
  result.checks.hideShow = { hidden: hidden?.gaussian, shown: shown.gaussian, contribution, restored };
  assert.equal(hidden?.gaussian?.visibleAssetSplats, 0);
  visual('visible contribution', contribution.sameCamera && contribution.thresholdedDiffering > contribution.total * 0.02, contribution, 'RGB L1 > 6 on more than 2% of pixels');
  visual('hide/show thresholded restoration', restored.sameCamera && restored.thresholdedDiffering === 0, restored, 'RGB L1 > 6 count is zero');
  visual('hide/show exact restoration', restored.sameCamera && restored.exactDiffering === 0, restored);

  // A real device loss must pass through the mounted viewport's recovery
  // subscription. No reload, direct recoverDevice call or fabricated state.
  await frame('beforeLoss'); await frame('beforeLossStable');
  const preLoss = await compare('beforeLoss', 'beforeLossStable');
  visual('pre-loss exact stability', preLoss.sameCamera && preLoss.exactDiffering === 0, preLoss);
  beginStage('recovery');
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
      successorOnSameCanvas: before.contexts.some(ctx => ctx.canvas.isConnected && o.contexts.get(ctx) !== before.device && o.devices.includes(o.contexts.get(ctx))),
      sameDisplay: model?.name === before.model.name && model?.visible === before.model.visible,
      sameProvenance: model?.sourceHandle === before.model.sourceHandle && model?.sourceFingerprint === before.model.sourceFingerprint,
      sameMetadata: JSON.stringify(model?.gaussianSplat) === before.metadata,
      models: globalThis.__ifc_lite_viewer_store__.getState().models.size };
  });
  result.checks.deviceRecovery = { lossTarget, ...recovery, stats: await stats() };
  assert.equal(recovery.losses.find(loss => loss.id === lossTarget.id)?.reason, 'destroyed');
  assert.ok(recovery.successorOnSameCanvas, 'successor device configured on the original canvas context');
  assert.ok(recovery.devicesRequested > lossTarget.devicesRequested, 'production requested a successor device');
  assert.ok(recovery.sameHandle && recovery.sameSource && recovery.sameMetadata && recovery.sameDisplay && recovery.sameProvenance, 'recovery retains capture identity and metadata');
  assert.equal(recovery.models, 1);
  assert.equal(result.checks.deviceRecovery.stats.gaussian.assets, 1);
  assert.ok(result.checks.deviceRecovery.stats.gaussian.gpuBytes > 0);
  assert.equal(workers.started.filter(url => /gaussianDecode\.worker/.test(url)).length, 1, 'recovery does not decode/reload the capture');
  await frame('afterLoss');
  result.checks.deviceRecovery.frame = await compare('beforeLoss', 'afterLoss');
  visual('recovery exact restoration', result.checks.deviceRecovery.frame.sameCamera && result.checks.deviceRecovery.frame.exactDiffering === 0, result.checks.deviceRecovery.frame);
  beginStage('clipBox');

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
  const boxStable = await compare('boxReference', 'boxStable');
  visual('clip-box exact reference stability', boxStable.sameCamera && boxStable.exactDiffering === 0, boxStable);
  await visibility(outcome.id, false); await page.waitForTimeout(300); await frame('boxHidden');
  await visibility(outcome.id, true); await drawn('box-visible', (await stats()).gaussian.drawnFrames);
  const boxChecks = result.checks.clipBox = { referenceSemantics: 'exact RGBA plus identical post-decode camera observations; not atomic frame metadata',
    partialSemantics: 'thresholded pixel-change diagnostic only; no authoritative kept-splat reference', faces: [] };
  await setBox(containing); await frame('boxContained');
  boxChecks.contained = await compare('boxReference', 'boxContained');
  visual('clip-box exact containment', boxChecks.contained.sameCamera && boxChecks.contained.exactDiffering === 0, boxChecks.contained);
  for (const axis of [0, 1, 2]) for (const side of ['min', 'max']) {
    const label = `box-${axis}-${side}`, excluded = structuredClone(containing), partial = structuredClone(containing);
    const span = boxBounds.max[axis] - boxBounds.min[axis];
    assert.ok(span > 0, `fixture must span axis ${axis} for a meaningful partial control`);
    excluded[side][axis] = side === 'min' ? boxBounds.max[axis] + Math.max(0.5, span * 0.5) : boxBounds.min[axis] - Math.max(0.5, span * 0.5);
    partial[side][axis] = (boxBounds.min[axis] + boxBounds.max[axis]) / 2;
    await setBox(excluded); await frame(`${label}-excluded`);
    const empty = await compare(`${label}-excluded`, 'boxHidden');
    visual(`${label} exact exclusion`, empty.sameCamera && empty.exactDiffering === 0, empty);
    await setBox(partial); await frame(`${label}-partial`);
    const kept = await compare(`${label}-partial`, 'boxHidden'), changed = await compare(`${label}-partial`, 'boxReference');
    visual(`${label} partial diagnostic`, kept.sameCamera && changed.sameCamera && kept.thresholdedDiffering > 0 && changed.thresholdedDiffering > 0, { kept, changed }, 'RGB L1 > 6; no authoritative kept-set reference');
    await setBox(null); await frame(`${label}-restored`);
    const restored = await compare(`${label}-restored`, 'boxReference');
    visual(`${label} exact disable restoration`, restored.sameCamera && restored.exactDiffering === 0, restored);
    boxChecks.faces.push({ axis, side, excluded, partial, empty, keptDiagnostic: kept, changedDiagnostic: changed, restored });
  }

  beginStage('centreClip');
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
  visual('distinct backgrounds diagnostic', backgrounds.sameCamera && backgrounds.thresholdedDiffering > backgrounds.total * 0.9, backgrounds, 'RGB L1 > 6 on more than 90% of pixels');
  const lightEscaped = new Set(light.kept.samples.map(sample => sample.pixel));
  const both = dark.kept.samples.filter(sample => lightEscaped.has(sample.pixel));
  result.checks.centreClip = {
    dark: { plane: dark.plane, full: dark.full.thresholdedDiffering, kept: dark.kept.thresholdedDiffering, escaped: dark.kept.samples },
    light: { full: light.full.thresholdedDiffering, kept: light.kept.thresholdedDiffering, escaped: light.kept.samples },
    escapedOverBoth: both, backgroundsDiffer: backgrounds.thresholdedDiffering,
  };
  for (const run of [dark, light]) {
    visual(`centre clipping ${run === dark ? 'dark' : 'light'} diagnostic`, run.kept.sameCamera && run.full.sameCamera && run.kept.thresholdedDiffering > 0 && run.kept.thresholdedDiffering < run.full.thresholdedDiffering, run, 'thresholded contribution diagnostic, not kept-set proof');
  }
  visual('centre clipping escaped pixels diagnostic', both.length === 0, both, 'RGB L1 > 6 diagnostic over two backgrounds');
  const unclipped = await stats();

  beginStage('ifcCoexistence');
  // Canonical Add-model input; a fixed pair reports stability without waiting
  // until pixels happen to match. Visual failure does not block removal.
  await page.locator('#file-input-add').setInputFiles({ name: 'AC20-FZK-Haus.ifc', mimeType: 'application/x-step', buffer: await readFile(ifc) });
  await page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    return state.models.size === 2 && !state.loading && !state.geometryStreamingActive;
  }, null, { timeout: 120_000 });
  result.checks.ifcBeside = await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().models.values()]
    .map(m => {
      const project = m.ifcDataStore?.spatialHierarchy?.project?.expressId;
      if (!m.gaussianSplat) globalThis.__witnessIfc = { model: m, store: m.ifcDataStore, project };
      return { id: m.id, name: m.name, capture: Boolean(m.gaussianSplat), loadPath: m.loadPath,
        entities: m.ifcDataStore?.entityCount ?? 0, project,
        projectType: project === undefined ? null : m.ifcDataStore.entities.getTypeName(project),
        projectGuid: project === undefined ? null : m.ifcDataStore.entities.getGlobalId(project) };
    }));
  assert.equal(result.checks.ifcBeside.length, 2);
  const ifcModel = result.checks.ifcBeside.find(model => !model.capture);
  assert.ok(ifcModel?.entities > 0 && ifcModel.project > 0 && ifcModel.projectGuid, 'actual IFC store exposes a valid project entity and GlobalId');
  assert.equal(ifcModel.projectType.toUpperCase(), 'IFCPROJECT');
  assert.notEqual(ifcModel.loadPath, 'gaussian');
  await page.screenshot({ path: `${out}/03-ifc-beside-capture.png` });
  await visibility(outcome.id, false);
  await page.waitForTimeout(500);
  await frame('ifcA'); await frame('ifcB');
  const ifcReference = await compare('ifcA', 'ifcB');
  result.checks.ifcReference = ifcReference;
  visual('IFC reference thresholded stability', ifcReference.sameCamera && ifcReference.thresholdedDiffering === 0, ifcReference, 'fixed pair, RGB L1 > 6 count zero');
  visual('IFC reference exact stability', ifcReference.sameCamera && ifcReference.exactDiffering === 0, ifcReference);
  beginStage('removal');
  await visibility(outcome.id, true);
  await drawn('ifc-shown', (await stats()).gaussian.drawnFrames - 1);
  await page.evaluate((id) => globalThis.__ifc_lite_viewer_store__.getState().removeModel(id), outcome.id);
  await page.waitForTimeout(500);
  await frame('removed');
  const removed = await stats();
  const ifcAfter = await page.evaluate(() => {
    const before = globalThis.__witnessIfc, state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = state.models.get(before.model.id);
    return { models: state.models.size, sameStore: model?.ifcDataStore === before.store,
      entities: model?.ifcDataStore?.entityCount ?? 0,
      projectGuid: model?.ifcDataStore?.entities.getGlobalId(before.project),
      projectType: model?.ifcDataStore?.entities.getTypeName(before.project) };
  });
  assert.equal(ifcAfter.models, 1);
  assert.ok(ifcAfter.sameStore && ifcAfter.entities === ifcModel.entities, 'removal preserves usable IFC data');
  assert.equal(ifcAfter.projectGuid, ifcModel.projectGuid);
  assert.equal(ifcAfter.projectType, ifcModel.projectType);
  const baseline = await compare('removed', 'ifcB');
  const handleAfter = await page.evaluate(() => globalThis.__ifc_lite_gaussian_handle_state__?.(globalThis.__witnessHandle));
  result.checks.removed = { ifcAfter, stats: removed, baseline, handleAfter, unclipped: unclipped.gaussian };
  assert.equal(removed.gaussian.assets, 0, 'removal frees the renderer asset');
  assert.equal(removed.gaussian.gpuBytes, 0);
  assert.deepEqual(handleAfter, { state: 'invalid' }, 'no surviving handle');
  visual('removal thresholded reference', baseline.sameCamera && baseline.thresholdedDiffering === 0, baseline, 'RGB L1 > 6 count zero; reference stability reported separately');
  visual('removal exact reference', baseline.sameCamera && baseline.exactDiffering === 0, baseline);
  assert.equal(result.checks.ifcBeside.length, 2);
  assert.ok(decoder.every(url => workers.closed.includes(url)), 'the decoder worker ended with its request');
  await page.screenshot({ path: `${out}/04-capture-removed.png` });
  beginStage('runtime');
  assert.deepEqual(errors, [], `uncaught page errors: ${errors.join('; ')}`);
  assert.deepEqual(gpuConsole, [], `GPU errors: ${gpuConsole.join('; ')}`);
  result.stages.runtime = { status: 'pass' }; activeStage = null;
  result.verdict = result.visual.some(check => check.status !== 'pass') ? 'blocked-visual' : 'pass';
  if (result.verdict !== 'pass') process.exitCode = 1;
  }
  }
} catch (error) {
  if (activeStage) result.stages[activeStage] = { status: 'fail', reason: String(error) };
  for (const stage of Object.values(result.stages)) if (stage.status === 'not-reached') stage.reason = `Stopped after structural/runtime failure in ${activeStage ?? 'final checks'}: ${String(error)}`;
  result.verdict = 'fail';
  result.failure = String(error?.stack ?? error);
  throw error;
} finally {
  for (const check of result.visual) if (check.status === 'not-reached') check.reason =
    captureProbe || captureDiscriminator ? 'Diagnostic mode does not execute the lifecycle journey' : `Stopped at ${activeStage ?? 'completion'}: ${result.failure ?? 'prerequisite unavailable'}`;
  if ((captureProbe || captureDiscriminator) && activeStage && !result.failure) result.stages[activeStage] = { status: 'pass' };
  // Preserve real lifecycle observations even if recovery times out or a pixel
  // assertion fails. Never hide a failed read behind a claimed recovery pass.
  result.deviceObservations = await page.evaluate(() => {
    const o = globalThis.__witnessDevices;
    return o ? { requested: o.devices.length, losses: o.losses,
      configuredDeviceIds: [...o.contexts.values()].map(device => o.devices.indexOf(device)),
      handleState: globalThis.__ifc_lite_gaussian_handle_state__?.(globalThis.__witnessHandle) ?? null } : null;
  }).catch(error => ({ observationError: String(error) }));
  if (captureProbe || captureDiscriminator) for (const stage of Object.values(result.stages)) if (stage.status === 'not-reached') stage.reason = 'Diagnostic mode intentionally stops before loss';
  result.lifecycleVerdict = captureProbe || captureDiscriminator ? 'not-run-diagnostic-mode'
    : stageNames.every(name => result.stages[name].status === 'pass') ? 'pass' : 'fail-or-not-reached';
  result.visualVerdict = captureProbe || captureDiscriminator ? 'see-diagnostic-checks'
    : result.visual.some(check => check.status === 'fail') ? 'fail'
      : result.visual.some(check => check.status === 'not-reached') ? 'not-reached' : 'pass';
  result.accountingLimit = 'Asset/gpuBytes counters report owned allocation accounting, not total GPU leak freedom';
  await writeFile(`${out}/result.json`, JSON.stringify(result, null, 2));
  await context.close();
  await browser.close();
}
