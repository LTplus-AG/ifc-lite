/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8786: every Measure gesture reset (Esc, a mode switch, a tool switch) is one
 * reset. It clears the edge lock and the snap visualisation, cancels a queued
 * measure raycast frame, and a press that began before the reset places no
 * point when it is released.
 *
 * Mounts the real `useMouseControls` with its measure context bound to the
 * shared store, the way `Viewport.tsx` binds it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useViewerStore } from '@/store';
import { cleanupMouseControls, mountMouseControls, mousePointer } from '@/test/mouse-controls-fixture.js';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts.js';
import type { UseMouseControlsParams } from './useMouseControls.js';
import { handleMeasureTap } from './touchRouting.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { syncMeasureScreenCoords } from './measureHandlers.js';

const s = () => useViewerStore.getState();
const initial = useViewerStore.getState();

const EDGE = { v0: { x: 0, y: 0, z: 0 }, v1: { x: 9, y: 0, z: 0 } };

/**
 * Canvas x/100 is world x, and (300 - y)/100 world y. A snapping pick snaps onto
 * and locks EDGE (world y 0); one with snapping off reads the bare surface. The
 * locks each pick is handed are recorded.
 */
const locksSeen: Array<unknown> = [];
function raycastSceneMagnetic(x: number, y: number, lock: { edge: unknown }, options?: { snapOptions?: { snapToEdges?: boolean } }) {
  locksSeen.push(lock.edge);
  const point = { x: x / 100, y: (300 - y) / 100, z: 0 };
  if (options?.snapOptions?.snapToEdges === false) {
    return { intersection: { point }, snapTarget: null, edgeLock: { shouldRelease: false, shouldLock: false, edge: null, meshExpressId: null, edgeT: 0, isCorner: false, cornerValence: 0 } };
  }
  return {
    intersection: { point },
    snapTarget: { type: 'edge', position: { x: point.x, y: 0, z: 0 }, metadata: { vertices: [EDGE.v0, EDGE.v1] } },
    edgeLock: { shouldRelease: false, shouldLock: true, edge: EDGE, meshExpressId: 1, edgeT: 0.5, isCorner: false, cornerValence: 0 },
  };
}

/** Snap, read from the store like Viewport's `snapEnabledRef`, so the S key reaches the handlers. */
const snapOn = { get current() { return s().snapEnabled; }, set current(v: boolean) { useViewerStore.setState({ snapEnabled: v }); } };
const tool = { get current() { return s().activeTool; }, set current(_v) { /* store-owned */ } };

/** The measure context bound to the store, as Viewport.tsx binds it. */
const storeBound: Partial<UseMouseControlsParams> = {
  activeToolRef: tool,
  snapEnabledRef: snapOn,
  activeMeasurementRef: { get current() { return s().activeMeasurement; }, set current(_v) { /* store-owned */ } },
  measurementConstraintEdgeRef: { get current() { return s().measurementConstraintEdge; }, set current(_v) { /* store-owned */ } },
  startMeasurement: (p) => s().startMeasurement(p),
  updateMeasurement: (p) => s().updateMeasurement(p),
  finalizeMeasurement: () => s().finalizeMeasurement(),
  setMeasurementConstraintEdge: (edge) => s().setMeasurementConstraintEdge(edge),
  updateConstraintActiveAxis: (axis) => s().updateConstraintActiveAxis(axis),
  setSnapTarget: (t) => s().setSnapTarget(t),
  setSnapVisualization: (v) => s().setSnapVisualization(v),
  edgeLockStateRef: { get current() { return s().edgeLockState; }, set current(_v) { /* store-owned */ } },
  setEdgeLock: (edge, id, t) => s().setEdgeLock(edge, id, t),
  updateEdgeLockPosition: (t, corner, valence) => s().updateEdgeLockPosition(t, corner, valence),
  clearEdgeLock: () => s().clearEdgeLock(),
  incrementEdgeLockStrength: () => s().incrementEdgeLockStrength(),
};

