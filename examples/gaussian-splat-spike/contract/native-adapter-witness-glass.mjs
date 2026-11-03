/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 option B: splats and transparent IFC composed by the nearest-glass split.
// References never run the split: the glass is captured alone over a black and a
// white clear colour, and the splats alone with the glass hidden. Straight-alpha
// blending is affine in the destination, so per channel the glass over the splats
// is B0 + (B1 - B0) * A / 255 (B0, B1: glass over black / white; A: splats over
// black). Each capture is rounded once, so the true value lies within 1/255 of that.
// Measurements only; native-adapter-acceptance.mjs judges.
import { BASE_OPTIONS, GREEN, RED, boxMesh, compare, footprint, pixelAt, plain, resetCamera, resizeCanvas } from './native-adapter-witness-lib.mjs';
import { glassOverSplats } from './native-adapter-glass-reference.mjs';

const PENDING = Object.freeze({ status: 'pending', reason: 'renderer.gaussianSplats is not available in this build' });
const GLASS_ID = 21, FAR_GLASS_ID = 22;
const GLASS = [0.3, 0.6, 0.9, 0.5], FAR_GLASS = [0.9, 0.6, 0.3, 0.5];
/** Behind the pane at z = 0 (glass must tint it) and in front of it (unchanged by the split). */
const BEHIND = { x: -0.5, y: 0, z: -1, sigma: 0.12, opacity: 0.9, color: RED };
const FRONT = { x: 0.6, y: 0, z: 1, sigma: 0.12, opacity: 0.9, color: GREEN };
const WHITE = Object.freeze({ ...BASE_OPTIONS, clearColor: [1, 1, 1, 1] });
const size = frame => ({ width: frame.width, height: frame.height });

