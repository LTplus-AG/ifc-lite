/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 synthetic scenes for the internal, unqualified native Gaussian adapter.
// Every splat assertion has a reference that does not run the code under test:
// analytic colours, frames captured before any splat existed, or the same rows
// through a different packing. Measurements only; validate-native-adapter.mjs judges.
import {
  BASE_OPTIONS, BLUE, GREEN, MAGENTA, RED, SIZE, boxMesh, centrePixel, compare, composite, destroyCalls, disc, expectSplat,
  footprint, nonBackground, pixelAt, placement, plain, pointPatch, project, rect, resetCamera, resizeCanvas, setPhase,
} from './native-adapter-witness-lib.mjs';

const PENDING = Object.freeze({ status: 'pending', reason: 'renderer.gaussianSplats is not available in this build' });
const OPAQUE = 0.9975;
const BOX_ID = 1;
const box = () => boxMesh(BOX_ID, [-1, -1, -0.25], [1, 1, 0.25], [0.55, 0.55, 0.55, 1]);
const FRONT = { x: -0.5, y: -0.45, z: 1.5, sigma: 0.12, opacity: OPAQUE, color: RED };
const REAR = { x: 0.5, y: -0.45, z: -1.5, sigma: 0.12, opacity: OPAQUE, color: BLUE };
const MIDDLE = { x: -0.55, y: 0.55, z: 0.6, sigma: 0.06, opacity: OPAQUE, color: MAGENTA };
const PATCH = { min: [-0.95, 0.15], max: [-0.15, 0.95], z: 1.0, step: 0.02 };
const POINT_OPTIONS = { colorMode: 'fixed', fixedColor: [0, 1, 0, 1], sizeMode: 'fixed-px', pointSize: 3, roundShape: false };
const size = frame => ({ width: frame.width, height: frame.height });

/** Leftmost/rightmost lit columns on the centre row and top/bottom rows on the centre column. */
function silhouette(frame) {
  const row = Math.floor(frame.height / 2), column = Math.floor(frame.width / 2);
  const lit = (x, y) => Math.max(...pixelAt(frame, x, y).slice(0, 3)) > 8;
  const xs = [...Array(frame.width).keys()].filter(x => lit(x, row));
  const ys = [...Array(frame.height).keys()].filter(y => lit(column, y));
  return { left: xs[0] ?? null, right: xs.at(-1) ?? null, top: ys[0] ?? null, bottom: ys.at(-1) ?? null };
}
/** Analytic silhouette of the box's front face (z = 0.25, half extent 1 m). */
function expectedSilhouette(frame, view) {
  const s = size(frame);
  const [left, top] = project({ x: -1, y: 1, z: 0.25 }, s, view), [right, bottom] = project({ x: 1, y: -1, z: 0.25 }, s, view);
  return { left, right, top, bottom };
}
function projectionAgreement(renderer, rows, s) {
  const camera = renderer.getCamera();
  return Math.max(...rows.map(row => {
    const ours = project(row, s), theirs = camera.projectToScreen(row, s.width, s.height);
    return theirs ? Math.hypot(ours[0] - theirs.x, ours[1] - theirs.y) : Infinity;
  }));
}

