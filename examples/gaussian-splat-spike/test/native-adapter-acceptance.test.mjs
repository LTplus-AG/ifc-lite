/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../contract/native-adapter-acceptance.mjs';

// #8564: the GPU witness only measures; these CPU tests prove the acceptance
// table rejects the failing control shapes instead of passing vacuously.
const exact = (compared = 100) => ({ comparable: true, region: 'frame', compared, changed: 0, maxDelta: 0, firstChanged: null });
const colour = () => ({ pixel: [10, 10], alpha: 0.99, background: [0, 0, 0, 255], expected: [252.45, 0, 0], actual: [252, 0, 0, 255], maxDelta: 0.45 });
const silhouette = () => ({ left: 130, right: 190, top: 90, bottom: 150 });
const expectedSilhouette = () => ({ left: 130.66, right: 190.34, top: 90.66, bottom: 150.34 });
const sides = (left, middle, right) => ({ left, middle, right });
const picks = { overBox: { expressId: 1, worldXYZ: { x: -0.57, y: -0.5, z: 0.25 } }, overEmpty: null };

function lifetime(name) {
  return {
    readiness: { beforeInit: { state: 'initializing', generation: 0 },
      afterInit: { state: 'blocked', generation: 1, reasons: ['exact-mixed-transparency', 'scalable-global-order', 'native-viewer-contract'], capabilities: [] } },
    destroyCallsBeforeTeardown: 0, destroyCallsDuringTeardown: 1, teardownDestroyPhases: [`${name}:teardown`], teardownDestroyStack: [],
    lostAfterDestroy: { reason: 'destroyed', message: 'Device was destroyed.' },
    deviceLossesBeforeTeardown: name === 'deviceRecovery' ? [{ phase: 'deviceRecovery', reason: 'destroyed' }] : [], deviceLossesAfterTeardown: [],
    gpuErrors: [], diagnostics: { renderErrors: 0, gpuErrors: 0 }, submittedAfterDestroy: false, readinessAfterDestroy: { state: 'disposed', generation: 2 },
    statesAfterDestroy: [{ state: 'invalid' }], statsAfterDestroy: { assets: 0, splats: 0 }, addAfterDestroy: { rejected: { code: 'disposed' } },
    inflightAddAtDestroy: name === 'deviceLifetime' ? { rejected: { code: 'disposed' } } : null,
  };
}

/** Scene (j): one re-sort per camera change, none without; every refreshed order equals a fresh sort. */
function sortRefreshSplat() {
  const sorted = (name, centre) => ({ name, sorts: 1, recomputed: 1, lastEncodeMs: 0.2, centre, equalsFresh: exact(77361) });
  const centres = { 0: [153, 0, 61, 255], 30: [146, 0, 62, 255], 60: [134, 0, 63, 255], 80: [129, 0, 64, 255],
    100: [64, 0, 128, 255], 120: [64, 0, 134, 255], 150: [62, 0, 146, 255], 180: [61, 0, 153, 255] };
  return {
    upstream: { found: 1, lookalikes: 0 },
    counts: { still: { name: 'still', sorts: 0, recomputed: 0 }, orbitApi: sorted('orbit-api'), stillAfterOrbit: { name: 'still-after-orbit', sorts: 0, recomputed: 0 },
      zoomPerspective: sorted('zoom-perspective'), zoomOrthographic: sorted('zoom-orthographic') },
    path: Object.entries(centres).map(([degrees, centre]) => ({ degrees: Number(degrees), ...sorted(`orbit-${degrees}`, centre) })),
    zoom: ['perspective-0', 'perspective-1', 'orthographic-0'].map(name => sorted(`zoom-${name}`, [62, 0, 146, 255])),
    frozen: { orbit: { name: 'frozen-orbit-180', sorts: 1, recomputed: 0, centre: [153, 0, 61, 255], equalsFresh: { comparable: true, compared: 77361, changed: 869, maxDelta: 92 } },
      zoom: { name: 'frozen-zoom', sorts: 1, recomputed: 0, centre: [62, 0, 146, 255], equalsFresh: exact(77361) } },
    spyRestored: true,
  };
}

