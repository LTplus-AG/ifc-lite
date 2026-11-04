/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8771: Distance is click–click, like Polyline/Angle/Radius.
 *
 * Mounts the real `useMouseControls` with its measure context bound to the
 * shared store, the way `Viewport.tsx` binds it. A press that stays inside the
 * click slop sets the start; moving shows the rubber band; a second click
 * finishes. A press that moves past the slop and is released still completes
 * the measurement, so press-drag-release keeps working.
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

/** Canvas x/100 is world x and (300 - y)/100 is world y; x > 700 is empty background. */
function raycastSceneMagnetic(x: number, y: number) {
  const edgeLock = { shouldRelease: false, shouldLock: false, edge: null };
  if (x > 700) return { intersection: null, snapTarget: null, edgeLock };
  return { intersection: { point: { x: x / 100, y: (300 - y) / 100, z: 0 } }, snapTarget: null, edgeLock };
}

/** The measure context bound to the store, as Viewport.tsx binds it. */
const storeBound: Partial<UseMouseControlsParams> = {
  activeToolRef: { current: 'measure' },
  activeMeasurementRef: { get current() { return s().activeMeasurement; }, set current(_v) { /* store-owned */ } },
  measurementConstraintEdgeRef: { get current() { return s().measurementConstraintEdge; }, set current(_v) { /* store-owned */ } },
  startMeasurement: (p) => s().startMeasurement(p),
  updateMeasurement: (p) => s().updateMeasurement(p),
  finalizeMeasurement: () => s().finalizeMeasurement(),
  setMeasurementConstraintEdge: (edge) => s().setMeasurementConstraintEdge(edge),
  updateConstraintActiveAxis: (axis) => s().updateConstraintActiveAxis(axis),
  edgeLockStateRef: { get current() { return s().edgeLockState; }, set current(_v) { /* store-owned */ } },
  setEdgeLock: (edge, id, t) => s().setEdgeLock(edge, id, t),
  updateEdgeLockPosition: (t, corner, valence) => s().updateEdgeLockPosition(t, corner, valence),
  clearEdgeLock: () => s().clearEdgeLock(),
  incrementEdgeLockStrength: () => s().incrementEdgeLockStrength(),
};

// The measure raycasts are rAF-throttled; run them on demand.
let frames: FrameRequestCallback[] = [];
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
function flushFrames(): void {
  const run = frames; frames = [];
  act(() => { for (const f of run) f(0); });
}

function mount() {
  const rig = mountMouseControls(storeBound);
  Object.assign(rig.params.rendererRef.current!, { raycastSceneMagnetic });
  return rig;
}

const fire = (canvas: HTMLCanvasElement, type: string, x: number, y: number, init: PointerEventInit = {}, button = 0) =>
  act(() => { canvas.dispatchEvent(mousePointer(type, button, x, y, init)); });

function click(canvas: HTMLCanvasElement, x: number, y: number, init: PointerEventInit = {}): void {
  fire(canvas, 'pointerdown', x, y, init);
  fire(canvas, 'pointerup', x, y, init);
}