/** a) Opaque IFC and point-cloud occlusion with analytic colours and pre-splat references. */
export async function occlusion(h) {
  const { renderer } = h;
  renderer.addMeshes([box()]);
  renderer.setPointCloudOptions(POINT_OPTIONS);
  renderer.addPointClouds([pointPatch(2, PATCH)]);
  const boxPoints = await h.capture('box-points');
  renderer.clearPointClouds();
  const boxOnly = await h.capture('box', BASE_OPTIONS, { keep: true });
  const patchCentre = centrePixel({ x: -0.55, y: 0.55, z: PATCH.z }, size(boxPoints));
  const baseline = {
    projectionAgreementPx: projectionAgreement(renderer, [FRONT, REAR, MIDDLE], size(boxOnly)),
    silhouette: silhouette(boxOnly), expectedSilhouette: expectedSilhouette(boxOnly),
    corner: pixelAt(boxOnly, 2, 2), patchCentre: pixelAt(boxPoints, ...patchCentre),
    patchCoversMiddleFootprint: compare(boxPoints, boxOnly, footprint(MIDDLE, size(boxOnly))),
  };
  if (!h.adapter) return { baseline, splat: PENDING };
  const handle = await h.add([FRONT, REAR, MIDDLE]);
  await h.settle({ handles: [handle], rows: 3 });
  const splats = await h.capture('box-splats', BASE_OPTIONS, { keep: true });
  const hidden = { ...BASE_OPTIONS, hiddenIds: new Set([BOX_ID]) };
  const boxHidden = await h.capture('box-hidden-splats', hidden, { keep: true });
  renderer.addPointClouds([pointPatch(2, PATCH)]);
  const splatsPoints = await h.capture('box-points-splats', BASE_OPTIONS, { keep: true });
  return {
    baseline,
    splat: {
      frontOverBox: expectSplat(splats, boxOnly, FRONT),
      rearOccludedByBox: compare(splats, boxOnly, footprint(REAR, size(splats))),
      rearVisibleWithoutBox: expectSplat(boxHidden, null, REAR),
      middleVisibleWithoutPoints: expectSplat(splats, boxOnly, MIDDLE),
      middleOccludedByPoints: compare(splatsPoints, boxPoints, footprint(MIDDLE, size(splats))),
      frontOverPoints: expectSplat(splatsPoints, boxPoints, FRONT),
      state: plain(h.adapter.getState(handle)), bounds: plain(h.adapter.getBounds(handle)), stats: plain(h.adapter.getStats()),
    },
  };
}

// b) 96 rows alternate between two assets in strict depth order: 96 interleaved runs.
const ORDER = Array.from({ length: 96 }, (_, i) => ({ x: 0, y: 0, z: -2 + 4 * i / 95, sigma: 0.1 + 0.03 * (i % 5),
  opacity: 0.25 + 0.05 * (i % 3), color: i % 2 ? BLUE : RED, source: i % 2 }));
const layers = rows => rows.map(row => ({ color: row.color, alpha: row.opacity }));
const round = values => values.map(v => Math.round(v * 100) / 100);

/** b) Global order across two packed assets equals the identical rows as one asset, and the analytic order. */
export async function globalOrder(h) {
  const a = ORDER.filter(row => !row.source), b = ORDER.filter(row => row.source);
  const empty = await h.capture('empty');
  const centre = [Math.floor(SIZE.width / 2), Math.floor(SIZE.height / 2)];
  let runs = 1;
  for (let i = 1; i < ORDER.length; i++) if (ORDER[i].source !== ORDER[i - 1].source) runs++;
  const baseline = {
    emptyLitPixels: nonBackground(empty), runs, centrePixel: centre,
    // The axis pixel's Gaussian weight is exactly one for every row, so the
    // back-to-front (ascending z) composite is closed form.
    expectedCentre: round(composite([0, 0, 0], layers(ORDER))),
    perAssetOrders: { aThenB: round(composite([0, 0, 0], layers([...a, ...b]))), bThenA: round(composite([0, 0, 0], layers([...b, ...a]))) },
  };
  if (!h.adapter) return { baseline, splat: PENDING };
  const ha = await h.add(a), hb = await h.add(b);
  await h.settle({ handles: [ha, hb], rows: 96 });
  const two = await h.capture('two-assets', BASE_OPTIONS, { keep: true });
  const removed = [h.adapter.remove(ha), h.adapter.remove(hb)];
  await h.settle({ rows: 0 });
  const hb2 = await h.add(b), ha2 = await h.add(a);
  await h.settle({ handles: [hb2, ha2], rows: 96 });
  const reversed = await h.capture('two-assets-reversed-add');
  h.adapter.clear();
  await h.settle({ rows: 0 });
  const one = await h.add([...a, ...b]);
  await h.settle({ handles: [one], rows: 96 });
  const single = await h.capture('one-asset', BASE_OPTIONS, { keep: true });
  return {
    baseline,
    splat: {
      removed, twoVsOne: compare(two, single), reversedAddVsOne: compare(reversed, single),
      centre: { one: pixelAt(single, ...centre), two: pixelAt(two, ...centre) },
      litPixels: nonBackground(single), stats: plain(h.adapter.getStats()),
    },
  };
}

