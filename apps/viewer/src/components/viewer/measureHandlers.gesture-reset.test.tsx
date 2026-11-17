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
import type { Renderer } from '@ifc-lite/renderer';
import { captureViewportFrame, registerViewportCapture, viewportCaptureOwnsFrame } from '@/lib/viewport-capture';

const s = () => useViewerStore.getState();
const initial = useViewerStore.getState();

const EDGE = { v0: { x: 0, y: 0, z: 0 }, v1: { x: 9, y: 0, z: 0 } };

/**
 * Canvas x/100 is world x, and (300 - y)/100 world y. A snapping pick snaps onto
 * and locks EDGE (world y 0); one with snapping off reads the bare surface. The
 * model ends at canvas x 700: past it is background, where a snapping pick still
 * pulls onto the corner at world 7,0 within its snap radius (60 px, 40 after a
 * slow frame). The locks each pick is handed are recorded.
 */
const locksSeen: Array<unknown> = [];
const NO_LOCK = { shouldRelease: false, shouldLock: false, edge: null, meshExpressId: null, edgeT: 0, isCorner: false, cornerValence: 0 };
function raycastSceneMagnetic(x: number, y: number, lock: { edge: unknown }, options?: { snapOptions?: { snapToEdges?: boolean; screenSnapRadius?: number } }) {
  locksSeen.push(lock.edge);
  const background = x >= 700;
  const point = { x: x / 100, y: (300 - y) / 100, z: 0 };
  const snapping = options?.snapOptions?.snapToEdges !== false;
  if (background && (!snapping || x - 700 >= (options?.snapOptions?.screenSnapRadius ?? 60))) return { intersection: null, snapTarget: null, edgeLock: NO_LOCK };
  if (!snapping) return { intersection: { point }, snapTarget: null, edgeLock: NO_LOCK };
  return {
    intersection: background ? null : { point },
    snapTarget: { type: 'edge', position: { x: background ? 7 : point.x, y: 0, z: 0 }, metadata: { vertices: [EDGE.v0, EDGE.v1] } },
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

const fire = (canvas: HTMLCanvasElement, type: string, x: number, y: number, modifiers: PointerEventInit = {}) =>
  act(() => { canvas.dispatchEvent(mousePointer(type, 0, x, y, modifiers)); });

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
    assert.equal(frames.size, 0, 'Snap off left the queued rubber-band frame to run (#9052)');
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
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    fire(canvas, 'mouseleave', 400, 250); // the HUD toggle sits over the canvas
    act(() => syncMeasureScreenCoords(ctx)); // idle frames while the cursor travels there keep the pass's state (#9052)
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
    act(() => syncMeasureScreenCoords(ctx)); // an idle frame before the toggle keeps the pass's state (#9052)
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

describe('a Snap toggle re-picks the live preview under the new setting at the cursor (#9022, #9052)', () => {
  const xy = (p: { x: number; y: number } | null | undefined) => (p ? `${p.x},${p.y}` : 'none');
  /** The pass bound to the store, as Viewport binds it, so a view change ends Point's Live (#8828). */
  const boundPass: Partial<UseMouseControlsParams> = { updateMeasurementScreenCoords: (project, moved) => s().updateMeasurementScreenCoords(project, moved) };

  it('Point mode: Live moves back onto the snapped spot, and the next frame keeps it', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas, ctx } = mount(boundPass);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    await pressKey('s');
    assert.equal(xy(s().measurePointLive), '4,0.5', 'setup: Snap off re-picked Live unsnapped');
    act(() => syncMeasureScreenCoords(ctx)); // a frame with Snap off
    await pressKey('s');
    assert.equal(s().snapEnabled, true, 'setup: S turned Snap back on');
    assert.equal(xy(s().measurePointLive), '4,0', 'BUG: Snap on left Live on the unsnapped point');
    assert.equal(s().snapVisualization !== null, true, 'Snap on showed no snap glyph');
    act(() => syncMeasureScreenCoords(ctx)); // the next frame's measure pass
    assert.equal(xy(s().measurePointLive), '4,0', 'a later frame ended or replaced the re-picked Live');
  });

  it('Distance: the rubber-band end moves back onto the snapped spot and locks, and the next frame keeps it', async () => {
    const { canvas, ctx } = mount(boundPass);
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    const start = xy(s().activeMeasurement?.start);
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'setup: Snap off re-picked the end unsnapped');
    act(() => syncMeasureScreenCoords(ctx)); // idle frames with Snap off
    act(() => syncMeasureScreenCoords(ctx));
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'BUG: Snap on left the rubber band unsnapped');
    assert.equal(xy(s().activeMeasurement?.start), start, 'Snap on moved the start');
    assert.equal(s().edgeLockState.edge !== null, true, 'Snap on did not lock the edge under the cursor');
    assert.equal(s().snapVisualization !== null, true, 'Snap on showed no snap glyph');
    act(() => syncMeasureScreenCoords(ctx));
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'the next frame moved the re-picked end');
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'a second Snap off no longer re-picked');
  });

  it('Distance, the view moved and no frame ran since: Snap on does not re-pick under the new view', async () => {
    const { canvas, camera } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    await pressKey('s');
    camera.setPosition(2, 1.6, 10); // keyboard navigation; the measure pass has not run since
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'Snap on re-picked at the old pixel under a moved view');
    assert.equal(locksSeen.length, 0, 'Snap on picked under a moved view');
  });

  it('Distance: a navigation press nudged within the click slop keeps the cursor, so Snap off still re-picks', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 400, 250)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 402, 251)); }); // under the 3 px slop: no pan
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'BUG: a nudge under the click slop forgot the cursor');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 402, 251)); });
  });

  it('Distance: a navigation press with no move keeps the cursor, so Snap off still re-picks (#9052)', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 400, 250)); });
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'a press alone forgot the cursor');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 400, 250)); });
  });

  it('Distance: a pan past the click slop and back near its press still forgets the cursor', async () => {
    const { canvas, camera } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    Object.assign(camera, { pan: () => {} }); // a pan clamped to nothing: only the drag tells the press moved
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 400, 250)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 450, 250)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 401, 250)); });
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'Snap off re-picked after a pan');
    assert.equal(locksSeen.length, 0, 'Snap off picked after a pan');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 401, 250)); });
  });

  it('Distance on the Shift axis: Snap off re-picks the unsnapped point projected onto the axis (#9052)', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300); // the start, world 2,0
    fire(canvas, 'pointermove', 250, 100, { shiftKey: true }); // snapped 2.5,0 is mostly along x
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '2.5,0', 'setup: the end follows the x axis from the snapped point');
    assert.equal(s().measurementConstraintEdge?.activeAxis ?? null, 'axis1', 'setup: the move followed the Shift axis');
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'the re-pick left the axis, or projected the snapped point');
  });

  it('Distance: Shift released without a move, Snap off re-picks off the axis, as a move there would', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 250, 100, { shiftKey: true });
    flushFrames();
    assert.equal(s().measurementConstraintEdge?.activeAxis ?? null, 'axis1', 'setup: the move followed the Shift axis');
    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' })); });
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'BUG: the re-pick still followed the released Shift axis');
  });

  it('Distance: Shift pressed without a move, Snap off re-picks on the axis, as a move there would', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 250, 100);
    flushFrames();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })); });
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'the re-pick ignored the Shift held since the move');
  });

  it('Point mode, the view moved and no frame ran since: Snap on ends Live instead of re-picking under the new view', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas, camera, ctx } = mount(boundPass);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    await pressKey('s');
    act(() => syncMeasureScreenCoords(ctx));
    assert.equal(xy(s().measurePointLive), '4,0.5', 'setup: Snap off re-picked Live unsnapped');
    camera.setPosition(2, 1.6, 10);
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(s().measurePointLive === null, true, 'Snap on re-picked Live at the old pixel under a moved view');
    assert.equal(locksSeen.length, 0, 'Snap on picked under a moved view');
  });

  it('Distance: a navigation drag past the click slop forgets the cursor, even with the view unchanged', async () => {
    const { canvas, camera } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    Object.assign(camera, { pan: () => {} }); // a pan clamped to nothing: only the slop tells the press dragged
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 400, 250)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 410, 250)); });
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'Snap off re-picked after a drag past the slop');
    assert.equal(locksSeen.length, 0, 'Snap off picked after a drag past the slop');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 410, 250)); });
  });

  it('Distance on the Shift axis: Snap back on re-picks the snapped point projected onto the axis', async () => {
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 250, 100, { shiftKey: true });
    flushFrames();
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'setup: Snap off re-picked on the axis unsnapped');
    act(() => syncMeasureScreenCoords(ctx));
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '2.5,0', 'Snap on left the axis, or kept the unsnapped point');
    assert.equal(s().measurementConstraintEdge?.activeAxis ?? null, 'axis1', 'Snap on did not follow the axis the snapped point lies along');
  });

  it('Distance: one Shift key released with the other still held keeps the axis', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 250, 100, { shiftKey: true });
    flushFrames();
    act(() => { window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', shiftKey: true })); });
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'releasing one Shift key dropped the axis');
  });

  it('known limit: a wheel zoom under the resting cursor skips the Distance re-pick (#9052)', async () => {
    const { canvas, camera } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    const pose = JSON.stringify([camera.getPosition(), camera.getDistance()]);
    act(() => { canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 400, clientY: 250, bubbles: true, cancelable: true })); });
    assert.notEqual(JSON.stringify([camera.getPosition(), camera.getDistance()]), pose, 'setup: the wheel zoomed');
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'the re-pick ran after a wheel zoom: update the known limit in #9052');
    assert.equal(locksSeen.length, 0, 'Snap off picked after a wheel zoom');
  });

  it('Point mode over background within snap reach: Snap on re-picks the corner Snap off had missed', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas, ctx } = mount(boundPass);
    fire(canvas, 'pointermove', 730, 250); // background, 30 px from the corner at 7,0
    flushFrames();
    assert.equal(xy(s().measurePointLive), '7,0', 'setup: Live snapped onto the corner');
    await pressKey('s');
    assert.equal(s().measurePointLive === null, true, 'setup: the unsnapped re-pick missed');
    act(() => syncMeasureScreenCoords(ctx));
    await pressKey('s');
    assert.equal(xy(s().measurePointLive), '7,0', 'BUG: Snap on left Live empty where a click places the corner');
  });

  it('Point mode, just after a click: Snap off keeps the placed point and shows no Live reading', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas } = mount(boundPass);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    click(canvas, 400, 250);
    assert.equal(s().measurePointLive === null, true, 'setup: the click replaced the Live reading');
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(s().measurePointLive === null, true, 'Snap off brought a Live reading back over the placed point');
    assert.equal(locksSeen.length, 0, 'Snap off picked after a click');
  });

  it('Point mode: a navigation press nudged within the click slop keeps the cursor, so Snap off still re-picks', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas } = mount(boundPass);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 400, 250)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 402, 251)); });
    await pressKey('s');
    assert.equal(xy(s().measurePointLive), '4,0.5', 'a nudge under the click slop forgot the Point cursor');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 402, 251)); });
  });

  it('Distance: Shift released while the window was away (blur, no keyup), Snap off re-picks off the axis', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 250, 100, { shiftKey: true });
    flushFrames();
    assert.equal(s().measurementConstraintEdge?.activeAxis ?? null, 'axis1', 'setup: the move followed the Shift axis');
    act(() => { window.dispatchEvent(new Event('blur')); });
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'a blur left the re-pick on the axis');
  });

  it('Point mode: a camera move then a plain move in one frame still re-picks', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas, camera } = mount(boundPass);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    camera.setPosition(2, 1.6, 10); // the measure pass has not run since
    fire(canvas, 'pointermove', 400, 250); // throttled: queues a trailing pick, notes the cursor
    await pressKey('s');
    assert.equal(xy(s().measurePointLive), '4,0.5', 'BUG: the Point move noted the view of the frame before it');
  });

  it('Point mode: a pan released inside the hover throttle does not re-pick at the pixel before it', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
    act(() => s().setMeasureMode('point'));
    const { canvas } = mount(boundPass);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    t.mock.timers.tick(10);
    fire(canvas, 'pointermove', 450, 250); // inside the throttle window: a trailing pick is queued at 450
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 450, 250)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 550, 250)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 550, 250)); });
    locksSeen.length = 0;
    act(() => t.mock.timers.tick(200));
    flushFrames();
    assert.equal(locksSeen.length, 0, 'the trailing pick ran at the pixel the pan left');
    await pressKey('s');
    assert.equal(locksSeen.length, 0, 'Snap off re-picked at the pixel the pan left');
  });

  it('Point mode: Shift pressed while a trailing hover is queued still lets it read the resting cursor', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
    act(() => s().setMeasureMode('point'));
    const { canvas } = mount(boundPass);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    t.mock.timers.tick(10);
    fire(canvas, 'pointermove', 500, 250); // inside the throttle window: a trailing pick is queued at 500
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true })); });
    act(() => t.mock.timers.tick(200));
    flushFrames();
    assert.equal(xy(s().measurePointLive), '5,0', 'BUG: Shift dropped the trailing pick, so Live stayed behind the cursor');
  });

  it('Point mode: a click that misses keeps the cursor, so Snap on still re-picks the corner there', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas, ctx } = mount(boundPass);
    fire(canvas, 'pointermove', 730, 250);
    flushFrames();
    await pressKey('s');
    assert.equal(s().measurePointLive === null, true, 'setup: the unsnapped re-pick missed');
    click(canvas, 730, 250); // Snap off: misses, places nothing
    assert.equal(s().measurePointLive === null, true, 'setup: the missed click shows no Live point');
    act(() => syncMeasureScreenCoords(ctx));
    await pressKey('s');
    assert.equal(xy(s().measurePointLive), '7,0', 'a missed click forgot the cursor');
  });

  it('Distance: a pen navigation press nudged within the slop in the same task keeps the cursor', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    act(() => {
      canvas.dispatchEvent(mousePointer('pointerdown', 1, 400, 250, { pointerType: 'pen' })); // held for a task
      canvas.dispatchEvent(mousePointer('pointermove', 1, 401, 250, { pointerType: 'pen' }));
    });
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'the held pen press was judged before it began');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 401, 250, { pointerType: 'pen' })); });
  });

  it('Distance just finished, no move since: neither Snap toggle picks or brings a lock or glyph back', async () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    click(canvas, 400, 250);
    assert.equal(s().measurements.length, 1, 'setup: the distance was finished');
    locksSeen.length = 0;
    await pressKey('s');
    await pressKey('s');
    assert.equal(locksSeen.length, 0, 'a Snap toggle picked over a finished distance');
    assert.equal(s().snapVisualization === null, true, 'a Snap toggle brought the snap glyph back');
    assert.equal(s().edgeLockState.edge === null, true, 'a Snap toggle brought the edge lock back');
  });

  for (const mode of ['point', 'drag'] as const) {
    it(`${mode === 'point' ? 'Point mode' : 'Distance'}: a drawing-buffer pixel-ratio swap since the move still re-picks`, async () => {
      act(() => s().setMeasureMode(mode));
      const { canvas, ctx } = mount(boundPass);
      if (mode === 'drag') click(canvas, 200, 300);
      fire(canvas, 'pointermove', 400, 250);
      flushFrames();
      Object.assign(canvas, { width: 1600, height: 1200 }); // the HiDPI buffer back after a zoom's low-ratio frames
      act(() => syncMeasureScreenCoords(ctx));
      await pressKey('s');
      const end = mode === 'point' ? s().measurePointLive : s().activeMeasurement?.current;
      assert.equal(xy(end), '4,0.5', 'BUG: a pixel-ratio swap alone cancelled the re-pick');
    });
  }

  it('Distance: a canvas reshaped since the move (a new aspect) still skips the re-pick', async () => {
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    Object.assign(canvas, { width: 800, height: 300 }); // a panel opened: another view under the cursor
    act(() => syncMeasureScreenCoords(ctx));
    locksSeen.length = 0;
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'Snap off re-picked after the canvas changed shape');
    assert.equal(locksSeen.length, 0, 'Snap off picked after the canvas changed shape');
  });

  it('Point mode: a left-button orbit press nudged within the click slop keeps the cursor', async () => {
    act(() => s().setMeasureMode('point'));
    const { canvas } = mount(boundPass);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    fire(canvas, 'pointerdown', 400, 250); // Point mode's left press orbits once past the slop
    fire(canvas, 'pointermove', 402, 251);
    await pressKey('s');
    assert.equal(xy(s().measurePointLive), '4,0.5', 'an orbit press nudged within the slop forgot the cursor');
    fire(canvas, 'pointerup', 402, 251);
  });

  it('the Shift and blur listeners are removed with the mouse controls', () => {
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    const add = window.addEventListener, remove = window.removeEventListener;
    const watched = new Set(['keydown', 'keyup', 'blur']);
    window.addEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => {
      if (watched.has(type)) added.push([type, fn]);
      add.call(window, type, fn, o);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, fn: EventListenerOrEventListenerObject, o?: EventListenerOptions | boolean) => {
      if (watched.has(type)) removed.push([type, fn]);
      remove.call(window, type, fn, o);
    }) as typeof window.removeEventListener;
    try {
      mount();
      assert.equal(added.length > 0, true, 'setup: no window key or blur listener was added');
      cleanupMouseControls();
    } finally {
      window.addEventListener = add;
      window.removeEventListener = remove;
    }
    const left = added.filter(([type, fn]) => !removed.some(([t, f]) => t === type && f === fn)).map(([type]) => type);
    assert.deepEqual(left, [], 'window listeners outlived the mouse controls');
  });

  it('Distance: a camera move then a plain move in one frame still re-picks (#9052)', async () => {
    const { canvas, camera } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    camera.setPosition(2, 1.6, 10); // an arrow-key pan in its own rAF; the measure pass has not run since
    fire(canvas, 'pointermove', 400, 250); // the move draws under the new view
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'BUG: the move noted the view of the frame before it');
  });
});

