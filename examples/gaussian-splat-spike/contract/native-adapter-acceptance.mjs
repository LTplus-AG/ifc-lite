/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 acceptance table for native-adapter-witness.mjs measurements. Every
// check is recorded (not first-failure) so evidence names each defect exactly.
// Thresholds live here, once; the page only measures.

const BLOCKERS = ['exact-mixed-transparency', 'scalable-global-order', 'native-viewer-contract'];
const COLOUR_TOLERANCE = 8;
const ORDER_TOLERANCE = 6;

export function judge(result, { allowPendingAdapter = false } = {}) {
  const checks = [];
  const check = (name, pass, detail) => { checks.push({ name, pass: Boolean(pass), ...(pass ? {} : { detail }) }); };
  const exact = (name, comparison) => check(name, comparison?.comparable && comparison.compared > 0 && comparison.changed === 0, comparison);
  const colour = (name, measured, tolerance = COLOUR_TOLERANCE) => check(name, measured && measured.maxDelta <= tolerance, measured);
  const near = (a, b, tolerance) => Array.isArray(a) && a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tolerance);
  const edges = (name, measured, expected) => check(name, measured && ['left', 'right', 'top', 'bottom']
    .every(edge => Math.abs(measured[edge] - Math.floor(expected[edge])) <= 1), { measured, expected });

  check('productionReady is false', result.productionReady === false, result.productionReady);
  check('adapter API present', result.adapterAvailable || allowPendingAdapter, 'renderer.gaussianSplats missing (pass --allow-pending-adapter for a baseline-only run)');
  check('no in-page console errors', result.consoleErrors.length === 0, result.consoleErrors);
  const splats = result.adapterAvailable;

  for (const [name, scene] of Object.entries(result.scenes)) {
    check(`${name}: scene completed`, scene.error === undefined, scene.error);
    check(`${name}: every capture stable`, scene.captures.length > 0 && scene.captures.every(c => c.stable), scene.captures.filter(c => !c.stable));
    const life = scene.lifetime;
    check(`${name}: readiness initializing before init`, life.readiness.beforeInit?.state === 'initializing', life.readiness.beforeInit);
    check(`${name}: readiness blocked (never ready) after init`, life.readiness.afterInit?.state === 'blocked'
      && BLOCKERS.every(b => life.readiness.afterInit.reasons?.includes(b)), life.readiness.afterInit);
    check(`${name}: device never destroyed before renderer teardown`, life.destroyCallsBeforeTeardown === 0, life.destroyCallsBeforeTeardown);
    check(`${name}: device destroyed exactly once, by renderer teardown`, life.destroyCallsDuringTeardown === 1
      && life.teardownDestroyPhases.every(p => p === `${name}:teardown`), { calls: life.destroyCallsDuringTeardown, phases: life.teardownDestroyPhases, stack: life.teardownDestroyStack });
    check(`${name}: device lost only as destroyed`, life.lostAfterDestroy?.reason === 'destroyed', life.lostAfterDestroy);
    // Only scene (h) induces a loss on purpose, exactly once.
    const expectedLosses = name === 'deviceRecovery' && splats ? 1 : 0;
    check(`${name}: device-loss callbacks only for induced losses (${expectedLosses})`,
      life.deviceLossesBeforeTeardown.length === expectedLosses && life.deviceLossesAfterTeardown.length === 0,
      { before: life.deviceLossesBeforeTeardown, after: life.deviceLossesAfterTeardown });
    check(`${name}: no uncaptured WebGPU errors`, life.gpuErrors.length === 0, life.gpuErrors);
    check(`${name}: renderer diagnostics clean`, life.diagnostics.renderErrors === 0 && life.diagnostics.gpuErrors === 0, life.diagnostics);
    check(`${name}: render after destroy is a quiet no-op`, life.submittedAfterDestroy === false, life.submittedAfterDestroy);
    check(`${name}: readiness disposed after destroy`, life.readinessAfterDestroy?.state === 'disposed', life.readinessAfterDestroy);
    if (splats) {
      check(`${name}: handles invalid after destroy`, life.statesAfterDestroy.every(s => s.state === 'invalid'), life.statesAfterDestroy);
      check(`${name}: no assets after destroy`, life.statsAfterDestroy?.assets === 0 && life.statsAfterDestroy?.splats === 0, life.statsAfterDestroy);
      check(`${name}: add after destroy rejects 'disposed'`, life.addAfterDestroy?.rejected?.code === 'disposed', life.addAfterDestroy);
    }
    if (scene.error !== undefined) continue;
    BASELINE[name]?.(scene.baseline, { check, exact, colour, near, edges });
    if (splats) SPLAT[name]?.(scene.splat, scene, { check, exact, colour, near, edges });
  }
  return { pass: checks.every(c => c.pass), total: checks.length, failed: checks.filter(c => !c.pass), checks };
}