const VIEWS = [
  { name: 'perspective-321', size: SIZE, view: { projection: 'perspective' } },
  { name: 'perspective-401', size: { width: 401, height: 301 }, view: { projection: 'perspective' } },
  { name: 'orthographic-321', size: SIZE, view: { projection: 'orthographic', orthoSize: 2.5 } },
];

/** c) Perspective and orthographic, the viewer's MSAA targets, and resizes between frames. */
export async function projectionMsaaResize(h) {
  const { renderer, canvas } = h;
  renderer.addMeshes([box()]);
  const apply = ({ size: s, view }) => { resizeCanvas(canvas, s); resetCamera(renderer.getCamera(), view.projection, view.orthoSize); };
  const references = {};
  for (const config of VIEWS) { apply(config); references[config.name] = await h.capture(`${config.name}-box`); }
  const baseline = {
    sampleCount: renderer.getPipeline()?.getSampleCount() ?? null,
    views: Object.fromEntries(VIEWS.map(({ name, view }) => [name, { size: [references[name].width, references[name].height],
      silhouette: silhouette(references[name]), expectedSilhouette: expectedSilhouette(references[name], view) }])),
  };
  if (!h.adapter) return { baseline, splat: PENDING };
  apply(VIEWS[0]);
  const handle = await h.add([FRONT, REAR]);
  await h.settle({ handles: [handle], rows: 2 });
  const splat = {};
  for (const config of VIEWS) {
    apply(config);
    const frame = await h.capture(`${config.name}-splats`, BASE_OPTIONS, { keep: true });
    splat[config.name] = { size: [frame.width, frame.height], frontOverBox: expectSplat(frame, references[config.name], FRONT, config.view),
      rearOccludedByBox: compare(frame, references[config.name], footprint(REAR, size(frame), config.view)) };
    if (config === VIEWS[0]) splat.first = frame;
  }
  apply(VIEWS[0]);
  const again = await h.capture('perspective-321-after-resizes');
  splat.resizeRoundTrip = compare(again, splat.first);
  delete splat.first;
  return { baseline, splat };
}

const CLIP_ROWS = [-0.6, -0.2, 0.2, 0.6].map((x, i) => ({ x, y: 0, z: 0, sigma: 0.15, opacity: 0.9, color: [RED, BLUE, GREEN, MAGENTA][i] }));
const plane = (flipped, distance = 0) => ({ axis: 'side', position: 50, enabled: true, normal: [1, 0, 0], distance, flipped,
  showGizmo: false, showCap: false, showOutlines: false });
const CLIP_OPTIONS = {
  plane: { ...BASE_OPTIONS, sectionPlane: plane(false) },
  flipped: { ...BASE_OPTIONS, sectionPlane: plane(true) },
  box: { ...BASE_OPTIONS, clipBox: { enabled: true, min: [-0.4, -1, -1], max: [0.4, 1, 1] } },
  all: { ...BASE_OPTIONS, sectionPlane: plane(false, -5) },
};
/** Sample the strip mesh (y in [-0.9, -0.75]) left and right of the plane: the renderer's own side convention. */
function stripSides(frame) {
  const s = size(frame);
  const [left, y] = centrePixel({ x: -0.8, y: -0.82, z: 0.05 }, s), [middle] = centrePixel({ x: -0.1, y: -0.82, z: 0.05 }, s);
  const [right] = centrePixel({ x: 0.8, y: -0.82, z: 0.05 }, s);
  const lit = x => Math.max(...pixelAt(frame, x, y).slice(0, 3)) > 8;
  return { left: lit(left), middle: lit(middle), right: lit(right) };
}