describe('the Distance end over background (#9049)', () => {
  const xy = (p: { x: number; y: number } | null | undefined) => (p ? `${p.x},${p.y}` : 'none');

  it('collapses onto the start, as the first click left it, and drops the snap glyph', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'setup: the end is on the model');
    fire(canvas, 'pointermove', 780, 250); // background, out of snap reach
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), xy(s().activeMeasurement?.start), 'BUG: the end stayed on the last hit over background');
    assert.equal(s().activeMeasurement?.distance, 0, 'the readout kept a distance a click there cannot make');
    assertNoGestureLeft('the rubber band over background');
    click(canvas, 780, 250);
    assert.equal(s().measurements.length, 0, 'a click over background measured something');
    assert.ok(s().activeMeasurement, 'a click over background dropped the start');
    fire(canvas, 'pointermove', 500, 250);
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '5,0', 'the end did not follow the cursor back onto the model');
  });

  it('after a slow frame, a reduced pick that misses within the full snap reach keeps the corner a click would measure', () => {
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 750, 250); // 50 px past the model: in the 60 px reach, not the reduced 40 px
    ctx.lastMeasureRaycastDurationRef.current = 1e6; // the last raycast was slow
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '7,0', 'BUG: the reduced pick collapsed the end where a click measures');
    click(canvas, 750, 250);
    assert.equal(s().measurements.length, 1, 'setup: the click measured to the corner');
    assert.equal(xy(s().measurements[0].end), '7,0', 'the click measured somewhere else');
  });

  it('picks per frame over background after a slow frame: one retry with Snap on, none with Snap off, none on the next fast frame', async () => {
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    const frame = (x: number) => {
      ctx.lastMeasureRaycastDurationRef.current = 1e6;
      fire(canvas, 'pointermove', x, 250);
      locksSeen.length = 0;
      flushFrames();
      return locksSeen.length;
    };
    assert.equal(frame(780), 2, 'a reduced miss with Snap on is checked once with the full options');
    fire(canvas, 'pointermove', 781, 250);
    locksSeen.length = 0;
    flushFrames(); // the retry was not timed: this frame is not reduced
    assert.equal(locksSeen.length, 1, 'the retry kept the next frame reduced');
    await pressKey('s');
    assert.equal(frame(780), 1, 'with Snap off the reduced options are the full ones: no retry');
  });

  it('on the Shift axis, collapses too and drops the active axis', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250, { shiftKey: true });
    flushFrames();
    assert.equal(s().measurementConstraintEdge?.activeAxis ?? null, 'axis1', 'setup: the x axis is active');
    fire(canvas, 'pointermove', 780, 250, { shiftKey: true });
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), xy(s().activeMeasurement?.start), 'the end stayed on the axis over background');
    assert.equal(s().measurementConstraintEdge?.activeAxis ?? null, null, 'an axis stayed active with no end on it');
  });

  it('Snap off where only the snapped corner was hit collapses the end, and Snap on brings the corner back', async () => {
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 730, 250); // background, within reach of the corner at 7,0
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '7,0', 'setup: the end snapped onto the corner');
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), xy(s().activeMeasurement?.start), 'BUG: Snap off kept the snapped corner over background');
    assertNoGestureLeft('Snap off over background');
    act(() => syncMeasureScreenCoords(ctx));
    await pressKey('s');
    assert.equal(xy(s().activeMeasurement?.current), '7,0', 'Snap on did not snap the end back onto the corner');
  });
});