/** The measurement shape native-adapter-witness.mjs returns for a run that should pass. */
function passing() {
  const scenes = {
    occlusion: {
      baseline: { projectionAgreementPx: 1e-6, silhouette: silhouette(), expectedSilhouette: expectedSilhouette(), corner: [0, 0, 0, 255], patchCentre: [0, 255, 0, 255],
        patchCoversMiddleFootprint: { comparable: true, compared: 193, changed: 193, maxDelta: 134 } },
      splat: { frontOverBox: colour(), rearOccludedByBox: exact(444), rearVisibleWithoutBox: colour(), middleVisibleWithoutPoints: colour(),
        middleOccludedByPoints: exact(193), frontOverPoints: colour(), state: { state: 'resident' } },
    },
    globalOrder: {
      baseline: { emptyLitPixels: 0, runs: 96, expectedCentre: [101.95, 0, 153.05], perAssetOrders: { aThenB: [0, 0, 255], bThenA: [255, 0, 0] } },
      splat: { removed: [true, true], twoVsOne: exact(77361), reversedAddVsOne: exact(77361), centre: { one: [102, 0, 153, 255], two: [102, 0, 153, 255] }, litPixels: 1225 },
    },
    projectionMsaaResize: {
      baseline: { sampleCount: 4, views: Object.fromEntries([['perspective-321', [321, 241]], ['perspective-401', [401, 301]], ['orthographic-321', [321, 241]]]
        .map(([view, size]) => [view, { size, silhouette: silhouette(), expectedSilhouette: expectedSilhouette() }])) },
      splat: { ...Object.fromEntries(['perspective-321', 'perspective-401', 'orthographic-321'].map(view => [view, { frontOverBox: colour(), rearOccludedByBox: exact(444) }])),
        resizeRoundTrip: exact(77361) },
    },
    centreClipping: {
      baseline: { strip: { none: sides(true, true, true), plane: sides(true, true, false), flipped: sides(false, false, true), box: sides(false, true, false), all: sides(false, false, false) } },
      splat: { planeKeepsLeftCentres: exact(12198), flippedKeepsRightCentres: exact(12198), boxKeepsInnerCentres: exact(12198), allClippedEqualsEmpty: exact(77361),
        unclippedDiffersFromLeft: { comparable: true, compared: 12198, changed: 936, maxDelta: 228 }, keptFootprintCrossesPlane: { litPixels: 28 } },
    },
    removalVisibility: {
      baseline: { corner: [0, 0, 0, 255], boxCentre: [123, 121, 120, 255] },
      splat: { bothDifferFromNone: { comparable: true, compared: 77361, changed: 996, maxDelta: 200 }, hideA: { returned: true, equalsOnlyB: exact() },
        hideBoth: { returned: true, equalsNone: exact() }, showBoth: { returned: [true, true], equalsBoth: exact() },
        move: { returned: true, bounds: { min: [-0.5, 0.5, 1], max: [-0.5, 0.5, 1] }, newCentre: colour(), oldCentreCleared: exact(10) },
        moveBack: { returned: true, equalsBoth: exact() }, removeA: { returned: true, equalsOnlyB: exact() },
        staleHandle: { remove: false, setVisible: false, setPlacement: false, state: { state: 'invalid' }, bounds: null },
        removeB: { returned: true, equalsNone: exact() }, readd: { equalsBoth: exact() },
        clear: { equalsNone: exact(), stats: { assets: 0, splats: 0 }, states: [{ state: 'invalid' }], bounds: null } },
    },
    deviceLifetime: { baseline: { boxCentre: [123, 121, 120, 255] }, splat: { drawnBeforeTeardown: colour() } },
    picking: {
      baseline: { picksWithoutSplats: structuredClone(picks), overEmptyBackground: [0, 0, 0, 255] },
      splat: { drawnOverBox: colour(), drawnOverEmpty: colour(), withSplats: structuredClone(picks), afterRemoval: structuredClone(picks), removed: true },
    },
    deviceRecovery: {
      baseline: { boxCentre: [123, 121, 120, 255] },
      splat: { before: { readiness: { state: 'blocked', generation: 1 }, state: { state: 'resident' } }, latched: true,
        whileLost: { isDeviceLost: true, readiness: { state: 'lost', generation: 1 }, state: { state: 'pending' }, submitted: false },
        recovery: { ok: true, omissions: [] }, replacementIsNew: true, after: { readiness: { state: 'blocked', generation: 2 }, state: { state: 'resident' } },
        sameHandleUsable: { setVisible: true }, recoveredEqualsReference: exact(77361),
        destroyCallsOnLostDevice: [{ phase: 'deviceRecovery:induce-loss', stack: ['at deviceRecovery (native-adapter-witness-scenes.mjs)'] },
          { phase: 'deviceRecovery', stack: ['at WebGPUDevice.destroy (device.ts)', 'at Renderer.teardown (index.ts)'] }] },
    },
    sortRefresh: {
      baseline: { emptyLitPixels: 0, expected: { A: [153, 0, 61.2], B: [61.2, 0, 153] } },
      splat: sortRefreshSplat(),
    },
  };
  for (const [name, scene] of Object.entries(scenes)) Object.assign(scene, { captures: [{ name: 'frame', stable: true }], lifetime: lifetime(name) });
  return { productionReady: false, adapterAvailable: true, consoleErrors: [], scenes };
}