// The measure raycasts are rAF-throttled. Frames are kept by id, so only a cancelled frame is dropped.
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
function flushFrames(): void {
  const run = [...frames.values()]; frames = new Map();
  act(() => { for (const f of run) f(0); });
}

function mount(overrides: Partial<UseMouseControlsParams> = {}) {
  const rig = mountMouseControls({ ...storeBound, ...overrides });
  Object.assign(rig.params.rendererRef.current!, { raycastSceneMagnetic });
  const ctx = {
    ...rig.params, canvas: rig.canvas, renderer: rig.params.rendererRef.current,
    camera: rig.params.rendererRef.current!.getCamera(), mouseState: rig.params.mouseStateRef.current,
  } as unknown as MouseHandlerContext;
  syncMeasureScreenCoords(ctx); // the animation loop's measure pass, which keeps lastCameraStateRef current each frame
  return { ...rig, ctx };
}

const fire = (canvas: HTMLCanvasElement, type: string, x: number, y: number) =>
  act(() => { canvas.dispatchEvent(mousePointer(type, 0, x, y)); });

/** A browser click: press, release, then the `click` the browser sends after it. */
function click(canvas: HTMLCanvasElement, x: number, y: number): void {
  fire(canvas, 'pointerdown', x, y);
  fire(canvas, 'pointerup', x, y);
  fire(canvas, 'click', x, y);
}

async function pressKey(key: string): Promise<void> {
  function Keys(): null { useKeyboardShortcuts(); return null; }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<Keys />); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
  await act(async () => { root.unmount(); });
  host.remove();
}
const pressEscape = () => pressKey('Escape');

/** A distance start whose rubber band has locked EDGE and shows its snap glyph. */
function lockedRubberBand(canvas: HTMLCanvasElement): void {
  click(canvas, 200, 300);
  fire(canvas, 'pointermove', 400, 300);
  flushFrames();
  assert.ok(s().activeMeasurement, 'setup: a start is pending');
  assert.ok(s().edgeLockState.edge !== null, 'setup: the rubber band locked an edge');
  assert.ok(s().snapVisualization !== null, 'setup: the rubber band shows its snap glyph');
}

function assertNoGestureLeft(why: string): void {
  assert.equal(s().edgeLockState.edge === null, true, `${why} left the edge lock behind`);
  assert.equal(s().edgeLockState.lockStrength, 0, `${why} left lock strength behind`);
  assert.equal(s().snapVisualization === null, true, `${why} left the snap glyph behind`);
  assert.equal(s().snapTarget === null, true, `${why} left the snap target behind`);
}

beforeEach(() => {
  useViewerStore.setState(initial, true);
  s().setActiveTool('measure');
  s().setMeasureMode('drag');
  snapOn.current = true;
  locksSeen.length = 0;
  frames = new Map();
  nextFrame = 1;
  globalThis.requestAnimationFrame = (cb) => { const id = nextFrame++; frames.set(id, cb); return id; };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
});

afterEach(() => {
  cleanupMouseControls();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  useViewerStore.setState(initial, true);
});