const BASELINE = {
  occlusion(b, { check, edges }) {
    check('occlusion: independent projection matches camera.projectToScreen', b.projectionAgreementPx < 0.01, b.projectionAgreementPx);
    edges('occlusion: box silhouette matches analytic projection', b.silhouette, b.expectedSilhouette);
    check('occlusion: background is the clear colour', b.corner.join() === '0,0,0,255', b.corner);
    check('occlusion: point patch renders green', b.patchCentre[1] > b.patchCentre[0] + 60 && b.patchCentre[1] > b.patchCentre[2] + 60, b.patchCentre);
    const cover = b.patchCoversMiddleFootprint;
    check('occlusion: point patch covers the whole middle footprint', cover.compared > 0 && cover.changed === cover.compared, cover);
  },
  globalOrder(b, { check, near }) {
    check('globalOrder: empty frame has no lit pixel', b.emptyLitPixels === 0, b.emptyLitPixels);
    check('globalOrder: more than 64 interleaved depth runs', b.runs > 64, b.runs);
    check('globalOrder: analytic centre discriminates per-asset orders',
      !near(b.perAssetOrders.aThenB, b.expectedCentre, 40) && !near(b.perAssetOrders.bThenA, b.expectedCentre, 40), b);
  },
  projectionMsaaResize(b, { check, edges }) {
    check('projection: renderer MSAA is 4x', b.sampleCount === 4, b.sampleCount);
    const sizes = { 'perspective-321': [321, 241], 'perspective-401': [401, 301], 'orthographic-321': [321, 241] };
    for (const [view, measured] of Object.entries(b.views)) {
      check(`projection: ${view} drawing buffer follows CSS size`, measured.size.join() === sizes[view].join(), measured.size);
      edges(`projection: ${view} box silhouette matches analytic projection`, measured.silhouette, measured.expectedSilhouette);
    }
  },
  centreClipping(b, { check }) {
    const expected = { none: [1, 1, 1], plane: [1, 1, 0], flipped: [0, 0, 1], box: [0, 1, 0], all: [0, 0, 0] };
    for (const [name, sides] of Object.entries(expected)) {
      const got = b.strip[name];
      check(`clipping: mesh strip side convention (${name})`, got && [got.left, got.middle, got.right].every((v, i) => v === Boolean(sides[i])), got);
    }
  },
  removalVisibility(b, { check }) {
    check('visibility: background is the clear colour', b.corner.join() === '0,0,0,255', b.corner);
    check('visibility: box drawn', Math.max(...b.boxCentre.slice(0, 3)) > 40, b.boxCentre);
  },
  deviceLifetime(b, { check }) {
    check('lifetime: box drawn', Math.max(...b.boxCentre.slice(0, 3)) > 40, b.boxCentre);
  },
  deviceRecovery(b, { check }) {
    check('recovery: box drawn', Math.max(...b.boxCentre.slice(0, 3)) > 40, b.boxCentre);
  },
  picking(b, { check }) {
    check('picking: pick over the box returns the box', b.picksWithoutSplats.overBox?.expressId === 1, b.picksWithoutSplats);
    check('picking: pick over empty background returns null', b.picksWithoutSplats.overEmpty === null, b.picksWithoutSplats);
    check('picking: empty-background pixel is the clear colour', b.overEmptyBackground.join() === '0,0,0,255', b.overEmptyBackground);
  },
};