/** One screen-parallel pane: a single transparent surface, so every sample has at most one layer. */
function pane(expressId, z, [x0, y0, x1, y1], color) {
  return { expressId, ifcType: 'IfcBuildingElementProxy', color,
    positions: new Float32Array([x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}

/** Everything except `region`. */
function outside(region, frame) {
  return { describe: { outside: region.describe }, bounds: [0, 0, frame.width - 1, frame.height - 1], contains: (x, y) => !region.contains(x, y) };
}

/** Raw occlusion-query result behind `transparentLayers` (internal): a sample count, or any positive value where occlusion is binary (D3D12). */
const rawLayerQuery = h => h.renderer['gaussianLayer']?.glass?.split?.split?.layerSamples ?? null;

/**
 * Render until frames split and a layer count has read back, then a few more so the
 * reported count comes from a frame after the latest scene change (it reports the
 * latest count read back, which can lag by a frame or two).
 */
async function settledReport(h, options) {
  const frame = async () => { h.renderer.render(options); await h.device.queue.onSubmittedWorkDone(); await new Promise(resolve => setTimeout(resolve, 10)); };
  for (let n = 0; n < 60; n++) {
    const report = h.adapter.getStats().compositionReport;
    if (report?.composition === 'nearest-glass-split' && report.transparentLayers !== 'unknown') break;
    await frame();
  }
  for (let n = 0; n < 4; n++) await frame();
  return { ...plain(h.adapter.getStats().compositionReport), rawLayerQuery: rawLayerQuery(h) };
}

/** Sizes per scene: the second resizes the canvas, so P1 and every MSAA target are reallocated. */
const SIZES = [{ width: 321, height: 241 }, { width: 401, height: 301 }];

/** References, the split frame and the single-pass frame at the current canvas size. */
async function measure(h, view, tag) {
  const hidden = { ...BASE_OPTIONS, hiddenIds: new Set([GLASS_ID]) };
  h.adapter.setVisible(h.handles[0], false);
  const glassBlack = await h.capture(`${tag}-glass-black`, BASE_OPTIONS, { keep: true });
  const glassWhite = await h.capture(`${tag}-glass-white`, WHITE);
  h.adapter.setVisible(h.handles[0], true);
  const splats = await h.capture(`${tag}-splats-no-glass`, hidden, { keep: true });
  const noTransparent = plain(h.adapter.getStats().compositionReport);
  const splitReport = await settledReport(h, BASE_OPTIONS);
  const split = await h.capture(`${tag}-split`, BASE_OPTIONS, { keep: true });
  h.adapter.setCompositionMode('single-pass');
  const single = await h.capture(`${tag}-single-pass`, BASE_OPTIONS, { keep: true });
  const singleReport = plain(h.adapter.getStats().compositionReport);
  const singleNoGlass = await h.capture(`${tag}-single-pass-no-glass`, hidden);
  h.adapter.setCompositionMode('nearest-glass-split');
  const s = size(split), behind = footprint(BEHIND, s, view), front = footprint(FRONT, s, view);
  return {
    size: [s.width, s.height], whiteClear: pixelAt(glassWhite, 1, 1), blackClear: pixelAt(glassBlack, 1, 1),
    glassCentre: pixelAt(glassBlack, Math.floor(s.width / 2), Math.floor(s.height / 2)),
    behindMatchesReference: glassOverSplats(split, glassBlack, glassWhite, splats, behind),
    approximateMissesReference: glassOverSplats(single, glassBlack, glassWhite, splats, behind),
    frontEqualsSinglePass: compare(split, single, front),
    restEqualsSinglePass: compare(split, single, outside(behind, split)),
    noTransparentEqualsSinglePass: compare(splats, singleNoGlass),
    behindVisible: compare(split, glassBlack, behind),
    reports: { noTransparent, split: splitReport, single: singleReport },
  };
}

function splitScene(view) {
  return async function nearestGlassSplit(h) {
    const { renderer, canvas } = h;
    resetCamera(renderer.getCamera(), view.projection, view.orthoSize);
    renderer.addMeshes([pane(GLASS_ID, 0, [-1.6, -1, 1.6, 1], GLASS)]);
    const glass = await h.capture('glass', BASE_OPTIONS);
    const baseline = { sampleCount: renderer['pipeline']?.getSampleCount?.() ?? null, projection: view.projection,
      glassCentre: pixelAt(glass, Math.floor(glass.width / 2), Math.floor(glass.height / 2)) };
    if (!h.adapter) return { baseline, splat: PENDING };
    const handle = await h.add([BEHIND, FRONT]);
    await h.settle({ handles: [handle], rows: 2 });
    const sizes = {};
    for (const [i, target] of SIZES.entries()) {
      resizeCanvas(canvas, target);
      sizes[`${target.width}x${target.height}`] = await measure(h, view, `size${i}`);
    }
    // A second pane behind the rear splat: two transparent surfaces at some samples.
    renderer.addMeshes([pane(FAR_GLASS_ID, -2, [-1.6, -1, 1.6, 1], FAR_GLASS)]);
    const twoPanes = await settledReport(h, BASE_OPTIONS);
    await h.capture('two-panes', BASE_OPTIONS, { keep: true });
    return { baseline, splat: { sizes, twoPanes, readiness: plain(renderer.getGaussianReadiness()) } };
  };
}

const XRAY_IDS = [31, 32, 33, 34];
/**
 * #8564 review: X-Ray ghosts stack transparent surfaces (each box has a front and a back
 * face), so the split reports `multiple` there. Measures how much of the frame that is.
 */
export async function nearestGlassSplitXray(h) {
  const { renderer } = h;
  resetCamera(renderer.getCamera());
  renderer.addMeshes(XRAY_IDS.map((id, i) => boxMesh(id, [-1.8 + i * 0.95, -0.8, -0.6], [-1.0 + i * 0.95, 0.8, 0.2], [0.6, 0.6, 0.65, 1])));
  const xray = { ...BASE_OPTIONS, ghostExceptIds: new Set([XRAY_IDS[0]]) };
  const baseline = { sampleCount: renderer['pipeline']?.getSampleCount?.() ?? null };
  if (!h.adapter) return { baseline, splat: PENDING };
  const handle = await h.add([BEHIND, FRONT, { ...BEHIND, x: 0.9, z: -0.3, color: GREEN }]);
  await h.settle({ handles: [handle], rows: 3 });
  const report = await settledReport(h, xray);
  const frame = await h.capture('xray', xray, { keep: true });
  const withoutGhosts = await h.capture('xray-ghosts-hidden', { ...BASE_OPTIONS, hiddenIds: new Set(XRAY_IDS.slice(1)) });
  const ghostPixels = compare(frame, withoutGhosts).changed, samples = baseline.sampleCount ?? 1;
  const opaque = await settledReport(h, BASE_OPTIONS);
  // Fractions only mean something where the query counts samples (SwiftShader); D3D12 answers in binary.
  const raw = report.rawLayerQuery;
  return { baseline, splat: { report, opaque, frameSamples: frame.width * frame.height * samples, ghostSamples: ghostPixels * samples,
    rawLayerQuery: raw, multiLayerFractionOfGhosts: raw === null || !ghostPixels ? null : raw / (ghostPixels * samples) } };
}

/**
 * Renderer.init() at 1x MSAA: the pipeline reads `limits.maxSampleCount` (absent in
 * WebGPU, so it defaults to 4); the witness reports 1 for the next device only.
 */
export function forceSingleSample() {
  const original = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function singleSampleDevice(...args) {
    const device = await original.apply(this, args);
    const limits = {};
    for (const key in device.limits) limits[key] = device.limits[key];
    Object.defineProperty(device, 'limits', { value: Object.freeze({ ...limits, maxSampleCount: 1 }) });
    return device;
  };
  return () => { GPUAdapter.prototype.requestDevice = original; };
}

const singleSample = (scene) => Object.assign(scene, { samples: 1 });

/** Perspective and orthographic at 4x and 1x MSAA; every scene also resizes. */
export const GLASS_SCENES = {
  nearestGlassSplit: splitScene({ projection: 'perspective' }),
  nearestGlassSplitOrthographic: splitScene({ projection: 'orthographic', orthoSize: 2.5 }),
  nearestGlassSplitSingleSample: singleSample(splitScene({ projection: 'perspective' })),
  nearestGlassSplitOrthographicSingleSample: singleSample(splitScene({ projection: 'orthographic', orthoSize: 2.5 })),
  nearestGlassSplitXray,
};
