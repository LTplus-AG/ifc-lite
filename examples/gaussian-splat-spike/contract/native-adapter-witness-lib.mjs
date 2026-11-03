/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 witness helpers: the REAL viewer Renderer in a plain page, its own
// colour-frame capture, synthetic geometry and analytic references that never
// run through the adapter's code. Research evidence only; not production.
import { Renderer, normalizeGaussianAttributes } from '../../../packages/renderer/src/index.ts';

export const SH_DC = 0.28209479177387814;
/** Odd sizes put the optical axis on an exact pixel centre. */
export const SIZE = Object.freeze({ width: 321, height: 241 });
export const CAMERA_Z = 10;
export const FOV = Math.PI / 4;
/** luma.gl SplatRenderer default 2D low-pass kernel, in pixels. */
const KERNEL_2D = 0.3;
export const CLEAR = Object.freeze([0, 0, 0, 1]);
export const BASE_OPTIONS = Object.freeze({ clearColor: CLEAR, visualEnhancement: { enabled: false } });
export const QUALIFICATION = Object.freeze({ qualification: 'internal-unqualified' });
export const RED = [1, 0, 0], GREEN = [0, 1, 0], BLUE = [0, 0, 1], MAGENTA = [1, 0, 1];

const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const plain = value => JSON.parse(JSON.stringify(value ?? null));

// Every GPUDevice.destroy() in the page is attributed to the phase it ran in.
let phase = 'setup';
const destroyed = [];
export const setPhase = next => { phase = next; };
export const destroyCalls = device => destroyed.filter(entry => entry.device === device);
if (typeof GPUDevice === 'function') {
  const nativeDestroy = GPUDevice.prototype.destroy;
  GPUDevice.prototype.destroy = function witnessDestroySpy() {
    destroyed.push({ device: this, phase, stack: (new Error().stack ?? '').split('\n').slice(2, 7).map(line => line.trim()) });
    return nativeDestroy.call(this);
  };
}
const describe = value => typeof value === 'string' ? value : value instanceof Error ? value.stack ?? value.message : String(value);
export const consoleErrors = [];
const nativeError = console.error.bind(console);
console.error = (...args) => {
  if (consoleErrors.length < 64) consoleErrors.push({ phase, message: args.map(describe).join(' ').slice(0, 600) });
  nativeError(...args);
};

export function placement(translation = [0, 0, 0], scale = 1) {
  const matrix = new Float64Array(16);
  matrix[0] = matrix[5] = matrix[10] = scale;
  matrix[15] = 1;
  matrix.set(translation, 12);
  return { matrix };
}

