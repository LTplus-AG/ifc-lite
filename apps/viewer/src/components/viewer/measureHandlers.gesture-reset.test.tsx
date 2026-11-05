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

const ref = <T,>(current: T) => ({ current });
const snapOn = ref(true);
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

async function pressEscape(): Promise<void> {
  function Keys(): null { useKeyboardShortcuts(); return null; }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<Keys />); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  await act(async () => { root.unmount(); });
  host.remove();
}

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