describe('a Measure gesture reset clears the lock and the snap glyph (#8786)', () => {
  it('Esc mid-gesture', async () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    await pressEscape();
    assert.equal(s().activeMeasurement, null, 'Esc cancels the start');
    assertNoGestureLeft('Esc');
  });

  it('a mode switch mid-gesture', () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    act(() => s().setMeasureMode('polyline'));
    assertNoGestureLeft('switching to Polyline');
  });

  it('leaving the tool mid-gesture', () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    act(() => s().setActiveTool('select'));
    assertNoGestureLeft('leaving Measure');
  });

  it('a rubber-band frame queued before Esc does not bring them back', async () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    fire(canvas, 'pointermove', 450, 300); // queues a frame, not yet run
    assert.equal(frames.size, 1, 'setup: a measure raycast frame is queued');
    await pressEscape();
    flushFrames();
    assertNoGestureLeft('a frame queued before Esc');
  });

  it('a rubber-band frame queued before a mode switch does not bring them back', () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    fire(canvas, 'pointermove', 450, 300);
    act(() => s().setMeasureMode('angle'));
    flushFrames();
    assertNoGestureLeft('a frame queued before a mode switch');
  });

  it('a model reposition (resetMeasureGesture) drops a queued frame too', () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    fire(canvas, 'pointermove', 450, 300);
    act(() => s().resetMeasureGesture());
    flushFrames();
    assertNoGestureLeft('a frame queued before a model reposition');
  });

  it('Clear all mid-gesture', () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    fire(canvas, 'pointermove', 450, 300);
    act(() => s().clearMeasurements());
    flushFrames();
    assertNoGestureLeft('Clear all');
  });

  it('Esc with nothing placed yet still drops a hover lock and glyph', async () => {
    act(() => s().setMeasureMode('polyline'));
    mount();
    act(() => { s().setEdgeLock(EDGE, 1, 0.5); s().setSnapVisualization({ slidingDot: { t: 0.5 } }); });
    await pressEscape();
    assert.equal(s().edgeLockState.edge === null, true, 'Esc left the hover lock behind');
    assert.equal(s().snapVisualization === null, true, 'Esc left the hover glyph behind');
  });

  it('switching the angle kind mid-gesture', () => {
    act(() => s().setMeasureMode('angle'));
    mount();
    act(() => { s().setEdgeLock(EDGE, 1, 0.5); s().setSnapVisualization({ slidingDot: { t: 0.5 } }); });
    act(() => s().setAngleKind(s().angleKind === 'edges' ? 'points' : 'edges'));
    assert.equal(s().edgeLockState.edge === null, true, 'switching the angle kind left the edge lock behind');
    assert.equal(s().snapVisualization === null, true, 'switching the angle kind left the snap glyph behind');
  });

  it('with Snap off, the next first click is not pulled by the lock Esc dropped', async () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    snapOn.current = false; // hover never runs now, so nothing else would clear the lock
    await pressEscape();
    locksSeen.length = 0;
    click(canvas, 500, 300);
    assert.ok(s().activeMeasurement, 'the click set a fresh start');
    assert.equal(locksSeen.length > 0, true, 'the click picked');
    assert.equal(locksSeen[0] === null, true, 'BUG: the first click after Esc picked with the stale edge lock');
  });
});