const SPLAT = {
  occlusion(s, scene, { check, exact, colour }) {
    colour('occlusion: front Gaussian over box has analytic colour', s.frontOverBox);
    exact('occlusion: rear Gaussian fully hidden by opaque box', s.rearOccludedByBox);
    colour('occlusion: rear Gaussian visible once box is hidden (control)', s.rearVisibleWithoutBox);
    colour('occlusion: middle Gaussian visible without points (control)', s.middleVisibleWithoutPoints, 12);
    exact('occlusion: middle Gaussian fully hidden by point cloud', s.middleOccludedByPoints);
    colour('occlusion: front Gaussian over points has analytic colour', s.frontOverPoints);
    check('occlusion: asset resident', s.state?.state === 'resident', s.state);
  },
  globalOrder(s, scene, { check, exact, near }) {
    check('globalOrder: both removals succeed', s.removed.every(Boolean), s.removed);
    exact('globalOrder: two assets equal the same rows as one asset', s.twoVsOne);
    exact('globalOrder: reversed add order equals one asset', s.reversedAddVsOne);
    const expected = scene.baseline.expectedCentre;
    check('globalOrder: one-asset centre matches analytic global order', near(s.centre.one, expected, ORDER_TOLERANCE), { actual: s.centre.one, expected });
    check('globalOrder: two-asset centre matches analytic global order', near(s.centre.two, expected, ORDER_TOLERANCE), { actual: s.centre.two, expected });
    check('globalOrder: splats drawn', s.litPixels > 100, s.litPixels);
  },
  projectionMsaaResize(s, scene, { exact, colour }) {
    for (const view of ['perspective-321', 'perspective-401', 'orthographic-321']) {
      colour(`projection: ${view} front Gaussian analytic colour`, s[view]?.frontOverBox);
      exact(`projection: ${view} rear Gaussian hidden by box`, s[view]?.rearOccludedByBox);
    }
    exact('projection: resize round trip reproduces the first frame', s.resizeRoundTrip);
  },
  centreClipping(s, scene, { check, exact }) {
    exact('clipping: plane keeps exactly the centres on the kept side', s.planeKeepsLeftCentres);
    exact('clipping: flipped plane keeps exactly the other centres', s.flippedKeepsRightCentres);
    exact('clipping: clip box keeps exactly the enclosed centres', s.boxKeepsInnerCentres);
    exact('clipping: all centres clipped equals the empty frame (splat pass resolves unchanged)', s.allClippedEqualsEmpty);
    check('clipping: unclipped differs from kept subset (sensitivity)', s.unclippedDiffersFromLeft.changed > 0, s.unclippedDiffersFromLeft);
    check('clipping: kept Gaussian footprint crosses the plane (not fragment-clipped)', s.keptFootprintCrossesPlane.litPixels > 0, s.keptFootprintCrossesPlane);
  },
  removalVisibility(s, scene, { check, exact, colour }) {
    check('visibility: two assets change the frame', s.bothDifferFromNone.changed > 0, s.bothDifferFromNone);
    check('visibility: setVisible returns true', s.hideA.returned && s.hideBoth.returned && s.showBoth.returned.every(Boolean), s);
    exact('visibility: hide A equals only-B frame', s.hideA.equalsOnlyB);
    exact('visibility: hide both equals no-splat frame', s.hideBoth.equalsNone);
    exact('visibility: show both restores frame', s.showBoth.equalsBoth);
    check('visibility: setPlacement resolves true', s.move.returned === true && s.moveBack.returned === true, { move: s.move.returned, back: s.moveBack.returned });
    check('visibility: moved bounds follow placement', Math.abs((s.move.bounds?.min?.[1] ?? NaN) - 0.5) < 1e-4, s.move.bounds);
    colour('visibility: moved Gaussian analytic colour at new centre', s.move.newCentre);
    exact('visibility: old centre cleared after move', s.move.oldCentreCleared);
    exact('visibility: move back restores frame', s.moveBack.equalsBoth);
    check('visibility: remove returns true', s.removeA.returned && s.removeB.returned, { a: s.removeA.returned, b: s.removeB.returned });
    exact('visibility: remove A equals only-B frame', s.removeA.equalsOnlyB);
    check('visibility: stale handle is inert', s.staleHandle.remove === false && s.staleHandle.setVisible === false
      && s.staleHandle.setPlacement === false && s.staleHandle.state?.state === 'invalid' && s.staleHandle.bounds === null, s.staleHandle);
    exact('visibility: remove B equals no-splat frame', s.removeB.equalsNone);
    exact('visibility: re-add equals earlier frame', s.readd.equalsBoth);
    exact('visibility: clear equals no-splat frame', s.clear.equalsNone);
    check('visibility: clear empties the layer', s.clear.stats?.assets === 0 && s.clear.stats?.splats === 0
      && s.clear.states.every(st => st.state === 'invalid') && s.clear.bounds === null, s.clear);
  },
  deviceLifetime(s, scene, { check, colour }) {
    colour('lifetime: Gaussians drawn before teardown', s.drawnBeforeTeardown);
    const inflight = scene.lifetime.inflightAddAtDestroy;
    check('lifetime: add in flight at destroy never publishes', inflight?.rejected && ['disposed', 'lost', 'aborted'].includes(inflight.rejected.code), inflight);
  },
  deviceRecovery(s, scene, { check, exact }) {
    check('recovery: asset resident before the loss', s.before?.state?.state === 'resident', s.before);
    check('recovery: raw device destroy latches the loss', s.latched === true && s.whileLost?.isDeviceLost === true, { latched: s.latched, whileLost: s.whileLost });
    check('recovery: readiness reports lost', s.whileLost?.readiness?.state === 'lost', s.whileLost?.readiness);
    check('recovery: handle pending (never resident) while lost', s.whileLost?.state?.state === 'pending', s.whileLost?.state);
    check('recovery: frames skip while lost', s.whileLost?.submitted === false, s.whileLost?.submitted);
    check('recovery: recoverDevice() ok with no omissions', s.recovery?.ok === true && s.recovery.omissions.length === 0, s.recovery);
    check('recovery: renderer runs on a replacement device', s.replacementIsNew === true, s.replacementIsNew);
    check('recovery: same handle resident again', s.after?.state?.state === 'resident' && s.sameHandleUsable?.setVisible === true, { after: s.after, usable: s.sameHandleUsable });
    check('recovery: readiness blocked with a newer generation', s.after?.readiness?.state === 'blocked'
      && s.after.readiness.generation > s.before.readiness.generation, { before: s.before?.readiness, after: s.after?.readiness });
    exact('recovery: post-recovery frame equals the pre-loss frame', s.recoveredEqualsReference);
    // The witness destroys the lost device first; the renderer's recovery teardown may
    // destroy it again (WebGPUDevice.destroy). No call may come from the Gaussian layer.
    const calls = s.destroyCallsOnLostDevice ?? [];
    check('recovery: lost device destroyed by the witness, then only by renderer recovery', calls[0]?.phase === 'deviceRecovery:induce-loss'
      && calls.slice(1).every(c => c.stack.some(frame => frame.includes('WebGPUDevice.destroy')))
      && calls.every(c => !c.stack.some(frame => frame.includes('/gaussian/'))), calls);
  },
  picking(s, scene, { check, colour }) {
    colour('picking: Gaussian drawn at the over-box pick pixel', s.drawnOverBox);
    colour('picking: Gaussian drawn at the over-empty pick pixel', s.drawnOverEmpty);
    const reference = JSON.stringify(scene.baseline.picksWithoutSplats);
    check('picking: picks pass through Gaussians (identical to no-splat picks)', JSON.stringify(s.withSplats) === reference, { withSplats: s.withSplats, reference: scene.baseline.picksWithoutSplats });
    check('picking: picks after removal identical to no-splat picks', s.removed === true && JSON.stringify(s.afterRemoval) === reference, { afterRemoval: s.afterRemoval, removed: s.removed });
  },
};