describe('the Snap-on re-pick with the refs a render behind, as Viewport has them (#9022)', () => {
  const xy = (p: { x: number; y: number } | null | undefined) => (p ? `${p.x},${p.y}` : 'none');

  it('Point mode: Live is re-picked snapped although the Snap ref still says off, and the next frame keeps it', () => {
    act(() => s().setMeasureMode('point'));
    const snapEnabledRef = { current: s().snapEnabled };
    const edgeLockStateRef = { current: s().edgeLockState };
    const render = () => { act(() => { snapEnabledRef.current = s().snapEnabled; edgeLockStateRef.current = s().edgeLockState; }); };
    const { canvas, ctx } = mount({ snapEnabledRef, edgeLockStateRef, updateMeasurementScreenCoords: (p, moved) => s().updateMeasurementScreenCoords(p, moved) });
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    render();
    act(() => s().toggleSnap());
    render();
    act(() => syncMeasureScreenCoords(ctx));
    assert.equal(xy(s().measurePointLive), '4,0.5', 'setup: Snap off re-picked Live unsnapped');
    act(() => s().toggleSnap()); // the ref still says Snap off
    assert.equal(xy(s().measurePointLive), '4,0', 'BUG: the re-pick read the not-yet-rendered Snap ref');
    render();
    act(() => syncMeasureScreenCoords(ctx));
    assert.equal(xy(s().measurePointLive), '4,0', 'the next frame ended or replaced the re-picked Live');
  });

  it('Distance: the end is re-picked snapped although the Snap ref still says off', () => {
    const snapEnabledRef = { current: s().snapEnabled };
    const edgeLockStateRef = { current: s().edgeLockState };
    const render = () => { act(() => { snapEnabledRef.current = s().snapEnabled; edgeLockStateRef.current = s().edgeLockState; }); };
    const { canvas, ctx } = mount({ snapEnabledRef, edgeLockStateRef });
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    render();
    act(() => s().toggleSnap());
    render();
    act(() => syncMeasureScreenCoords(ctx)); // a frame with Snap off
    assert.equal(xy(s().activeMeasurement?.current), '4,0.5', 'setup: Snap off re-picked the end unsnapped');
    act(() => s().toggleSnap()); // the ref still says Snap off
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'BUG: the re-pick read the not-yet-rendered Snap ref');
    render();
    act(() => syncMeasureScreenCoords(ctx));
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '4,0', 'the next frame moved the re-picked end');
  });
});