describe('a press that began before a reset places no point (#8786)', () => {
  it('a Distance press, a switch to Polyline while held, then release, adds no polyline point', () => {
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    assert.ok(s().activeMeasurement, 'setup: the press set a start');
    act(() => s().setMeasureMode('polyline'));
    fire(canvas, 'pointerup', 200, 300);
    fire(canvas, 'click', 200, 300);
    assert.equal(s().activePolyline === null, true, 'BUG: the release added a polyline point the user never placed in Polyline');
    click(canvas, 300, 300);
    assert.equal(s().activePolyline?.points.length, 1, 'the next click in Polyline places its point');
  });

  it('a Polyline press, Esc while held, then release, adds no point', async () => {
    act(() => s().setMeasureMode('polyline'));
    const { canvas } = mount();
    click(canvas, 200, 300);
    assert.equal(s().activePolyline?.points.length, 1, 'setup: one point placed');
    fire(canvas, 'pointerdown', 300, 300);
    await pressEscape();
    fire(canvas, 'pointerup', 300, 300);
    fire(canvas, 'click', 300, 300);
    assert.equal(s().activePolyline === null, true, 'BUG: a press from before Esc started a new polyline');
  });

  it('a press in another tool, a switch to Measure while held, then release, adds no point', () => {
    act(() => { s().setActiveTool('select'); s().setMeasureMode('polyline'); });
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    act(() => s().setActiveTool('measure'));
    fire(canvas, 'pointerup', 200, 300);
    fire(canvas, 'click', 200, 300);
    assert.equal(s().activePolyline === null, true, 'BUG: a press from the Select tool placed a Measure point');
  });

  it('a Distance press, a switch away and back while held, then release, leaves the double-click chain broken', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    click(canvas, 500, 300);
    assert.equal(s().measurements.length, 1, 'setup: a distance finished');
    act(() => { s().setMeasureMode('polyline'); s().setMeasureMode('drag'); });
    // The finish's "a start right after me may be a double-click" record is gone: a deliberate
    // start now survives a dblclick.
    click(canvas, 600, 300);
    fire(canvas, 'dblclick', 600, 300);
    assert.ok(s().activeMeasurement, 'BUG: a start after a reset was dropped as a stray double-click press');
  });

  it('a Polyline press, a model reposition while held, then release, adds no point', () => {
    act(() => s().setMeasureMode('polyline'));
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    act(() => s().resetMeasureGesture());
    fire(canvas, 'pointerup', 200, 300);
    fire(canvas, 'click', 200, 300);
    assert.equal(s().activePolyline === null, true, 'BUG: a press from before the reposition placed a point');
  });

  it('a first Polyline press, Esc while held, then release, adds no point', async () => {
    act(() => s().setMeasureMode('polyline'));
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    await pressEscape();
    fire(canvas, 'pointerup', 200, 300);
    fire(canvas, 'click', 200, 300);
    assert.equal(s().activePolyline === null, true, 'BUG: a press held through Esc placed the first point');
  });

  it('a Point press, Esc while held, then release, places no point', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas } = mount();
    click(canvas, 200, 300);
    assert.equal(s().measurePointLast !== null, true, 'setup: the click placed a point');
    fire(canvas, 'pointerdown', 300, 300);
    await pressEscape();
    assert.equal(s().measurePointLast === null, true, 'Esc dropped the placed point');
    fire(canvas, 'pointerup', 300, 300);
    fire(canvas, 'click', 300, 300);
    assert.equal(s().measurePointLast === null, true, 'BUG: a press from before Esc placed a new point');
  });

  it('an Angle press, an angle-kind switch while held, then release, adds no pick', () => {
    act(() => { s().setMeasureMode('angle'); s().setAngleKind('edges'); });
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    act(() => s().setAngleKind('points'));
    fire(canvas, 'pointerup', 200, 300);
    fire(canvas, 'click', 200, 300);
    assert.equal(s().activeAngle === null, true, 'BUG: a press from under the old kind added a pick under the new one');
  });

  it('a click still works normally without a reset (control)', () => {
    act(() => s().setMeasureMode('polyline'));
    const { canvas } = mount();
    click(canvas, 200, 300);
    click(canvas, 300, 300);
    assert.equal(s().activePolyline?.points.length, 2);
  });

  it('a tap after a reset is a fresh tap (control)', () => {
    const { ctx } = mount();
    act(() => handleMeasureTap(ctx, 200, 300));
    act(() => s().setMeasureMode('polyline'));
    act(() => handleMeasureTap(ctx, 300, 300));
    assert.equal(s().activePolyline?.points.length, 1, 'a tap begun after the switch places its point');
  });
});

/** A hover with nothing placed yet that locked EDGE and shows its snap glyph. */
function hoverLock(canvas: HTMLCanvasElement): void {
  fire(canvas, 'pointermove', 400, 300);
  flushFrames();
  assert.equal(s().activeMeasurement === null, true, 'setup: nothing is placed');
  assert.ok(s().edgeLockState.edge !== null, 'setup: the hover locked an edge');
  assert.ok(s().snapVisualization !== null, 'setup: the hover shows its snap glyph');
}