/** d) Whole-Gaussian centre clipping by section plane (both sides) and clip box. */
export async function centreClipping(h) {
  h.renderer.addMeshes([boxMesh(3, [-1.2, -0.9, 0], [1.2, -0.75, 0.05], [0.9, 0.9, 0.9, 1])]);
  const empty = { none: await h.capture('empty') };
  for (const [name, options] of Object.entries(CLIP_OPTIONS)) empty[name] = await h.capture(`${name}-empty`, options);
  const baseline = { strip: Object.fromEntries(Object.entries(empty).map(([name, frame]) => [name, stripSides(frame)])) };
  if (!h.adapter) return { baseline, splat: PENDING };
  // Splat band rows only: the strip lies below it and is clipped as a mesh.
  const s = size(empty.none);
  const top = Math.floor(project({ x: 0, y: 0.62, z: 0 }, s)[1]), bottom = Math.ceil(project({ x: 0, y: -0.62, z: 0 }, s)[1]);
  const band = rect(0, top, s.width - 1, bottom);
  const subsets = { left: CLIP_ROWS.filter(r => r.x < 0), right: CLIP_ROWS.filter(r => r.x > 0), middle: CLIP_ROWS.filter(r => Math.abs(r.x) < 0.4), all: CLIP_ROWS };
  const reference = {};
  for (const [name, rows] of Object.entries(subsets)) {
    const handle = await h.add(rows);
    await h.settle({ handles: [handle], rows: rows.length });
    reference[name] = await h.capture(`${name}-unclipped`, BASE_OPTIONS, { keep: name === 'all' });
    h.adapter.remove(handle);
    await h.settle({ rows: 0 });
  }
  const handle = await h.add(CLIP_ROWS);
  const clipped = {};
  for (const [name, options] of Object.entries(CLIP_OPTIONS)) {
    await h.settle({ handles: [handle], rows: CLIP_ROWS.length, options });
    clipped[name] = await h.capture(`${name}-splats`, options, { keep: name !== 'all' });
  }
  // The kept blue Gaussian (x = -0.2) reaches past x = 0: centre clipping must keep its whole footprint.
  const [planeX] = project({ x: 0, y: 0, z: 0 }, s);
  const crossing = rect(Math.ceil(planeX) + 1, Math.floor(s.height / 2) - 3, Math.floor(project({ x: 0.25, y: 0, z: 0 }, s)[0]), Math.floor(s.height / 2) + 3);
  return {
    baseline,
    splat: {
      band: band.describe,
      planeKeepsLeftCentres: compare(clipped.plane, reference.left, band),
      flippedKeepsRightCentres: compare(clipped.flipped, reference.right, band),
      boxKeepsInnerCentres: compare(clipped.box, reference.middle, band),
      allClippedEqualsEmpty: compare(clipped.all, empty.all),
      unclippedDiffersFromLeft: compare(reference.all, reference.left, band),
      keptFootprintCrossesPlane: { region: crossing.describe, litPixels: nonBackground(clipped.plane, crossing) },
      strip: { plane: stripSides(clipped.plane), flipped: stripSides(clipped.flipped), box: stripSides(clipped.box) },
    },
  };
}

const VIS_A = { x: -0.5, y: 0, z: 1, sigma: 0.12, opacity: OPAQUE, color: RED };
const VIS_B = { x: 0.5, y: 0, z: 0.8, sigma: 0.12, opacity: OPAQUE, color: BLUE };