/** PLY-space columns (log scale, logit opacity, DC colour) for isotropic, axis-aligned rows. */
export function gaussians(rows) {
  const count = rows.length;
  const names = ['x', 'y', 'z', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2'];
  const columns = Object.fromEntries(names.map(name => [name, new Float32Array(count)]));
  rows.forEach((row, i) => {
    columns.x[i] = row.x; columns.y[i] = row.y; columns.z[i] = row.z;
    columns.opacity[i] = Math.log(row.opacity / (1 - row.opacity));
    columns.rot_0[i] = 1;
    for (const axis of [0, 1, 2]) {
      columns[`scale_${axis}`][i] = Math.log(row.sigma);
      columns[`f_dc_${axis}`][i] = (row.color[axis] - 0.5) / SH_DC;
    }
  });
  return normalizeGaussianAttributes({ count, shDegree: 0, columns });
}

export function boxMesh(expressId, [x0, y0, z0], [x1, y1, z1], color) {
  const faces = [
    [[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
    [[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]],
    [[1, 0, 0], [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]]],
    [[-1, 0, 0], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]],
    [[0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]],
  ];
  const positions = [], normals = [], indices = [];
  for (const [normal, corners] of faces) {
    const base = positions.length / 3;
    for (const corner of corners) { positions.push(...corner); normals.push(...normal); }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { expressId, ifcType: 'IfcBuildingElementProxy', positions: new Float32Array(positions),
    normals: new Float32Array(normals), indices: new Uint32Array(indices), color };
}

/** A dense planar grid of points in renderer world space (no axis conversion on upload). */
export function pointPatch(expressId, { min, max, z, step }) {
  const xs = Math.round((max[0] - min[0]) / step) + 1, ys = Math.round((max[1] - min[1]) / step) + 1;
  const positions = new Float32Array(xs * ys * 3);
  for (let j = 0; j < ys; j++) for (let i = 0; i < xs; i++) positions.set([min[0] + i * step, min[1] + j * step, z], (j * xs + i) * 3);
  return { expressId, ifcType: 'IfcPointCloud', chunk: { positions, pointCount: xs * ys, bbox: { min: [min[0], min[1], z], max: [max[0], max[1], z] } } };
}

export function resizeCanvas(canvas, { width, height }) {
  canvas.style.cssText = `display:block;width:${width}px;height:${height}px`;
}

export function resetCamera(camera, projection = 'perspective', orthoSize = 2.5) {
  camera.setProjectionMode('perspective');
  camera.setFOV(FOV);
  camera.setUp(0, 1, 0);
  camera.setPosition(0, 0, CAMERA_Z);
  camera.setTarget(0, 0, 0);
  if (projection === 'orthographic') { camera.setProjectionMode('orthographic'); camera.setOrthoSize(orthoSize); }
}

/** Independent pinhole/orthographic model of the canonical camera; pixel centres sit at +0.5. */
export function project({ x, y, z }, size, view = {}) {
  if (view.projection === 'orthographic') {
    const k = size.height / 2 / view.orthoSize;
    return [size.width / 2 + x * k, size.height / 2 - y * k];
  }
  const f = size.height / 2 / Math.tan(FOV / 2), depth = CAMERA_Z - z;
  return [size.width / 2 + f * x / depth, size.height / 2 - f * y / depth];
}
const pixelsPerMetre = (z, size, view = {}) => view.projection === 'orthographic'
  ? size.height / 2 / view.orthoSize : size.height / 2 / Math.tan(FOV / 2) / (CAMERA_Z - z);
/** Screen-space standard deviation, including upstream's 2D kernel. */
export const sigmaPixels = (row, size, view) => Math.hypot(row.sigma * pixelsPerMetre(row.z, size, view), KERNEL_2D);
export const centrePixel = (row, size, view) => project(row, size, view).map(Math.floor);

/** Disc covering every fragment upstream can emit for `row` (alpha cutoff 1/255 lies inside 3.4 sigma). */
export function footprint(row, size, view) {
  const [cx, cy] = project(row, size, view);
  return disc(cx, cy, 3.4 * sigmaPixels(row, size, view) + 1.5);
}
export function disc(cx, cy, radius) {
  return { describe: { cx, cy, radius }, bounds: [Math.floor(cx - radius), Math.floor(cy - radius), Math.ceil(cx + radius), Math.ceil(cy + radius)],
    contains: (x, y) => (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius * radius };
}
export function rect(x0, y0, x1, y1) {
  return { describe: { x0, y0, x1, y1 }, bounds: [x0, y0, x1, y1], contains: () => true };
}

export function pixelAt(frame, x, y) {
  const i = (y * frame.width + x) * 4;
  return Array.from(frame.rgba.subarray(i, i + 4));
}

/** Exact per-pixel comparison, optionally inside a region. */
export function compare(actual, reference, region = null) {
  if (actual.width !== reference.width || actual.height !== reference.height) {
    return { comparable: false, actualSize: [actual.width, actual.height], referenceSize: [reference.width, reference.height] };
  }
  const [x0, y0, x1, y1] = region?.bounds ?? [0, 0, actual.width - 1, actual.height - 1];
  let compared = 0, changed = 0, maxDelta = 0, firstChanged = null;
  for (let y = Math.max(0, y0); y <= Math.min(actual.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(actual.width - 1, x1); x++) {
      if (region && !region.contains(x, y)) continue;
      compared++;
      const i = (y * actual.width + x) * 4;
      let delta = 0;
      for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(actual.rgba[i + c] - reference.rgba[i + c]));
      if (delta) { changed++; maxDelta = Math.max(maxDelta, delta); firstChanged ??= { x, y, actual: pixelAt(actual, x, y), reference: pixelAt(reference, x, y) }; }
    }
  }
  return { comparable: true, region: region?.describe ?? 'frame', compared, changed, maxDelta, firstChanged };
}

/** Pixels whose RGB rises above the black clear colour. */
export function nonBackground(frame, region = null, threshold = 8) {
  const [x0, y0, x1, y1] = region?.bounds ?? [0, 0, frame.width - 1, frame.height - 1];
  let count = 0;
  for (let y = Math.max(0, y0); y <= Math.min(frame.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(frame.width - 1, x1); x++) {
      if (region && !region.contains(x, y)) continue;
      const i = (y * frame.width + x) * 4;
      if (Math.max(frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]) > threshold) count++;
    }
  }
  return count;
}

/** Straight-alpha "over" in 8-bit space, layers ordered back to front. */
export function composite(background, layers) {
  const out = background.slice(0, 3);
  for (const { color, alpha } of layers) for (let c = 0; c < 3; c++) out[c] = color[c] * 255 * alpha + out[c] * (1 - alpha);
  return out;
}

/** Analytic colour at the row's centre pixel over a known background (reference frame or clear). */
export function expectSplat(frame, reference, row, view = {}) {
  const size = { width: frame.width, height: frame.height };
  const pixel = centrePixel(row, size, view);
  const [cx, cy] = project(row, size, view);
  const sigma = sigmaPixels(row, size, view);
  const alpha = row.opacity * Math.exp(-0.5 * ((pixel[0] + 0.5 - cx) ** 2 + (pixel[1] + 0.5 - cy) ** 2) / sigma ** 2);
  const background = reference ? pixelAt(reference, ...pixel) : CLEAR.map(v => v * 255);
  const expected = composite(background, [{ color: row.color, alpha }]);
  const actual = pixelAt(frame, ...pixel);
  return { pixel, alpha, background, expected: expected.map(v => Math.round(v * 100) / 100), actual,
    maxDelta: Math.max(...expected.map((v, c) => Math.abs(v - actual[c]))) };
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
async function pngBase64(frame) {
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height), 0, 0);
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Render until a frame actually submits. Orthographic visibility variants
 * compile asynchronously and defer frames meanwhile (PendingVisibility).
 */
async function warm(h, options) {
  const started = performance.now();
  let deferred = 0;
  while (!h.renderer.renderWithResult(options)) {
    deferred++;
    if (performance.now() - started > 20000) throw new Error(`${h.label}: renderer submitted no frame within 20 s (${deferred} deferred)`);
    await delay(10);
  }
  await h.device.queue.onSubmittedWorkDone();
  return deferred;
}

/** One submitted frame read back through the renderer's own post-pass colour capture. */
async function captureOnce(h, options) {
  h.deferredFrames += await warm(h, options);
  let settled = false;
  const pending = h.renderer.captureColorFrame().finally(() => { settled = true; });
  let submitted = 0;
  for (let attempt = 0; attempt < 6 && !settled; attempt++) {
    if (h.renderer.renderWithResult(options)) submitted++;
    await h.device.queue.onSubmittedWorkDone();
    await nextTask();
  }
  const frame = await pending;
  if (!frame) throw new Error(`${h.label}: colour-frame capture was cancelled after ${submitted} submitted frames`);
  return frame;
}

/** Repeat until two consecutive submitted frames are byte-identical. */
async function stableCapture(h, name, options, { keep = false } = {}) {
  let previous = await captureOnce(h, options), frames = 1, stable = false;
  while (frames < 6) {
    const next = await captureOnce(h, options);
    frames++;
    stable = sameBytes(previous.rgba, next.rgba);
    previous = next;
    if (stable) break;
  }
  const frame = { name, width: previous.width, height: previous.height, rgba: previous.rgba, stable, frames };
  h.captures.push({ name, size: [frame.width, frame.height], stable, frames, sha256: await sha256(frame.rgba) });
  if (keep) h.images[`${h.label}-${name}`] = await pngBase64(frame);
  return frame;
}

/**
 * Drive frames until the adapter reports every live handle resident and the
 * packed row count matches; uploads and compaction finish asynchronously.
 */
async function settle(h, { handles = [], rows = 0, options = BASE_OPTIONS } = {}) {
  const adapter = h.adapter;
  for (let frame = 0; frame < 240; frame++) {
    const stats = adapter.getStats();
    const states = handles.map(handle => adapter.getState(handle).state);
    if (stats.splats === rows && states.every(state => state === 'resident')) return { frames: frame, stats: plain(stats) };
    h.renderer.render(options);
    await h.device.queue.onSubmittedWorkDone();
    await delay(4);
  }
  throw new Error(`${h.label}: Gaussian layer did not settle: ${JSON.stringify({ rows, stats: adapter.getStats(), states: handles.map(handle => adapter.getState(handle)) })}`);
}

export async function openRenderer(label, size = SIZE) {
  setPhase(`${label}:init`);
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', `witness ${label}`);
  resizeCanvas(canvas, size);
  document.querySelector('#stage').append(canvas);
  const renderer = new Renderer(canvas);
  const readiness = { beforeInit: plain(renderer.getGaussianReadiness()) };
  await renderer.init();
  readiness.afterInit = plain(renderer.getGaussianReadiness());
  const device = renderer.getGPUDevice();
  if (!device) throw new Error(`${label}: renderer initialized without a GPU device`);
  const h = { label, canvas, renderer, device, readiness, captures: [], images: {}, handles: [], gpuErrors: [], losses: [], deferredFrames: 0 };
  h.watchDevice = target => target.addEventListener('uncapturederror', event => { if (h.gpuErrors.length < 16) h.gpuErrors.push({ phase, message: event.error.message }); });
  h.watchDevice(device);
  h.unsubscribe = renderer.onDeviceLost(info => h.losses.push({ phase, ...info }));
  h.adapter = typeof renderer.gaussianSplats?.add === 'function' ? renderer.gaussianSplats : null;
  resetCamera(renderer.getCamera());
  h.capture = (name, options = BASE_OPTIONS, flags) => stableCapture(h, name, options, flags);
  h.settle = spec => settle(h, spec);
  h.add = async (rows, place = placement()) => {
    const handle = await h.adapter.add({ attributes: gaussians(rows), placement: place, modelIndex: 0 }, QUALIFICATION);
    h.handles.push(handle);
    return handle;
  };
  setPhase(label);
  return h;
}

const outcome = promise => promise.then(value => ({ resolved: plain(value) }),
  error => ({ rejected: { name: error?.name, code: error?.code ?? null, message: String(error?.message ?? error) } }));

/** Tear the renderer down and record who destroyed the device, when, and what survived. */
export async function closeRenderer(h) {
  const diagnostics = h.renderer.getDiagnostics();
  const destroysBefore = destroyCalls(h.device).length;
  const lossesBefore = h.losses.length;
  const lost = h.device.lost.then(info => ({ reason: info.reason, message: info.message }));
  setPhase(`${h.label}:teardown`);
  // Handlers attach synchronously so an in-flight rejection is never unhandled.
  const inflight = h.beforeDestroy ? outcome(h.beforeDestroy()) : null;
  h.renderer.destroy();
  const teardownDestroys = destroyCalls(h.device).slice(destroysBefore);
  const lostInfo = await Promise.race([lost, delay(2000).then(() => null)]);
  setPhase(`${h.label}:after-destroy`);
  const lifetime = {
    destroyCallsBeforeTeardown: destroysBefore,
    destroyCallsDuringTeardown: teardownDestroys.length,
    teardownDestroyPhases: teardownDestroys.map(entry => entry.phase),
    teardownDestroyStack: teardownDestroys[0]?.stack ?? null,
    lostAfterDestroy: lostInfo,
    deviceLossesBeforeTeardown: h.losses.slice(0, lossesBefore),
    deviceLossesAfterTeardown: h.losses.slice(lossesBefore),
    gpuErrors: [...h.gpuErrors],
    diagnostics: { renderErrors: diagnostics.errors, lastRenderError: diagnostics.lastError, gpuErrors: diagnostics.gpuErrors, lastGpuError: diagnostics.lastGpuError },
    submittedAfterDestroy: h.renderer.renderWithResult(BASE_OPTIONS),
    readinessAfterDestroy: plain(h.renderer.getGaussianReadiness()),
    readiness: h.readiness,
  };
  if (h.adapter) {
    lifetime.inflightAddAtDestroy = inflight ? await inflight : null;
    lifetime.statesAfterDestroy = h.handles.map(handle => plain(h.adapter.getState(handle)));
    lifetime.statsAfterDestroy = plain(h.adapter.getStats());
    lifetime.addAfterDestroy = await outcome(h.adapter.add({ attributes: gaussians([{ x: 0, y: 0, z: 0, sigma: 0.1, opacity: 0.5, color: RED }]),
      placement: placement(), modelIndex: 0 }, QUALIFICATION));
  }
  h.unsubscribe();
  h.canvas.remove();
  return lifetime;
}