function hover(canvas: HTMLCanvasElement, x: number, y: number, init: PointerEventInit = {}): void {
  fire(canvas, 'pointermove', x, y, init);
  flushFrames();
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

beforeEach(() => {
  useViewerStore.setState(initial, true);
  s().setActiveTool('measure');
  s().setMeasureMode('drag');
  frames = [];
  globalThis.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
  globalThis.cancelAnimationFrame = () => { frames = []; };
});

afterEach(() => {
  cleanupMouseControls();
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  useViewerStore.setState(initial, true);
});

describe('Distance is click–click (#8771)', () => {
  it('the first click sets the start, moving shows the live distance, the second click finishes', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    assert.equal(s().measurements.length, 0, 'BUG: the first click finished a zero-length measurement');
    assert.ok(s().activeMeasurement, 'the first click leaves a start pending');
    assert.ok(near(s().activeMeasurement!.start.x, 2));

    hover(canvas, 500, 300);
    assert.ok(near(s().activeMeasurement!.distance, 3), `live distance ${s().activeMeasurement!.distance}, expected 3`);
    assert.equal(s().measurements.length, 0, 'hovering must not finish');

    click(canvas, 500, 300);
    assert.equal(s().measurements.length, 1);
    assert.ok(near(s().measurements[0].distance, 3), `distance ${s().measurements[0].distance}, expected 3`);
    assert.equal(s().activeMeasurement, null);
  });

  it('press-drag-release still completes the measurement', () => {
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    for (let x = 250; x <= 500; x += 50) { fire(canvas, 'pointermove', x, 300); flushFrames(); }
    fire(canvas, 'pointerup', 500, 300);
    assert.equal(s().measurements.length, 1, 'a drag past the slop and release must finish');
    assert.ok(near(s().measurements[0].distance, 3));
    assert.equal(s().activeMeasurement, null);
  });

  it('jitter inside the click slop keeps the press a click', () => {
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    hover(canvas, 202, 302);
    fire(canvas, 'pointerup', 202, 302);
    assert.equal(s().measurements.length, 0, 'a 2px wobble finished a measurement');
    assert.ok(s().activeMeasurement, 'the start stays pending');
  });

  it('Shift constrains the rubber band and a Shift+click finishes on the axis instead of panning', () => {
    const { canvas, camera } = mount();
    click(canvas, 200, 300);
    const before = JSON.stringify(camera.getPosition());
    hover(canvas, 500, 280, { shiftKey: true });
    assert.ok(near(s().activeMeasurement!.distance, 3), `constrained live distance ${s().activeMeasurement!.distance}`);
    assert.equal(s().measurementConstraintEdge?.activeAxis, 'axis1');

    fire(canvas, 'pointerdown', 500, 280, { shiftKey: true });
    hover(canvas, 501, 280, { shiftKey: true });
    fire(canvas, 'pointerup', 501, 280, { shiftKey: true });
    assert.equal(JSON.stringify(camera.getPosition()), before, 'BUG: Shift+click panned the camera');
    assert.equal(s().measurements.length, 1, 'Shift+click did not finish the measurement');
    const m = s().measurements[0];
    assert.ok(near(m.end.y, 0) && near(m.distance, 3.01), `end ${m.end.x},${m.end.y} distance ${m.distance}`);
  });

  it('a Shift press without a pending start still pans (control)', () => {
    const { canvas } = mount();
    click(canvas, 200, 300, { shiftKey: true });
    assert.equal(s().activeMeasurement, null, 'Shift+press with nothing pending is a pan, not a start');
  });

  it('a second click on empty background is ignored; the start stays pending', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    hover(canvas, 400, 300);
    click(canvas, 750, 300);
    assert.equal(s().measurements.length, 0, 'a background click finished on a stale point');
    assert.ok(s().activeMeasurement, 'the start survives a miss');
    click(canvas, 600, 300);
    assert.equal(s().measurements.length, 1);
    assert.ok(near(s().measurements[0].distance, 4));
  });

  it('a first click on empty background starts nothing', () => {
    const { canvas } = mount();
    click(canvas, 750, 300);
    assert.equal(s().activeMeasurement, null);
    assert.equal(s().measurements.length, 0);
  });

  it('a double-click on the start does not finish a zero-length measurement', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    click(canvas, 200, 300);
    assert.equal(s().measurements.length, 0, 'the second half of a double-click finished a 0 m measurement');
    assert.ok(s().activeMeasurement);
  });

  it('orbiting and panning with other buttons while a start is pending neither finishes nor cancels it', () => {
    const { canvas, camera } = mount();
    click(canvas, 200, 300);
    const before = JSON.stringify(camera.getPosition());
    fire(canvas, 'pointerdown', 400, 300, {}, 1);
    fire(canvas, 'pointermove', 460, 330, {}, 1);
    fire(canvas, 'pointerup', 460, 330, {}, 1);
    fire(canvas, 'pointerdown', 400, 300, { altKey: true });
    fire(canvas, 'pointermove', 460, 330, { altKey: true });
    fire(canvas, 'pointerup', 460, 330, { altKey: true });
    assert.notEqual(JSON.stringify(camera.getPosition()), before, 'the camera moved');
    assert.equal(s().measurements.length, 0, 'navigating finished the measurement');
    assert.ok(s().activeMeasurement, 'navigating cancelled the pending start');
    click(canvas, 500, 300);
    assert.equal(s().measurements.length, 1);
    assert.ok(near(s().measurements[0].distance, 3));
  });

  it('switching to Polyline mid-gesture drops the pending start', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    act(() => s().setMeasureMode('polyline'));
    assert.equal(s().activeMeasurement, null);
    act(() => s().setMeasureMode('drag'));
    click(canvas, 500, 300);
    assert.equal(s().measurements.length, 0, 'a start from before the mode switch leaked into the next click');
    assert.ok(s().activeMeasurement, 'the click after switching back is a fresh start');
  });

  it('switching mode while the first press is held leaves nothing pending', () => {
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    act(() => s().setMeasureMode('polyline'));
    fire(canvas, 'pointerup', 200, 300);
    act(() => s().setMeasureMode('drag'));
    assert.equal(s().activeMeasurement, null, 'the press from before the switch left a start behind');
    click(canvas, 500, 300);
    assert.equal(s().measurements.length, 0, 'the next click finished instead of starting');
  });

  it('a second press dragged past the slop finishes where it is released', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    fire(canvas, 'pointerdown', 400, 300);
    for (let x = 450; x <= 600; x += 50) { fire(canvas, 'pointermove', x, 300); flushFrames(); }
    fire(canvas, 'pointerup', 600, 300);
    assert.equal(s().measurements.length, 1);
    assert.ok(near(s().measurements[0].distance, 4), `distance ${s().measurements[0].distance}, expected 4`);
    assert.equal(s().activeMeasurement, null);
  });

  it('a press wobbled past the slop and back onto the start keeps the start pending', () => {
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    hover(canvas, 205, 300);
    fire(canvas, 'pointerup', 200, 300);
    assert.equal(s().measurements.length, 0, 'BUG: a wobbled click finished a 0 m measurement');
    assert.ok(s().activeMeasurement, 'the start stays pending');
  });

  it('a drag released on empty background keeps the start pending instead of finishing short', () => {
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    hover(canvas, 400, 300);
    fire(canvas, 'pointermove', 750, 300);
    fire(canvas, 'pointerup', 750, 300);
    assert.equal(s().measurements.length, 0, 'BUG: a release on background finished at a stale point');
    assert.ok(s().activeMeasurement, 'the start stays pending');
    click(canvas, 500, 300);
    assert.equal(s().measurements.length, 1);
    assert.ok(near(s().measurements[0].distance, 3));
  });

  it('a double-click finishing the distance leaves no stray start behind', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    click(canvas, 500, 300);
    click(canvas, 500, 300);
    fire(canvas, 'dblclick', 500, 300);
    assert.equal(s().measurements.length, 1);
    assert.ok(near(s().measurements[0].distance, 3));
    assert.equal(s().activeMeasurement, null, 'BUG: the second half of the double-click left a new start');
  });

  it('a start chained from the previous end on purpose survives a later double-click', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    click(canvas, 500, 300);
    click(canvas, 500, 300);
    assert.ok(s().activeMeasurement, 'a slow click on the previous end starts a new distance');
    click(canvas, 750, 300);
    click(canvas, 750, 300);
    fire(canvas, 'dblclick', 750, 300);
    assert.ok(s().activeMeasurement, 'BUG: a double-click on background dropped the chained start');
    click(canvas, 600, 300);
    assert.equal(s().measurements.length, 2);
    assert.ok(near(s().measurements[1].distance, 1));
  });

  it('a navigation press between a finish and a deliberate start breaks the double-click chain', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    hover(canvas, 500, 280, { shiftKey: true });
    click(canvas, 500, 280, { shiftKey: true });
    assert.equal(s().measurements.length, 1);
    click(canvas, 600, 300, { shiftKey: true });
    assert.equal(s().activeMeasurement, null, 'Shift with nothing pending pans');
    click(canvas, 600, 300);
    fire(canvas, 'dblclick', 600, 300);
    assert.ok(s().activeMeasurement, 'BUG: the dblclick of a pan press and a start press dropped the start');

    click(canvas, 400, 300);
    click(canvas, 400, 300);
    assert.ok(s().activeMeasurement, 'a slow click on the previous end starts a chained distance');
    click(canvas, 300, 300, { altKey: true });
    click(canvas, 300, 300, { altKey: true });
    fire(canvas, 'dblclick', 300, 300, { altKey: true });
    assert.ok(s().activeMeasurement, 'BUG: an Alt double-click (orbit) dropped the chained start');
  });

  it('a Shift double-click finishes on the axis and leaves no stray start', () => {
    const { canvas } = mount();
    click(canvas, 200, 300);
    hover(canvas, 500, 280, { shiftKey: true });
    click(canvas, 500, 280, { shiftKey: true });
    click(canvas, 500, 280, { shiftKey: true });
    fire(canvas, 'dblclick', 500, 280, { shiftKey: true });
    assert.equal(s().measurements.length, 1);
    assert.equal(s().activeMeasurement, null, 'the second press of a Shift double-click set a start');
  });

  it('Esc while the first press is held leaves nothing to finish on release', () => {
    const { canvas } = mount();
    fire(canvas, 'pointerdown', 200, 300);
    act(() => s().cancelMeasurement());
    hover(canvas, 500, 300);
    fire(canvas, 'pointerup', 500, 300);
    assert.equal(s().measurements.length, 0);
    assert.equal(s().activeMeasurement, null);
  });
});