/** e) Hide, show, move, remove, re-add and clear return to exact earlier frames. */
export async function removalVisibility(h) {
  h.renderer.addMeshes([box()]);
  const none = await h.capture('no-splats');
  const baseline = { boxCentre: pixelAt(none, Math.floor(none.width / 2), Math.floor(none.height / 2)), corner: pixelAt(none, 2, 2) };
  if (!h.adapter) return { baseline, splat: PENDING };
  const { adapter } = h;
  const after = async (name, reference, spec) => { await h.settle(spec); return compare(await h.capture(name), reference); };
  const hb = await h.add([VIS_B]);
  await h.settle({ handles: [hb], rows: 1 });
  const onlyB = await h.capture('only-b');
  const ha = await h.add([VIS_A]);
  await h.settle({ handles: [ha, hb], rows: 2 });
  const both = await h.capture('both', BASE_OPTIONS, { keep: true });
  const live = { handles: [ha, hb], rows: 2 };
  const steps = { bothDifferFromNone: compare(both, none) };
  steps.hideA = { returned: adapter.setVisible(ha, false), equalsOnlyB: await after('hide-a', onlyB, live) };
  steps.hideBoth = { returned: adapter.setVisible(hb, false), equalsNone: await after('hide-both', none, live), stats: plain(adapter.getStats()) };
  steps.showBoth = { returned: [adapter.setVisible(ha, true), adapter.setVisible(hb, true)], equalsBoth: await after('show-both', both, live) };
  const moved = { ...VIS_A, y: 0.5 };
  steps.move = { returned: await adapter.setPlacement(ha, placement([0, 0.5, 0])), bounds: plain(adapter.getBounds(ha)) };
  await h.settle(live);
  const movedFrame = await h.capture('moved-a', BASE_OPTIONS, { keep: true });
  const [ox, oy] = project(VIS_A, size(none));
  steps.move.newCentre = expectSplat(movedFrame, none, moved);
  steps.move.oldCentreCleared = compare(movedFrame, none, disc(ox, oy, 2));
  steps.moveBack = { returned: await adapter.setPlacement(ha, placement()), equalsBoth: await after('moved-back', both, live) };
  steps.removeA = { returned: adapter.remove(ha), equalsOnlyB: await after('remove-a', onlyB, { handles: [hb], rows: 1 }) };
  steps.staleHandle = { remove: adapter.remove(ha), setVisible: adapter.setVisible(ha, true),
    setPlacement: await adapter.setPlacement(ha, placement()), state: plain(adapter.getState(ha)), bounds: plain(adapter.getBounds(ha)) };
  steps.removeB = { returned: adapter.remove(hb), equalsNone: await after('remove-b', none, { rows: 0 }) };
  const ha2 = await h.add([VIS_A]), hb2 = await h.add([VIS_B]);
  steps.readd = { equalsBoth: await after('re-add', both, { handles: [ha2, hb2], rows: 2 }) };
  adapter.clear();
  steps.clear = { equalsNone: await after('clear', none, { rows: 0 }), stats: plain(adapter.getStats()),
    states: [plain(adapter.getState(ha2)), plain(adapter.getState(hb2))], bounds: plain(adapter.getBounds()) };
  return { baseline, splat: steps };
}

/** f) Destroy the renderer with resident assets and an add in flight; the runner records the teardown. */
export async function deviceLifetime(h) {
  h.renderer.addMeshes([box()]);
  const none = await h.capture('no-splats');
  const baseline = { boxCentre: pixelAt(none, Math.floor(none.width / 2), Math.floor(none.height / 2)) };
  if (!h.adapter) return { baseline, splat: PENDING };
  const handle = await h.add([VIS_A, VIS_B]);
  await h.settle({ handles: [handle], rows: 2 });
  const frame = await h.capture('before-destroy');
  // Started synchronously before destroy(): it must never publish afterwards.
  h.beforeDestroy = () => h.add([{ ...VIS_A, x: 0 }]);
  return { baseline, splat: { drawnBeforeTeardown: expectSplat(frame, none, VIS_A), stats: plain(h.adapter.getStats()) } };
}

const OVER_EMPTY = { x: 1.6, y: 0.9, z: 0.5, sigma: 0.12, opacity: OPAQUE, color: BLUE };