describe('turning Snap off drops the lock and the snap glyph (#8881)', () => {
  it('after a hover lock, the next first click is not pulled along the old edge', async () => {
    const { canvas } = mount();
    hoverLock(canvas);
    await pressKey('s');
    assert.equal(s().snapEnabled, false, 'setup: S turned Snap off');
    assertNoGestureLeft('turning Snap off');
    locksSeen.length = 0;
    click(canvas, 500, 300);
    assert.ok(s().activeMeasurement, 'the click set a start');
    assert.equal(locksSeen.length > 0, true, 'the click picked');
    assert.equal(locksSeen[0] === null, true, 'BUG: the first click after Snap off picked with the stale edge lock');
  });

  it('after a hover lock, the next first tap is not pulled along the old edge', async () => {
    const { ctx } = mount();
    hoverLock(ctx.canvas);
    await pressKey('s');
    assertNoGestureLeft('turning Snap off');
    locksSeen.length = 0;
    act(() => handleMeasureTap(ctx, 500, 300));
    assert.ok(s().activeMeasurement, 'the tap set a start');
    assert.equal(locksSeen[0] === null, true, 'BUG: the first tap after Snap off picked with the stale edge lock');
  });

  it('a hover frame queued before Snap off does not bring them back', async () => {
    const { canvas } = mount();
    fire(canvas, 'pointermove', 400, 300); // queues a hover frame, not yet run
    assert.equal(frames.size, 1, 'setup: a hover frame is queued');
    await pressKey('s');
    flushFrames();
    assertNoGestureLeft('a hover frame queued before Snap off');
  });

  it('mid-Distance keeps the start point, and the next click finishes from it', async () => {
    const { canvas } = mount();
    lockedRubberBand(canvas);
    const start = s().activeMeasurement!.start;
    const epoch = s().measureGestureEpoch;
    await pressKey('s');
    assertNoGestureLeft('turning Snap off mid-Distance');
    assert.equal(s().activeMeasurement?.start.x, start.x, 'Snap off discarded the start point');
    assert.equal(s().measureGestureEpoch, epoch, 'Snap off reset the gesture');
    click(canvas, 600, 300);
    assert.equal(s().measurements.length, 1, 'the next click finished the distance');
    assert.equal(s().measurements[0].start.x, start.x, 'the distance runs from the kept start');
  });

  it('mid-Distance, a press held through Snap off still finishes the distance on release', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointerdown', 600, 300);
    await pressKey('s');
    fire(canvas, 'pointerup', 600, 300);
    fire(canvas, 'click', 600, 300);
    assert.equal(s().measurements.length, 1, 'a press held through Snap off still finishes the distance');
  });

  it('in another tool, Snap off leaves its queued frame alone (a command preview owns it)', () => {
    act(() => s().setActiveTool('select'));
    const { params } = mount();
    params.measureRaycastFrameRef.current = requestAnimationFrame(() => {});
    params.measureRaycastPendingRef.current = true;
    act(() => s().toggleSnap());
    assert.equal(frames.size, 1, 'Snap off outside Measure dropped a frame it does not own');
    assert.equal(params.measureRaycastPendingRef.current, true);
  });

  it('turning Snap back on locks and shows the glyph as before', async () => {
    const { canvas } = mount();
    // A hover lock from before; the one real hover below is not throttled behind it.
    act(() => { s().setEdgeLock(EDGE, 1, 0.5); s().setSnapVisualization({ slidingDot: { t: 0.5 } }); });
    await pressKey('s');
    assertNoGestureLeft('turning Snap off');
    await pressKey('s');
    assert.equal(s().snapEnabled, true, 'setup: S turned Snap back on');
    fire(canvas, 'pointermove', 420, 300);
    flushFrames();
    assert.ok(s().edgeLockState.edge !== null, 'the hover locks an edge again');
    assert.ok(s().snapVisualization !== null, 'the snap glyph shows again');
    locksSeen.length = 0;
    click(canvas, 420, 300);
    assert.equal(locksSeen[0] === EDGE, true, 'the first click picks with the hover lock, as before');
  });
});

