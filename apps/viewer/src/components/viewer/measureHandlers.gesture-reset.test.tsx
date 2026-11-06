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

const s = () => useViewerStore.getState();
const initial = useViewerStore.getState();

const EDGE = { v0: { x: 0, y: 0, z: 0 }, v1: { x: 9, y: 0, z: 0 } };

/** Canvas x/100 is world x. Every pick snaps to and locks EDGE; the locks each pick is handed are recorded. */
const locksSeen: Array<unknown> = [];
function raycastSceneMagnetic(x: number, y: number, lock: { edge: unknown }) {
  locksSeen.push(lock.edge);
  const point = { x: x / 100, y: (300 - y) / 100, z: 0 };
  return {
    intersection: { point },
    snapTarget: { type: 'edge', position: point, metadata: { vertices: [EDGE.v0, EDGE.v1] } },
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

function mount() {
  const rig = mountMouseControls(storeBound);
  Object.assign(rig.params.rendererRef.current!, { raycastSceneMagnetic });
  const ctx = {
    ...rig.params, canvas: rig.canvas, renderer: rig.params.rendererRef.current,
    camera: rig.params.rendererRef.current!.getCamera(), mouseState: rig.params.mouseStateRef.current,
  } as unknown as MouseHandlerContext;
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