/** g) Gaussians are not pickable: the renderer's real pick path passes through them. */
export async function picking(h) {
  h.renderer.addMeshes([box()]);
  const none = await h.capture('no-splats');
  const s = size(none);
  // Pixel centres in canvas CSS pixels (devicePixelRatio is 1 in this harness).
  const at = row => centrePixel(row, s).map(v => v + 0.5);
  const pickAll = async () => ({ overBox: plain(await h.renderer.pick(...at(FRONT))), overEmpty: plain(await h.renderer.pick(...at(OVER_EMPTY))) });
  const without = await pickAll();
  const baseline = { pixels: { overBox: at(FRONT), overEmpty: at(OVER_EMPTY) }, picksWithoutSplats: without, overEmptyBackground: pixelAt(none, ...centrePixel(OVER_EMPTY, s)) };
  if (!h.adapter) return { baseline, splat: PENDING };
  const handle = await h.add([FRONT, OVER_EMPTY]);
  await h.settle({ handles: [handle], rows: 2 });
  const frame = await h.capture('splats', BASE_OPTIONS, { keep: true });
  const withSplats = await pickAll();
  const removed = h.adapter.remove(handle);
  await h.settle({ rows: 0 });
  await h.capture('removed');
  const afterRemoval = await pickAll();
  return { baseline, splat: { drawnOverBox: expectSplat(frame, none, FRONT), drawnOverEmpty: expectSplat(frame, null, OVER_EMPTY),
    withSplats, afterRemoval, removed } };
}

async function waitFor(predicate, ms) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > ms) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return true;
}
const describeRecovery = result => result.ok ? { ok: true, omissions: [...result.omissions] }
  : { ok: false, reason: result.reason, error: result.error === undefined ? null : String(result.error?.stack ?? result.error) };

/** h) A real device loss (raw GPUDevice.destroy, not renderer.destroy) and in-place recovery. IFC + Gaussians only. */
export async function deviceRecovery(h) {
  const { renderer } = h;
  renderer.addMeshes([box()]);
  const none = await h.capture('no-splats');
  const baseline = { boxCentre: pixelAt(none, Math.floor(none.width / 2), Math.floor(none.height / 2)) };
  if (!h.adapter) return { baseline, splat: PENDING };
  const { adapter } = h;
  const handle = await h.add([VIS_A, VIS_B]);
  await h.settle({ handles: [handle], rows: 2 });
  const reference = await h.capture('before-loss', BASE_OPTIONS, { keep: true });
  const before = { readiness: plain(renderer.getGaussianReadiness()), state: plain(adapter.getState(handle)) };
  const lost = h.device;
  setPhase(`${h.label}:induce-loss`);
  lost.destroy(); // #7655: every loss of the current device reaches the renderer's handler
  setPhase(h.label);
  const latched = await waitFor(() => renderer.isDeviceLost(), 5000);
  const whileLost = { isDeviceLost: renderer.isDeviceLost(), readiness: plain(renderer.getGaussianReadiness()), state: plain(adapter.getState(handle)),
    submitted: renderer.renderWithResult(BASE_OPTIONS), losses: plain(h.losses) };
  const recovery = describeRecovery(await renderer.recoverDevice());
  const replacement = renderer.getGPUDevice();
  if (!replacement || replacement === lost) return { baseline, splat: { before, latched, whileLost, recovery, replacementIsNew: false } };
  h.device = replacement;
  h.watchDevice(replacement);
  const settled = await h.settle({ handles: [handle], rows: 2 });
  const after = await h.capture('after-recovery', BASE_OPTIONS, { keep: true });
  return {
    baseline,
    splat: {
      before, latched, whileLost, recovery, replacementIsNew: true, settleFrames: settled.frames,
      after: { readiness: plain(renderer.getGaussianReadiness()), state: plain(adapter.getState(handle)) },
      recoveredEqualsReference: compare(after, reference),
      sameHandleUsable: { setVisible: adapter.setVisible(handle, true), bounds: plain(adapter.getBounds(handle)) },
      destroyCallsOnLostDevice: destroyCalls(lost).map(({ phase, stack }) => ({ phase, stack })),
    },
  };
}

export const SCENES = { occlusion, globalOrder, projectionMsaaResize, centreClipping, removalVisibility, deviceLifetime, picking, deviceRecovery };