describe('turning Snap off re-picks the live preview unsnapped at the cursor (#8992)', () => {
  const xy = (p: { x: number; y: number } | null | undefined) => (p ? `${p.x},${p.y}` : 'none');

  it('Point mode: the Live reading moves off the snapped spot to the cursor', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas, ctx } = mount();
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    assert.equal(xy(s().measurePointLive), '4,0', 'setup: the Live reading sits on the snapped edge');
    await pressKey('s');
    assert.equal(s().snapEnabled, false, 'setup: S turned Snap off');
    assert.equal(xy(s().measurePointLive), '4,0.5', 'BUG: Live kept the snapped spot after Snap off');
    assertNoGestureLeft('turning Snap off in Point mode');
    flushFrames();
    act(() => syncMeasureScreenCoords(ctx)); // the next frame's measure pass
    assert.equal(xy(s().measurePointLive), '4,0.5', 'a later frame ended or replaced the re-picked Live');
  });

  it('Point mode, the view moved and no frame ran since: Snap off ends Live instead of re-picking under the new view', async () => {
    act(() => s().setMeasureMode('point'));
    // The pass bound to the store, as Viewport binds it: a moved view ends Live (#8828).
    const { canvas, camera } = mount({ updateMeasurementScreenCoords: (project, moved) => s().updateMeasurementScreenCoords(project, moved) });
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    assert.equal(xy(s().measurePointLive), '4,0', 'setup: the Live reading sits on the snapped edge');
    camera.setPosition(2, 1.6, 10); // keyboard navigation under a resting cursor; the measure pass has not run since
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(s().snapEnabled, false, 'setup: S turned Snap off');
    assert.equal(s().measurePointLive === null, true, 'BUG: Snap off re-picked Live at the old pixel under a view the pass had not seen');
    assert.equal(locksSeen.length, 0, 'Snap off picked under a moved view');
  });

  it('Distance: the rubber-band end moves off the snapped spot to the cursor, and the start is kept', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    const start = xy(s().activeMeasurement?.start);
    const epoch = s().measureGestureEpoch;
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'setup: the rubber band ends on the snapped edge');
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'BUG: the rubber band kept the snapped end after Snap off');
    assert.equal(xy(s().activeMeasurement?.start), start, 'Snap off moved the start');
    assert.equal(s().measureGestureEpoch, epoch, 'Snap off reset the gesture');
    assertNoGestureLeft('turning Snap off mid-Distance');
    click(canvas, 400, 250);
    assert.equal(s().measurements.length, 1, 'the next click finished the distance');
    assert.equal(xy(s().measurements[0].start), start, 'the distance runs from the kept start');
    assert.equal(xy(s().measurements[0].end), '4,0.5', 'the distance ends unsnapped at the click');
  });

  it('Distance: a rubber-band frame queued before Snap off does not land a snapped end afterwards', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250); // queued, not yet run
    assert.equal(frames.size, 1, 'setup: a rubber-band frame is queued');
    await pressKey('s');
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'the rubber band reads the cursor unsnapped');
    assertNoGestureLeft('a rubber-band frame queued before Snap off');
  });

  it('Point mode with no hover reading: Snap off picks nothing and shows no Live point', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas } = mount();
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    fire(canvas, 'mouseleave', 400, 250); // the cursor left: the readout falls back
    assert.equal(s().measurePointLive === null, true, 'setup: leaving the canvas ended Live');
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(s().measurePointLive === null, true, 'Snap off brought a Live point back');
    assert.equal(locksSeen.length, 0, 'Snap off picked with no Live point to refresh');
  });

  it('Distance with nothing placed: Snap off picks nothing and starts nothing', async () => {
    const { canvas } = mount();
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(s().activeMeasurement === null, true, 'Snap off started a distance');
    assert.equal(locksSeen.length, 0, 'Snap off picked with no preview to refresh');
  });

  it('Distance with a navigation press held: Snap off leaves the rubber band where it is', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 400, 250)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 450, 250)); }); // a pan: the rubber band does not follow
    const end = xy(s().activeMeasurement?.current);
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), end, 'Snap off moved the rubber band mid-pan');
    assert.equal(locksSeen.length, 0, 'Snap off picked under a pan');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 450, 250)); });
  });

  it("Distance, the cursor gone to the toolbar's Snap toggle: the rubber-band end moves off the snapped spot", () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    fire(canvas, 'mouseleave', 400, 250); // the HUD toggle sits over the canvas
    act(() => s().toggleSnap()); // the toggle's own handler
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'BUG: the toolbar toggle left the rubber band on the snapped spot');
    assertNoGestureLeft('the toolbar Snap toggle mid-Distance');
  });

  it('Distance, the view moved since the cursor left: the toolbar toggle does not re-pick under the new view', () => {
    const { canvas, camera, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    fire(canvas, 'mouseleave', 400, 250);
    camera.setPosition(2, 1.6, 10); // a view button or keyboard navigation
    act(() => syncMeasureScreenCoords(ctx)); // the next frame's measure pass
    locksSeen.length = 0;
    act(() => s().toggleSnap());
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'Snap off re-picked at the exit pixel under a moved view');
    assert.equal(locksSeen.length, 0, 'Snap off picked under a moved view');
  });

  it('Distance, the view moved and no frame ran since: the toolbar toggle does not re-pick under the new view', () => {
    const { canvas, camera } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    fire(canvas, 'mouseleave', 400, 250);
    camera.setPosition(2, 1.6, 10); // the animation loop's measure pass has not run since
    locksSeen.length = 0;
    act(() => s().toggleSnap());
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'Snap off re-picked at the exit pixel under a view the pass had not seen');
    assert.equal(locksSeen.length, 0, 'Snap off picked under a moved view');
  });

  it('a fresh start at another pixel with no move between (a pen tap): Snap off does not pull its end to the old cursor', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    click(canvas, 400, 250); // finishes that distance; no reset since
    assert.equal(s().measurements.length, 1, 'setup: a distance was finished');
    click(canvas, 600, 300); // a pen lifted and tapped here: no pointermove first
    assert.ok(s().activeMeasurement, 'setup: the tap set a fresh start');
    const before = `${xy(s().activeMeasurement?.start)} ${xy(s().activeMeasurement?.current)}`;
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(`${xy(s().activeMeasurement?.start)} ${xy(s().activeMeasurement?.current)}`, before, 'Snap off pulled a fresh start\'s end to the last gesture\'s cursor');
    assert.equal(locksSeen.length, 0, 'Snap off picked at the last gesture\'s cursor');
  });

  it('Distance, the canvas resized since the cursor left: the toolbar toggle does not re-pick at the old pixel', () => {
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    fire(canvas, 'mouseleave', 400, 250);
    ctx.lastCameraStateRef.current = null; // what the canvas box watch does on a same-shape resize (#8886)
    locksSeen.length = 0;
    act(() => s().toggleSnap());
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'Snap off re-picked at a pixel the resize moved');
    assert.equal(locksSeen.length, 0, 'Snap off picked after a resize');
  });

  it('a rubber band from before a tool switch: Snap off after a fresh start does not pull the end back there', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    act(() => s().setActiveTool('select'));
    act(() => s().setActiveTool('measure'));
    click(canvas, 600, 300); // a fresh start, no move since
    const before = xy(s().activeMeasurement?.current);
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), before, 'Snap off pulled the end to where an older gesture\'s cursor was');
    assert.equal(locksSeen.length, 0, 'Snap off picked at an older gesture\'s cursor');
  });

  it('a touch start after the mouse drew a rubber band: Snap off does not pull the end to the mouse', async () => {
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    click(canvas, 400, 250); // the mouse finishes that distance; no reset since
    assert.equal(s().measurements.length, 1, 'setup: the mouse finished a distance');
    act(() => handleMeasureTap(ctx, 600, 300));
    const before = `${xy(s().activeMeasurement?.start)} ${xy(s().activeMeasurement?.current)}`;
    assert.ok(s().activeMeasurement, 'setup: the tap set a start');
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(`${xy(s().activeMeasurement?.start)} ${xy(s().activeMeasurement?.current)}`, before, 'Snap off pulled a touch start\'s end to the old mouse position');
    assert.equal(locksSeen.length, 0, 'Snap off picked at the old mouse position');
  });

  it('a Snap-off re-pick leaves which input was used last alone (#8879)', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    assert.equal(s().pointerInput, 'mouse', 'setup: the mouse was used last');
    act(() => s().setPointerInput('touch')); // e.g. a finger on the panel, the cursor resting
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'setup: Snap off re-picked the rubber band');
    assert.equal(s().pointerInput, 'touch', 'the Snap-off re-pick changed which input was used last');
  });

  it('a touch start with no cursor: Snap off keeps the start and its end as they are', async () => {
    const { ctx } = mount();
    act(() => handleMeasureTap(ctx, 200, 300));
    const before = `${xy(s().activeMeasurement?.start)} ${xy(s().activeMeasurement?.current)}`;
    assert.ok(s().activeMeasurement, 'setup: the tap set a start');
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(`${xy(s().activeMeasurement?.start)} ${xy(s().activeMeasurement?.current)}`, before, 'Snap off moved a touch start');
    assert.equal(locksSeen.length, 0, 'Snap off picked with no cursor');
  });
});