/**
 * A corner at world (2,0,0) on an edge running along +x. A pick within 10px of
 * it snaps there and locks the edge; while the edge is locked, any pick within
 * the corner's pull (360px here) snaps back onto the corner, as the renderer's
 * maintainEdgeLock does for a lock that was never moved by hover.
 */
function magneticCorner(x: number, y: number, lock: { edge: unknown }) {
  const corner = { x: 2, y: 0, z: 0 };
  const locked = {
    edge: { v0: corner, v1: { x: 9, y: 0, z: 0 } }, meshExpressId: 1, edgeT: 0,
    shouldLock: true, shouldRelease: false, isCorner: true, cornerValence: 2,
  };
  const released = { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 };
  if ((lock.edge && Math.abs(x - 200) < 360) || Math.hypot(x - 200, y - 300) < 10) {
    return { intersection: { point: corner }, snapTarget: null, edgeLock: locked };
  }
  return { intersection: { point: { x: x / 100, y: (300 - y) / 100, z: 0 } }, snapTarget: null, edgeLock: released };
}

describe('a start never inherits the edge lock of its own pick (#8771)', () => {
  const mountMagnetic = () => {
    const rig = mountMouseControls(storeBound);
    Object.assign(rig.params.rendererRef.current!, { raycastSceneMagnetic: magneticCorner });
    return rig;
  };

  it('a second tap away from a locked corner start measures to where it was tapped', () => {
    const { canvas, params } = mountMagnetic();
    const ctx = {
      ...params, canvas, renderer: params.rendererRef.current, camera: params.rendererRef.current!.getCamera(),
      mouseState: params.mouseStateRef.current,
    } as unknown as MouseHandlerContext;
    act(() => handleMeasureTap(ctx, 202, 300));
    assert.ok(s().activeMeasurement && near(s().activeMeasurement!.start.x, 2), 'the first tap snaps to the corner');
    act(() => handleMeasureTap(ctx, 500, 300));
    assert.equal(s().measurements.length, 1, 'BUG: the start\'s own edge lock pulled the second tap back onto it');
    assert.ok(near(s().measurements[0].distance, 3), `distance ${s().measurements[0].distance}, expected 3`);
  });

  it('a rejected retap on the start leaves no lock to pull the next tap back', () => {
    const { canvas, params } = mountMagnetic();
    const ctx = {
      ...params, canvas, renderer: params.rendererRef.current, camera: params.rendererRef.current!.getCamera(),
      mouseState: params.mouseStateRef.current,
    } as unknown as MouseHandlerContext;
    act(() => handleMeasureTap(ctx, 202, 300));
    act(() => handleMeasureTap(ctx, 201, 300));
    assert.equal(s().measurements.length, 0, 'a retap on the start is no 0 m measurement');
    act(() => handleMeasureTap(ctx, 500, 300));
    assert.equal(s().measurements.length, 1, 'BUG: the rejected retap\'s edge lock pulled the next tap back onto the start');
    assert.ok(near(s().measurements[0].distance, 3), `distance ${s().measurements[0].distance}, expected 3`);
  });

  it('a second click with no hover in between measures to where it was clicked', () => {
    const { canvas } = mountMagnetic();
    click(canvas, 202, 300);
    assert.ok(s().activeMeasurement && near(s().activeMeasurement!.start.x, 2), 'the first click snaps to the corner');
    click(canvas, 500, 300);
    assert.equal(s().measurements.length, 1, 'BUG: the start\'s own edge lock pulled the second click back onto it');
    assert.ok(near(s().measurements[0].distance, 3), `distance ${s().measurements[0].distance}, expected 3`);
  });
});