const failedNames = (result, options) => judge(result, options).failed.map(check => check.name);
function rejects(mutate, expected) {
  const result = passing();
  mutate(result.scenes, result);
  const failed = failedNames(result);
  assert.ok(failed.includes(expected), `expected "${expected}" to fail; failed: ${JSON.stringify(failed)}`);
}

test('a complete passing measurement set is accepted', () => {
  const verdict = judge(passing());
  assert.deepEqual(verdict.failed, []);
  assert.ok(verdict.total > 150);
});

test('identical-but-empty comparisons never count as exact', () => {
  rejects(s => { s.globalOrder.splat.twoVsOne = exact(0); }, 'globalOrder: two assets equal the same rows as one asset');
  rejects(s => { s.occlusion.splat.rearOccludedByBox = exact(0); }, 'occlusion: rear Gaussian fully hidden by opaque box');
  rejects(s => { s.projectionMsaaResize.splat.resizeRoundTrip = { comparable: false, actualSize: [401, 301], referenceSize: [321, 241] }; },
    'projection: resize round trip reproduces the first frame');
});

test('per-asset draw order colours are rejected against the analytic global order', () => {
  rejects(s => { s.globalOrder.splat.centre.one = [0, 0, 255, 255]; }, 'globalOrder: one-asset centre matches analytic global order');
  rejects(s => { s.globalOrder.splat.centre.two = [255, 0, 0, 255]; }, 'globalOrder: two-asset centre matches analytic global order');
  rejects(s => { s.globalOrder.baseline.perAssetOrders.aThenB = [104, 0, 151]; }, 'globalOrder: analytic centre discriminates per-asset orders');
  rejects(s => { s.globalOrder.baseline.runs = 64; }, 'globalOrder: more than 64 interleaved depth runs');
});

test('clipped-footprint mismatches and fragment clipping are rejected', () => {
  rejects(s => { s.centreClipping.splat.planeKeepsLeftCentres.changed = 12; }, 'clipping: plane keeps exactly the centres on the kept side');
  rejects(s => { s.centreClipping.splat.keptFootprintCrossesPlane.litPixels = 0; }, 'clipping: kept Gaussian footprint crosses the plane (not fragment-clipped)');
  rejects(s => { s.centreClipping.splat.unclippedDiffersFromLeft.changed = 0; }, 'clipping: unclipped differs from kept subset (sensitivity)');
  rejects(s => { s.centreClipping.baseline.strip.plane = sides(false, true, true); }, 'clipping: mesh strip side convention (plane)');
});

test('analytic colours, occlusion and point-cloud coverage are enforced', () => {
  rejects(s => { s.occlusion.splat.frontOverBox.maxDelta = 9; }, 'occlusion: front Gaussian over box has analytic colour');
  rejects(s => { s.occlusion.splat.frontOverBox = undefined; }, 'occlusion: front Gaussian over box has analytic colour');
  rejects(s => { s.occlusion.splat.middleOccludedByPoints.changed = 1; }, 'occlusion: middle Gaussian fully hidden by point cloud');
  rejects(s => { s.occlusion.baseline.patchCoversMiddleFootprint.changed = 192; }, 'occlusion: point patch covers the whole middle footprint');
  rejects(s => { s.occlusion.baseline.silhouette.left = 128; }, 'occlusion: box silhouette matches analytic projection');
});