describe('Shift pressed or released at rest re-picks the Distance rubber band (#9161)', () => {
  const xy = (p: { x: number; y: number } | null | undefined) => (p ? `${p.x},${p.y}` : 'none');
  const axis = () => s().measurementConstraintEdge?.activeAxis ?? 'none';
  const shift = (type: 'keydown' | 'keyup', held: boolean) =>
    act(() => { window.dispatchEvent(new KeyboardEvent(type, { key: 'Shift', shiftKey: held })); });

  /** Snap off, so the free end (2.5,2) and the Shift axis end (2,2, on world Y) differ. */
  function freeEnd(canvas: HTMLCanvasElement, held = false): void {
    act(() => { snapOn.current = false; });
    click(canvas, 200, 300); // the start, world 2,0
    fire(canvas, 'pointermove', 250, 100, { shiftKey: held });
    flushFrames();
  }

  it('Shift pressed: the end moves onto the axis and highlights it, as a Shift move there would', () => {
    const { canvas } = mount();
    freeEnd(canvas);
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'setup: the end follows the cursor freely');
    shift('keydown', true);
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'BUG: the end stayed off the axis a Shift click lands on');
    assert.equal(axis(), 'axis2', 'BUG: the axis the end follows is not highlighted');
    fire(canvas, 'pointermove', 250, 100, { shiftKey: true });
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'a Shift move at the same spot disagrees with the re-pick');
  });

  it('Shift released: the end leaves the axis and the highlight goes, as a plain move there would', () => {
    const { canvas } = mount();
    freeEnd(canvas, true);
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'setup: the end follows the Shift axis');
    assert.equal(axis(), 'axis2', 'setup: the axis is highlighted');
    shift('keyup', false);
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'BUG: the end stayed on the axis after Shift was released');
    assert.equal(axis(), 'none', 'BUG: the axis stayed highlighted after Shift was released');
  });

  it('with Snap on, Shift pressed and released at rest highlights the axis and clears it', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 250, 100);
    flushFrames();
    assert.equal(axis(), 'none', 'setup: no axis is highlighted');
    shift('keydown', true);
    assert.equal(axis(), 'axis1', 'BUG: Shift pressed at rest did not highlight the axis the snapped end follows');
    assert.equal(xy(s().activeMeasurement?.current), '2.5,0', 'the snapped end left the axis it lies on');
    shift('keyup', false);
    assert.equal(axis(), 'none', 'BUG: Shift released at rest left the axis highlighted');
  });

  it('a blur with Shift held releases the axis too', () => {
    const { canvas } = mount();
    freeEnd(canvas, true);
    act(() => { window.dispatchEvent(new Event('blur')); });
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'a blur left the end on the axis');
    assert.equal(axis(), 'none', 'a blur left the axis highlighted');
  });

  it('a held Shift key repeating its keydown picks once', () => {
    const { canvas } = mount();
    freeEnd(canvas);
    locksSeen.length = 0;
    shift('keydown', true);
    shift('keydown', true);
    shift('keydown', true);
    assert.equal(locksSeen.length, 1, 'a repeated keydown re-picked again');
  });

  it('a rubber-band frame queued with the old Shift state does not land afterwards', () => {
    const { canvas } = mount();
    freeEnd(canvas);
    fire(canvas, 'pointermove', 250, 100); // queues a frame without Shift
    assert.equal(frames.size, 1, 'setup: a rubber-band frame is queued');
    shift('keydown', true);
    assert.equal(frames.size, 0, 'the queued frame was kept');
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'the queued frame moved the end back off the axis');
  });

  for (const held of [true, false]) {
    it(`a queued frame uses Shift ${held ? 'pressed' : 'released'} after a view change skips the re-pick (#9242)`, () => {
      const { canvas, camera } = mount();
      freeEnd(canvas, !held);
      fire(canvas, 'pointermove', 250, 100, { shiftKey: !held });
      assert.equal(frames.size, 1, 'setup: a rubber-band frame is queued');
      camera.setPosition(2, 1.6, 10);
      locksSeen.length = 0;
      shift(held ? 'keydown' : 'keyup', held);
      assert.equal(locksSeen.length, 0, 'setup: the changed view skips the immediate re-pick');
      assert.equal(frames.size, 1, 'Shift dropped the frame with no re-pick to replace it');
      flushFrames();
      assert.equal(xy(s().activeMeasurement?.current), held ? '2,2' : '2.5,2', 'the queued preview used the old Shift state');
      assert.equal(axis(), held ? 'axis2' : 'none', 'the axis highlight used the old Shift state');
    });
  }

  it('Shift during fly leaves the Distance preview alone until a measure move (#9242)', () => {
    const { canvas } = mount();
    freeEnd(canvas);
    fire(canvas, 'pointerdown', 250, 100, { button: 2, buttons: 2 });
    locksSeen.length = 0;
    shift('keydown', true);
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'Shift moved the end during fly');
    assert.equal(axis(), 'none', 'Shift highlighted an axis during fly');
    assert.equal(locksSeen.length, 0, 'Shift raycast during fly');
    fire(canvas, 'pointerup', 250, 100, { button: 2 });
    fire(canvas, 'pointermove', 250, 100, { shiftKey: true });
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'a measure move after fly did not resume the Shift preview');
    assert.equal(axis(), 'axis2');
  });

  it('with the lock ref a render behind Snap off, the Shift re-pick slides along no old edge', () => {
    const edgeLockStateRef = { current: s().edgeLockState };
    const snapEnabledRef = { current: s().snapEnabled };
    const render = () => { act(() => { snapEnabledRef.current = s().snapEnabled; edgeLockStateRef.current = s().edgeLockState; }); };
    const { canvas } = mount({ snapEnabledRef, edgeLockStateRef });
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 250, 100, { shiftKey: true });
    flushFrames();
    render();
    assert.equal(edgeLockStateRef.current.edge !== null, true, 'setup: the rubber band locked the edge');
    act(() => s().toggleSnap()); // Snap off clears the lock in the store; the refs still hold it
    locksSeen.length = 0;
    shift('keyup', false);
    assert.equal(locksSeen.length, 1, 'setup: Shift released re-picked');
    assert.equal(locksSeen[0] === null, true, 'BUG: the Shift re-pick slid along the lock Snap off had dropped');
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'the end did not leave the axis');
  });

  it('the view moved and no frame ran since: Shift does not re-pick under the new view', () => {
    const { canvas, camera } = mount();
    freeEnd(canvas);
    camera.setPosition(2, 1.6, 10);
    locksSeen.length = 0;
    shift('keydown', true);
    assert.equal(locksSeen.length, 0, 'Shift picked at the old pixel under a moved view');
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'Shift moved the end under a moved view');
  });

  it('a navigation drag past the click slop forgot the cursor: Shift picks nothing', () => {
    const { canvas, camera } = mount();
    freeEnd(canvas);
    Object.assign(camera, { pan: () => {} });
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 250, 100)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 270, 100)); });
    locksSeen.length = 0;
    shift('keydown', true);
    assert.equal(locksSeen.length, 0, 'Shift re-picked after a pan');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 270, 100)); });
  });

  it('another tool owning the frame ref: Shift leaves its queued frame alone and picks nothing', () => {
    const toolRef = { current: 'measure' as string };
    const { canvas, ctx } = mount({ activeToolRef: toolRef as UseMouseControlsParams['activeToolRef'] });
    freeEnd(canvas);
    toolRef.current = 'command'; // the ref alone, so the cursor record outlives the switch
    let commandFrameRan = false;
    ctx.measureRaycastPendingRef.current = true;
    ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => { commandFrameRan = true; });
    locksSeen.length = 0;
    shift('keydown', true);
    assert.equal(locksSeen.length, 0, 'Shift re-picked the rubber band in another tool');
    flushFrames();
    assert.equal(commandFrameRan, true, "Shift dropped the other tool's queued frame");
  });

  it('a capture holding the frame: Shift does not pick through its camera and clip', async () => {
    const { canvas, ctx } = mount();
    freeEnd(canvas);
    const renderer = Object.assign(ctx.renderer, { renderWithResult: () => true, getGPUDevice: () => null }) as unknown as Renderer;
    const unregister = registerViewportCapture(renderer, canvas, () => ({}));
    try {
      void captureViewportFrame(renderer, { read: () => 'pixels' });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      assert.equal(viewportCaptureOwnsFrame(renderer), true, 'setup: the capture holds the frame');
      locksSeen.length = 0;
      shift('keydown', true);
      assert.equal(locksSeen.length, 0, "BUG: the Shift re-pick read the capture's camera and clip");
      assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'Shift moved the end during the capture');
    } finally { unregister(); }
  });

  it('a capture holding the frame: a Snap toggle does not re-pick the Distance end through its camera', async () => {
    const { canvas, ctx } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    const renderer = Object.assign(ctx.renderer, { renderWithResult: () => true, getGPUDevice: () => null }) as unknown as Renderer;
    const unregister = registerViewportCapture(renderer, canvas, () => ({}));
    try {
      void captureViewportFrame(renderer, { read: () => 'pixels' });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      assert.equal(viewportCaptureOwnsFrame(renderer), true, 'setup: the capture holds the frame');
      locksSeen.length = 0;
      await pressKey('s');
      assert.equal(locksSeen.length, 0, "the Snap toggle re-picked through the capture's camera and clip");
      assert.equal(xy(s().activeMeasurement?.current), '4,0', 'the Snap toggle moved the end during the capture');
    } finally { unregister(); }
  });

  it('a drag-to-measure press held: Shift at rest moves the end onto the axis, and the Shift release finishes there', () => {
    const { canvas } = mount();
    act(() => { snapOn.current = false; });
    fire(canvas, 'pointerdown', 200, 300);
    fire(canvas, 'pointermove', 250, 100, { buttons: 1 });
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'setup: the drag draws the end freely');
    shift('keydown', true);
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'Shift during a held press left the end off the axis');
    fire(canvas, 'pointerup', 250, 100, { shiftKey: true });
    const last = s().measurements[s().measurements.length - 1];
    assert.equal(xy(last?.end), '2,2', 'the Shift release finished away from the preview');
  });

  it('a navigation press within its click slop keeps the cursor: Shift still re-picks', () => {
    const { canvas } = mount();
    freeEnd(canvas);
    act(() => { canvas.dispatchEvent(mousePointer('pointerdown', 1, 250, 100)); });
    act(() => { canvas.dispatchEvent(mousePointer('pointermove', 1, 251, 101)); }); // under the 3 px slop: no pan
    shift('keydown', true);
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'a nudge under the click slop stopped the Shift re-pick');
    act(() => { canvas.dispatchEvent(mousePointer('pointerup', 1, 251, 101)); });
  });

  it('with no start pending, Shift picks nothing and starts nothing', () => {
    const { canvas } = mount();
    fire(canvas, 'pointermove', 250, 100);
    flushFrames();
    locksSeen.length = 0;
    shift('keydown', true);
    assert.equal(locksSeen.length, 0, 'Shift picked with no distance started');
    assert.equal(s().activeMeasurement === null, true, 'Shift started a distance');
  });

  it('Point mode: Shift picks nothing (its pick ignores Shift)', () => {
    act(() => s().setMeasureMode('point'));
    const { canvas } = mount();
    fire(canvas, 'pointermove', 400, 250);
    flushFrames();
    // Point never sets one; seeded so the Shift change reaches the mode check
    act(() => s().setMeasurementConstraintEdge({
      axes: { axis1: { x: 1, y: 0, z: 0 }, axis2: { x: 0, y: 1, z: 0 }, axis3: { x: 0, y: 0, z: 1 } },
      colors: { axis1: '#f00', axis2: '#0f0', axis3: '#00f' }, activeAxis: null,
    }));
    locksSeen.length = 0;
    shift('keydown', true);
    shift('keyup', false);
    assert.equal(locksSeen.length, 0, 'Shift re-picked in Point mode');
  });

  it('after Shift at rest, a Snap toggle still re-picks on the axis, and the next frame keeps the end', async () => {
    const { canvas, ctx } = mount();
    freeEnd(canvas);
    shift('keydown', true);
    act(() => syncMeasureScreenCoords(ctx)); // the next frame's measure pass
    flushFrames();
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'the next frame moved the end Shift re-picked');
    await pressKey('s');
    assert.equal(s().snapEnabled, true, 'setup: S turned Snap on');
    assert.equal(axis(), 'axis1', 'the Snap toggle after Shift at rest left the axis');
  });

  it('with the Snap ref a render behind a toggle, Shift picks under the setting the store holds', () => {
    const snapEnabledRef = { current: s().snapEnabled };
    const { canvas } = mount({ snapEnabledRef });
    click(canvas, 200, 300);
    fire(canvas, 'pointermove', 250, 100);
    flushFrames();
    act(() => s().toggleSnap()); // Snap off; the ref still says on
    assert.equal(xy(s().activeMeasurement?.current), '2.5,2', 'setup: Snap off re-picked the end unsnapped');
    shift('keydown', true);
    assert.equal(xy(s().activeMeasurement?.current), '2,2', 'BUG: the Shift re-pick snapped through the not-yet-rendered Snap ref');
  });

  it('a Shift click at rest finishes where the preview showed', () => {
    const { canvas } = mount();
    freeEnd(canvas);
    shift('keydown', true);
    const preview = xy(s().activeMeasurement?.current);
    fire(canvas, 'pointerdown', 250, 100, { shiftKey: true });
    fire(canvas, 'pointerup', 250, 100, { shiftKey: true });
    fire(canvas, 'click', 250, 100, { shiftKey: true });
    const last = s().measurements[s().measurements.length - 1];
    assert.equal(xy(last?.end), preview, 'the Shift click finished away from the preview');
  });
});