/**
 * The mobile journey's case (#8788): a vertex snap with a 60px pull and no edge
 * lock. Both points sit near the corner at world (2,0,0), so a second tap or
 * click 38px from the first snaps onto the start too.
 */
function snapToCorner(x: number, y: number) {
  const edgeLock = { shouldRelease: false, shouldLock: false, edge: null };
  if (Math.hypot(x - 200, y - 300) < 60) return { intersection: { point: { x: 2, y: 0, z: 0 } }, snapTarget: null, edgeLock };
  return { intersection: { point: { x: x / 100, y: (300 - y) / 100, z: 0 } }, snapTarget: null, edgeLock };
}
/** The exact surface hit under the pointer: canvas x/100, (300 - y)/100. */
const exactSurface = (x: number, y: number) => ({ intersection: { point: { x: x / 100, y: (300 - y) / 100, z: 0 } } });

describe('a snap never swallows a second point placed away from the start (#8788)', () => {
  const mountSnapping = () => {
    const rig = mountMouseControls(storeBound);
    Object.assign(rig.params.rendererRef.current!, { raycastSceneMagnetic: snapToCorner, raycastScene: exactSurface });
    return rig;
  };
  const ctxOf = (params: UseMouseControlsParams, canvas: HTMLCanvasElement) => ({
    ...params, canvas, renderer: params.rendererRef.current, camera: params.rendererRef.current!.getCamera(),
    mouseState: params.mouseStateRef.current,
  }) as unknown as MouseHandlerContext;

  it('a second tap 38px away that snaps onto the start measures to the surface it was tapped on', () => {
    const { canvas, params } = mountSnapping();
    const ctx = ctxOf(params, canvas);
    act(() => handleMeasureTap(ctx, 202, 300));
    assert.ok(s().activeMeasurement && near(s().activeMeasurement!.start.x, 2), 'the first tap snaps to the corner');
    act(() => handleMeasureTap(ctx, 240, 300));
    assert.equal(s().measurements.length, 1, 'BUG: the snap pulled the second tap onto the start and it was dropped');
    assert.ok(near(s().measurements[0].distance, 0.4), `distance ${s().measurements[0].distance}, expected 0.4`);
  });

  it('a second click with no hover that snaps onto the start measures to the surface it was clicked on', () => {
    const { canvas } = mountSnapping();
    click(canvas, 202, 300);
    click(canvas, 240, 300);
    assert.equal(s().measurements.length, 1, 'BUG: the snap pulled the second click onto the start and it was dropped');
    assert.ok(near(s().measurements[0].distance, 0.4), `distance ${s().measurements[0].distance}, expected 0.4`);
  });

  it('a retap on the start itself is still no 0 m measurement', () => {
    const { canvas, params } = mountSnapping();
    const ctx = ctxOf(params, canvas);
    act(() => handleMeasureTap(ctx, 202, 300));
    act(() => handleMeasureTap(ctx, 200, 300));
    assert.equal(s().measurements.length, 0, 'a tap on the start finished a 0 m measurement');
    assert.ok(s().activeMeasurement, 'the start stays pending');
  });
});