describe('the Snap-off re-pick with the refs a render behind, as Viewport has them (#8992)', () => {
  const xy = (p: { x: number; y: number } | null | undefined) => (p ? `${p.x},${p.y}` : 'none');

  /** `useLatestRef` refs: they catch up with the store on the next render, after the Snap toggle's listener ran. */
  function laggingRefs() {
    const snapEnabledRef = { current: s().snapEnabled };
    const edgeLockStateRef = { current: s().edgeLockState };
    const render = () => { act(() => { snapEnabledRef.current = s().snapEnabled; edgeLockStateRef.current = s().edgeLockState; }); };
    return { refs: { snapEnabledRef, edgeLockStateRef }, render };
  }

  it('Point mode: Live is re-picked unsnapped and the next frame keeps it', () => {
    act(() => s().setMeasureMode('point'));
    const { refs, render } = laggingRefs();
    const { canvas, ctx } = mount(refs);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    render();
    assert.equal(xy(s().measurePointLive), '4,0', 'setup: the Live reading sits on the snapped edge');
    act(() => s().toggleSnap()); // the refs still say Snap on
    assert.equal(xy(s().measurePointLive), '4,0.5', 'BUG: the re-pick snapped through the not-yet-rendered Snap ref');
    render();
    act(() => syncMeasureScreenCoords(ctx)); // the next frame's measure pass, now seeing Snap off
    assert.equal(xy(s().measurePointLive), '4,0.5', 'the next frame ended the re-picked Live');
  });

  it('Distance: the end is re-picked unsnapped, without the old edge lock, and the next frame keeps it', () => {
    const { refs, render } = laggingRefs();
    const { canvas, ctx } = mount(refs);
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    render();
    assert.ok(refs.edgeLockStateRef.current.edge !== null, 'setup: the rendered lock ref holds EDGE');
    locksSeen.length = 0;
    act(() => s().toggleSnap()); // the refs still say Snap on, locked
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'BUG: the re-pick snapped through the not-yet-rendered refs');
    assert.equal(locksSeen.length > 0 && locksSeen[locksSeen.length - 1] === null, true, 'the re-pick slid along the old edge lock');
    render();
    act(() => syncMeasureScreenCoords(ctx));
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'the next frame moved the re-picked end');
    assertNoGestureLeft('the next frame after Snap off');
  });
});