test('lifetime violations by the adapter are rejected', () => {
  rejects(s => { s.globalOrder.lifetime.destroyCallsBeforeTeardown = 1; }, 'globalOrder: device never destroyed before renderer teardown');
  rejects(s => { s.globalOrder.lifetime.destroyCallsDuringTeardown = 2; }, 'globalOrder: device destroyed exactly once, by renderer teardown');
  rejects(s => { s.occlusion.lifetime.readiness.afterInit.state = 'ready'; }, 'occlusion: readiness blocked (never ready) after init');
  rejects(s => { s.picking.lifetime.deviceLossesBeforeTeardown = [{ reason: 'destroyed' }]; }, 'picking: device-loss callbacks only for induced losses (0)');
  rejects(s => { s.deviceRecovery.lifetime.deviceLossesBeforeTeardown = []; }, 'deviceRecovery: device-loss callbacks only for induced losses (1)');
  rejects(s => { s.deviceLifetime.lifetime.inflightAddAtDestroy = { resolved: { id: 9, modelIndex: 0 } }; }, 'lifetime: add in flight at destroy never publishes');
  rejects(s => { s.removalVisibility.lifetime.addAfterDestroy = { resolved: { id: 3 } }; }, "removalVisibility: add after destroy rejects 'disposed'");
});

test('device recovery must restore the frame and keep the Gaussian layer off the device', () => {
  rejects(s => { s.deviceRecovery.splat.recoveredEqualsReference.changed = 3; }, 'recovery: post-recovery frame equals the pre-loss frame');
  rejects(s => { s.deviceRecovery.splat.whileLost.state = { state: 'resident' }; }, 'recovery: handle pending (never resident) while lost');
  rejects(s => { s.deviceRecovery.splat.recovery = { ok: true, omissions: ['point-clouds'] }; }, 'recovery: recoverDevice() ok with no omissions');
  rejects(s => { s.deviceRecovery.splat.after.readiness.generation = 1; }, 'recovery: readiness blocked with a newer generation');
  rejects(s => { s.deviceRecovery.splat.destroyCallsOnLostDevice[1].stack = ['at LumaGaussianScene.destroy (/gaussian/gaussian-luma-backend.ts)']; },
    'recovery: lost device destroyed by the witness, then only by renderer recovery');
});

test('Gaussians must never become pickable', () => {
  rejects(s => { s.picking.splat.withSplats.overEmpty = { expressId: 0 }; }, 'picking: picks pass through Gaussians (identical to no-splat picks)');
  rejects(s => { s.picking.splat.withSplats.overBox.worldXYZ.z = 1.5; }, 'picking: picks pass through Gaussians (identical to no-splat picks)');
});

test('a missing adapter fails unless a baseline-only run is requested', () => {
  const result = passing();
  result.adapterAvailable = false;
  for (const scene of Object.values(result.scenes)) scene.splat = { status: 'pending' };
  result.scenes.deviceRecovery.lifetime.deviceLossesBeforeTeardown = []; // no splats: scene (h) induces no loss
  assert.ok(failedNames(result).includes('adapter API present'));
  assert.deepEqual(failedNames(result, { allowPendingAdapter: true }), []);
});

test('scene (j) rejects stale or frame-driven sorting and an insensitive frozen control', () => {
  rejects(s => { s.sortRefresh.splat.counts.still.sorts = 1; }, 'sort: no camera change, no re-sort');
  rejects(s => { s.sortRefresh.splat.counts.orbitApi.recomputed = 0; }, 'sort: camera orbit re-sorts');
  rejects(s => { s.sortRefresh.splat.path[5].equalsFresh.changed = 869; }, 'sort: orbit 120 deg equals a from-scratch sort');
  rejects(s => { s.sortRefresh.splat.path.at(-1).centre = [153, 0, 61, 255]; }, 'sort: blue over red at B matches analytic front-over-back');
  rejects(s => { s.sortRefresh.splat.path[4].centre = [129, 0, 64, 255]; }, 'sort: the front colour flips mid-path (between 80 and 100 deg)');
  rejects(s => { s.sortRefresh.splat.zoom[2].equalsFresh.changed = 4; }, 'sort: zoom-orthographic-0 equals a from-scratch sort');
  rejects(s => { s.sortRefresh.splat.frozen.orbit.equalsFresh = exact(77361); }, 'sort: frozen sort leaves the stale order at B (orbit is order-sensitive)');
  rejects(s => { s.sortRefresh.splat.frozen.zoom.equalsFresh.changed = 12; }, 'sort: frozen sort still matches after a zoom (zoom is order-preserving)');
  rejects(s => { s.sortRefresh.splat.upstream = { found: 0, lookalikes: 1 }; }, 'sort: adapter draws through the same upstream SplatRenderer module');
});