describe('one distance path for mouse and touch (#8771, #5856)', () => {
  const ctxFrom = (params: UseMouseControlsParams, canvas: HTMLCanvasElement) => ({
    ...params, canvas, renderer: params.rendererRef.current, camera: params.rendererRef.current!.getCamera(),
    mouseState: params.mouseStateRef.current,
  }) as unknown as MouseHandlerContext;

  it('a tap start is finished by a mouse click, and vice versa', () => {
    const { canvas, params } = mount();
    const ctx = ctxFrom(params, canvas);
    act(() => handleMeasureTap(ctx, 200, 300));
    assert.ok(s().activeMeasurement, 'a tap sets the same pending start a click does');
    click(canvas, 500, 300);
    assert.equal(s().measurements.length, 1);
    click(canvas, 100, 300);
    act(() => handleMeasureTap(ctx, 400, 300));
    assert.equal(s().measurements.length, 2);
    assert.ok(near(s().measurements[1].distance, 3));
  });

  it('a double-tap on the start does not finish a zero-length measurement', () => {
    const { canvas, params } = mount();
    const ctx = ctxFrom(params, canvas);
    act(() => handleMeasureTap(ctx, 200, 300));
    act(() => handleMeasureTap(ctx, 200, 300));
    assert.equal(s().measurements.length, 0, 'the second tap finished a 0 m measurement');
    act(() => handleMeasureTap(ctx, 500, 300));
    assert.equal(s().measurements.length, 1);
    assert.ok(near(s().measurements[0].distance, 3));
  });

  it('a tap start is cancelled by Esc and by leaving the tool, like a click start', async () => {
    const { canvas, params } = mount();
    const ctx = ctxFrom(params, canvas);
    act(() => handleMeasureTap(ctx, 200, 300));
    act(() => { s().setActiveTool('select'); s().setActiveTool('measure'); });
    act(() => handleMeasureTap(ctx, 500, 300));
    assert.equal(s().measurements.length, 0, 'BUG: a tap start survived leaving Measure and finished across it');

    function Keys(): null { useKeyboardShortcuts(); return null; }
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<Keys />); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    assert.equal(s().activeMeasurement, null, 'Esc did not cancel the pending start');
    assert.equal(s().activeTool, 'measure', 'the first Esc cancels the start and keeps the tool');
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
