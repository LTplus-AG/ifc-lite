/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measure Point mode (#8770): one click gives Model XYZ without a distance
 * gesture. Driven through the functions a canvas click, a hover frame, a
 * touch tap and Esc actually call, and read back as the text a user sees on
 * the HUD and in the Measurements panel's Point tab.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { SnapType } from '@ifc-lite/renderer';
import { cleanup, click, press, render, waitFor } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { cleanupMouseControls, mountMouseControls, mousePointer } from '@/test/mouse-controls-fixture';
import type { MeasurePoint } from '@/store/types.js';
import { hasPendingMeasurementState } from '@/utils/viewportUtils.js';
import { staleMeasurementIds } from '@/lib/model-placement/spatial-invalidation';
import { measureRu } from '@/i18n/locales/ru/measure';
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts.js';
import { useVisibilityState } from '@/hooks/useViewerSelectors.js';
import { handleMeasureClickAt } from './selectionHandlers.js';
import { handleMeasureTap } from './touchRouting.js';
import { handleMeasureHover, syncMeasureScreenCoords } from './measureHandlers.js';
import { endMeasurePointHover, hoverMeasurePoint, hoverMeasurePointAt } from './measurePointMode.js';
import { measureCanvasBoxWatch } from './measureCameraState.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud.js';
import { MeasureOverlay } from './tools/MeasurePanel.js';
import { MeasurementsPanel } from './MeasurementsPanel.js';

type Hit = { x: number; y: number; z: number } | null;
type SnapOpts = { snapToVertices: boolean; snapToEdges: boolean; snapToFaces: boolean };

/** A canvas context whose raycast lands on `hit.current` (null = empty space). */
function fakeCtx(hit: { current: Hit }, snapEnabled = true) {
  const snapTargets: Array<unknown> = [];
  /** Per raycast: was an edge lock passed in, and which snap options? */
  const locks: boolean[] = [];
  const snapOptions: SnapOpts[] = [];
  /** The camera pose; a test moves the camera by editing it. */
  const pose = {
    position: { x: 0, y: 0, z: 10 }, rotation: { azimuth: 0, elevation: 0 }, distance: 10,
    projectionMode: 'perspective' as 'perspective' | 'orthographic', orthoSize: 10,
    fov: 45, up: { x: 0, y: 1, z: 0 },
  };
  /** The renderer's pick-clip revision; a test redraws a new cut by bumping it. */
  const clip = { revision: 0 };
  const ctx = {
    canvas: document.createElement('canvas'),
    camera: {
      projectToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }),
      getPosition: () => ({ ...pose.position }),
      getRotation: () => ({ ...pose.rotation }),
      getDistance: () => pose.distance,
      getProjectionMode: () => pose.projectionMode,
      getOrthoSize: () => pose.orthoSize,
      getFOV: () => pose.fov,
      getUp: () => ({ ...pose.up }),
    },
    renderer: {
      getPickClipRevision: () => clip.revision,
      raycastSceneMagnetic: (_x: number, _y: number, lock: { edge: unknown }, opts: { snapOptions: SnapOpts }) => (
        locks.push(lock.edge !== null), snapOptions.push(opts.snapOptions), {
        intersection: hit.current ? { point: hit.current } : null,
        snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
      }),
    } as Record<string, unknown>,
    mouseState: { isDragging: false, didDrag: false },
    activeToolRef: { current: 'measure' },
    snapEnabledRef: { current: snapEnabled },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    hiddenEntitiesRef: { current: new Set() },
    isolatedEntitiesRef: { current: null },
    lastHoverSnapTimeRef: { current: 0 },
    HOVER_SNAP_THROTTLE_MS: 0,
    measureRaycastPendingRef: { current: false },
    measureRaycastFrameRef: { current: null as number | null },
    lastCameraStateRef: { current: null },
    // The real store action, as Viewport passes it in.
    updateMeasurementScreenCoords: (...args: Parameters<ReturnType<typeof useViewerStore.getState>['updateMeasurementScreenCoords']>) =>
      useViewerStore.getState().updateMeasurementScreenCoords(...args),
    setSnapTarget: (t: unknown) => { snapTargets.push(t); },
    // Like the store action: the ref only catches up on the next render.
    clearEdgeLock: () => {},
    setSnapVisualization: () => {},
  } as unknown as MouseHandlerContext;
  return { ctx, snapTargets, locks, snapOptions, pose, clip };
}

const ON_WALL = { x: 3, y: 4, z: -5 };
const ELSEWHERE = { x: 7, y: 1, z: -2 };
const mp = (p: { x: number; y: number; z: number }): MeasurePoint & { id: string } => ({ ...p, screenX: p.x, screenY: p.y, id: `p-${p.x}` });

const RESET = {
  activeTool: 'measure',
  measureMode: 'point' as const,
  measurements: [],
  activeMeasurement: null,
  activePolyline: null,
  polylineMeasurements: [],
  activeAngle: null,
  angleMeasurements: [],
  activeRadius: null,
  radiusMeasurements: [],
  measurePointLive: null,
  measurePointLast: null,
  measureReferencePoint: null,
  snapEnabled: true,
  geoReadoutEnabled: false,
};

let initialState: ReturnType<typeof useViewerStore.getState>;
beforeEach(() => {
  initialState = useViewerStore.getState();
  useViewerStore.setState(RESET);
});
afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

const xyz = (p: { x: number; y: number; z: number } | null) => (p ? [p.x, p.y, p.z] : null);

describe('Point mode click (#8770)', () => {
  it('one click places a point and records no distance', () => {
    const { ctx } = fakeCtx({ current: ON_WALL });
    handleMeasureClickAt(ctx, 3, 4);
    const s = useViewerStore.getState();
    assert.deepEqual(xyz(s.measurePointLast), [3, 4, -5]);
    assert.equal(s.measurements.length, 0);
    assert.equal(s.activeMeasurement, null);
    assert.equal(s.activePolyline, null);
  });

  it('a click on empty space places nothing, and keeps a point already placed', () => {
    const hit = { current: null as Hit };
    const { ctx } = fakeCtx(hit);
    handleMeasureClickAt(ctx, 50, 50);
    assert.equal(useViewerStore.getState().measurePointLast, null);
    hit.current = ON_WALL;
    handleMeasureClickAt(ctx, 3, 4);
    hit.current = null;
    handleMeasureClickAt(ctx, 50, 50);
    assert.deepEqual(xyz(useViewerStore.getState().measurePointLast), [3, 4, -5]);
  });

  it('a second click replaces the point rather than accumulating one', () => {
    const hit = { current: ON_WALL as Hit };
    const { ctx } = fakeCtx(hit);
    handleMeasureClickAt(ctx, 3, 4);
    hit.current = ELSEWHERE;
    handleMeasureClickAt(ctx, 7, 1);
    assert.deepEqual(xyz(useViewerStore.getState().measurePointLast), [7, 1, -2]);
    assert.equal(useViewerStore.getState().measurements.length, 0);
  });

  it('places the point with Snap off too (unsnapped surface hit)', () => {
    const { ctx, snapOptions } = fakeCtx({ current: ON_WALL }, false);
    handleMeasureClickAt(ctx, 3, 4);
    assert.deepEqual(xyz(useViewerStore.getState().measurePointLast), [3, 4, -5]);
    assert.deepEqual(snapOptions.map((o) => [o.snapToVertices, o.snapToEdges, o.snapToFaces]), [[false, false, false]]);
  });

  it('one touch tap places the point, without starting a two-tap distance', () => {
    const { ctx } = fakeCtx({ current: ON_WALL });
    handleMeasureTap(ctx, 3, 4);
    const s = useViewerStore.getState();
    assert.deepEqual(xyz(s.measurePointLast), [3, 4, -5]);
    assert.equal(s.activeMeasurement, null);
    assert.equal(s.measurements.length, 0);
  });

  it('a click in Polyline mode does not touch point state', () => {
    useViewerStore.setState({ measureMode: 'polyline' });
    const { ctx } = fakeCtx({ current: ON_WALL });
    handleMeasureClickAt(ctx, 3, 4);
    assert.equal(useViewerStore.getState().measurePointLast, null);
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1);
  });
});

describe('Point mode hover (#8770)', () => {
  it('a hover frame previews the point a click there would place; a miss clears it', () => {
    const hit = { current: ON_WALL as Hit };
    const { ctx } = fakeCtx(hit);
    hoverMeasurePoint(ctx, 3, 4);
    assert.deepEqual(xyz(useViewerStore.getState().measurePointLive), [3, 4, -5]);
    handleMeasureClickAt(ctx, 3, 4);
    assert.deepEqual(xyz(useViewerStore.getState().measurePointLast), [3, 4, -5]);
    hit.current = null;
    hoverMeasurePoint(ctx, 50, 50);
    assert.equal(useViewerStore.getState().measurePointLive, null);
    assert.deepEqual(xyz(useViewerStore.getState().measurePointLast), [3, 4, -5], 'a miss hover keeps the placed point');
  });

  it('runs on the shared hover frame, and a frame that lands after a mode switch leaks nothing', () => {
    const frames: FrameRequestCallback[] = [];
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { frames.push(cb); return frames.length; }) as typeof requestAnimationFrame;
    try {
      const { ctx } = fakeCtx({ current: ON_WALL });
      assert.equal(handleMeasureHover(ctx, 3, 4, hoverMeasurePoint), true);
      assert.equal(frames.length, 1);
      act(() => useViewerStore.getState().setMeasureMode('drag'));
      frames[0](0);
      assert.equal(useViewerStore.getState().measurePointLive, null, 'a stale point-mode frame wrote into Distance mode');
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
  });

  it('a frame that lands after the tool closed writes no live point and no snap target', () => {
    const frames: FrameRequestCallback[] = [];
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { frames.push(cb); return frames.length; }) as typeof requestAnimationFrame;
    try {
      const { ctx, snapTargets } = fakeCtx({ current: ON_WALL });
      handleMeasureHover(ctx, 3, 4, hoverMeasurePoint);
      act(() => useViewerStore.getState().setActiveTool('select'));
      frames[0](0);
      assert.equal(useViewerStore.getState().measurePointLive, null);
      assert.equal(snapTargets.length, 0);
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
  });

  it('an edge lock left by another mode does not bend a Point hover or click', () => {
    const { ctx, locks } = fakeCtx({ current: ON_WALL });
    const stale = { edge: { v0: { x: 0, y: 0, z: 0 }, v1: { x: 1, y: 0, z: 0 } }, meshExpressId: 7, edgeT: 0.5, lockStrength: 1, isCorner: false, cornerValence: 0 };
    ctx.edgeLockStateRef.current = stale as typeof ctx.edgeLockStateRef.current;
    hoverMeasurePoint(ctx, 3, 4);
    handleMeasureClickAt(ctx, 3, 4);
    assert.deepEqual(locks, [false, false]);
    assert.equal(ctx.edgeLockStateRef.current.meshExpressId, 7, 'the pick bypasses the lock without writing the store');
  });

  it('the mounted canvas previews on hover with Snap off, and mouseleave drops the preview', () => {
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1; }) as typeof requestAnimationFrame;
    try {
      const ui = mountMouseControls({ activeToolRef: { current: 'measure' }, snapEnabledRef: { current: false } });
      const renderer = ui.params.rendererRef.current as unknown as Record<string, unknown>;
      renderer.raycastSceneMagnetic = () => ({
        intersection: { point: ON_WALL }, snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
      });
      act(() => { ui.canvas.dispatchEvent(mousePointer('pointermove', 0, 30, 40, { buttons: 0 })); });
      assert.deepEqual(xyz(useViewerStore.getState().measurePointLive), [3, 4, -5]);
      act(() => { ui.canvas.dispatchEvent(new MouseEvent('mouseleave')); });
      assert.equal(useViewerStore.getState().measurePointLive, null);
    } finally {
      globalThis.requestAnimationFrame = raf;
      cleanupMouseControls();
    }
  });

  it('a cursor that rests inside the hover throttle still gets its own Live reading', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1; }) as typeof requestAnimationFrame;
    try {
      const hit = { current: ON_WALL as Hit };
      const { ctx } = fakeCtx(hit);
      (ctx as { HOVER_SNAP_THROTTLE_MS: number }).HOVER_SNAP_THROTTLE_MS = 100;
      hoverMeasurePointAt(ctx, 3, 4);
      assert.deepEqual(xyz(useViewerStore.getState().measurePointLive), [3, 4, -5]);
      t.mock.timers.tick(10);
      hit.current = ELSEWHERE;
      hoverMeasurePointAt(ctx, 7, 1);
      assert.deepEqual(xyz(useViewerStore.getState().measurePointLive), [3, 4, -5], 'throttled: no pick yet');
      t.mock.timers.tick(90);
      assert.deepEqual(xyz(useViewerStore.getState().measurePointLive), [7, 1, -2], 'the resting position was never read');

      // Leaving the canvas cancels a pending trailing pick.
      hit.current = ON_WALL;
      t.mock.timers.tick(10);
      hoverMeasurePointAt(ctx, 3, 4);
      endMeasurePointHover(ctx);
      t.mock.timers.tick(200);
      assert.equal(useViewerStore.getState().measurePointLive, null);
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
  });

  it('a click or a held press supersedes a pending trailing pick', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1; }) as typeof requestAnimationFrame;
    try {
      const { ctx, locks } = fakeCtx({ current: ON_WALL });
      (ctx as { HOVER_SNAP_THROTTLE_MS: number }).HOVER_SNAP_THROTTLE_MS = 100;
      hoverMeasurePointAt(ctx, 3, 4);
      t.mock.timers.tick(10);
      hoverMeasurePointAt(ctx, 3, 4);
      handleMeasureClickAt(ctx, 3, 4);
      t.mock.timers.tick(200);
      const s = useViewerStore.getState();
      assert.equal(s.measurePointLive, null, 'the readout flipped back to Live after the click');
      assert.ok(s.measurePointLast !== null);

      hoverMeasurePointAt(ctx, 3, 4); // opens a new throttle window
      const picks = locks.length;
      t.mock.timers.tick(10);
      hoverMeasurePointAt(ctx, 3, 4); // throttled: queues a trailing pick
      ctx.mouseState.isDragging = true;
      t.mock.timers.tick(200);
      assert.equal(locks.length, picks, 'a trailing pick raycast during an orbit press');
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
  });

  it('unmounting the canvas drops the preview and cancels a pending trailing pick', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1; }) as typeof requestAnimationFrame;
    try {
      const ui = mountMouseControls({ activeToolRef: { current: 'measure' }, HOVER_SNAP_THROTTLE_MS: 100 });
      let raycasts = 0;
      (ui.params.rendererRef.current as unknown as Record<string, unknown>).raycastSceneMagnetic = () => (raycasts++, {
        intersection: { point: ON_WALL }, snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
      });
      act(() => { ui.canvas.dispatchEvent(mousePointer('pointermove', 0, 30, 40, { buttons: 0 })); });
      t.mock.timers.tick(10);
      act(() => { ui.canvas.dispatchEvent(mousePointer('pointermove', 0, 31, 40, { buttons: 0 })); });
      assert.equal(raycasts, 1);
      assert.ok(useViewerStore.getState().measurePointLive !== null);
      cleanupMouseControls();
      assert.equal(useViewerStore.getState().measurePointLive, null, 'unmount left a Live point behind');
      t.mock.timers.tick(200);
      assert.equal(raycasts, 1, 'a trailing pick ran after unmount');
      assert.equal(useViewerStore.getState().measurePointLive, null);
    } finally {
      globalThis.requestAnimationFrame = raf;
      cleanupMouseControls();
    }
  });

  it('leaving the canvas drops a queued hover frame and the preview', () => {
    const cancelled: number[] = [];
    const caf = globalThis.cancelAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => { cancelled.push(id); }) as typeof cancelAnimationFrame;
    try {
      const { ctx } = fakeCtx({ current: ON_WALL });
      hoverMeasurePoint(ctx, 3, 4);
      ctx.measureRaycastFrameRef.current = 42;
      ctx.measureRaycastPendingRef.current = true;
      endMeasurePointHover(ctx);
      assert.deepEqual(cancelled, [42]);
      assert.equal(ctx.measureRaycastPendingRef.current, false);
      assert.equal(useViewerStore.getState().measurePointLive, null);
    } finally {
      globalThis.cancelAnimationFrame = caf;
    }
  });
});

describe('Point state never leaks into the other modes (#8770)', () => {
  beforeEach(() => {
    useViewerStore.setState({ measurePointLive: mp(ELSEWHERE), measurePointLast: mp(ON_WALL) });
  });

  for (const mode of ['drag', 'polyline', 'angle', 'radius'] as const) {
    it(`switching to ${mode} clears the live and the last point`, () => {
      useViewerStore.getState().setMeasureMode(mode);
      const s = useViewerStore.getState();
      assert.equal(s.measurePointLive, null);
      assert.equal(s.measurePointLast, null);
    });
  }

  it('the setters refuse a point outside Point mode', () => {
    useViewerStore.getState().setMeasureMode('drag');
    useViewerStore.getState().placeMeasurePoint(mp(ON_WALL));
    useViewerStore.getState().setMeasurePointLive(mp(ON_WALL));
    assert.equal(useViewerStore.getState().measurePointLast, null);
    assert.equal(useViewerStore.getState().measurePointLive, null);
  });

  it('leaving the tool drops the preview but keeps the placed point readable', () => {
    useViewerStore.getState().setActiveTool('select');
    assert.equal(useViewerStore.getState().measurePointLive, null);
    assert.deepEqual(xyz(useViewerStore.getState().measurePointLast), [3, 4, -5]);
  });

  it('Clear all and a new model both drop it', () => {
    useViewerStore.getState().clearMeasurements();
    assert.equal(useViewerStore.getState().measurePointLast, null);
    useViewerStore.setState({ measurePointLast: mp(ON_WALL) });
    useViewerStore.getState().resetAllMeasurementState();
    assert.equal(useViewerStore.getState().measurePointLast, null);
  });

  it('the placed point is reprojected on camera moves, so its marker orbits with the model', () => {
    useViewerStore.setState({ measurePointLive: null });
    assert.equal(hasPendingMeasurementState(useViewerStore.getState()), true);
    useViewerStore.getState().updateMeasurementScreenCoords((p) => ({ x: p.x * 10, y: p.y * 10 }));
    const last = useViewerStore.getState().measurePointLast;
    assert.deepEqual([last?.screenX, last?.screenY], [30, 40]);
  });
});

function KeyboardHarness() {
  useKeyboardShortcuts();
  return null;
}

describe('Esc in Point mode (#8770)', () => {
  it('clears the placed point and the preview', () => {
    useViewerStore.setState({ measurePointLive: mp(ELSEWHERE), measurePointLast: mp(ON_WALL) });
    render(<KeyboardHarness />);
    press(window, 'Escape');
    const s = useViewerStore.getState();
    assert.equal(s.measurePointLast, null);
    assert.equal(s.measurePointLive, null);
    assert.equal(s.activeTool, 'measure', 'the first Esc clears the point, it does not leave the tool');
  });
});

/** The label cell of the coordinate row whose label reads exactly `label`, or null. */
function coordRow(container: Element, label: string): string | null {
  const row = [...container.querySelectorAll('div')].find(
    (d) => d.querySelector(':scope > span')?.textContent?.trim() === label,
  );
  return row ? (row.querySelectorAll(':scope > span')[1]?.textContent ?? '') : null;
}

function openPointTab(container: HTMLElement): void {
  const tab = [...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.trim() === 'Point');
  assert.ok(tab !== undefined, 'no Point tab');
  if (!tab) return;
  act(() => { tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); });
}

const hudRegion = () => document.querySelector('[data-hud-region="bottom-center"]')?.textContent ?? '';

describe('Point mode readouts (#8770)', () => {
  it('a click yields a Model XYZ readout on the HUD and in the Point tab without any distance', () => {
    const container = render(<><ViewportHud /><MeasureOverlay /><MeasurementsPanel /></>);
    openPointTab(container);
    assert.match(container.textContent ?? '', /Measure a point to read its coordinates/);
    assert.match(hudRegion(), /Click a point to read its coordinates/);

    const { ctx } = fakeCtx({ current: ON_WALL });
    act(() => handleMeasureClickAt(ctx, 3, 4));
    assert.equal(useViewerStore.getState().measurements.length, 0);
    // Renderer Y-up (3, 4, -5) is IFC Z-up (3, 5, 4).
    assert.equal(coordRow(container, 'Model'), 'X 3.000  Y 5.000  Z 4.000');
    assert.match(container.textContent ?? '', /Last point/);
    assert.match(hudRegion(), /Last\s*Model\s*X 3\.000 {2}Y 5\.000 {2}Z 4\.000/);
    assert.match(hudRegion(), /Click another point · Esc to clear/);

    act(() => hoverMeasurePoint(ctx, 3, 4));
    assert.match(container.textContent ?? '', /Live point/);
    assert.match(hudRegion(), /Live\s*Model/);
  });

  it('a distance endpoint is not presented as a picked point in Point mode', () => {
    useViewerStore.setState({ measurements: [{ id: 'm', start: mp(ELSEWHERE), end: mp(ELSEWHERE), distance: 0 }] });
    const container = render(<><ViewportHud /><MeasureOverlay /><MeasurementsPanel /></>);
    openPointTab(container);
    assert.equal(coordRow(container, 'Model'), null);
    assert.equal(container.querySelector('[data-testid="measure-point-hud"]') === null, true);
  });

  it('switching to Point drops a Distance tap start, so the marker sits on the placed point only', () => {
    useViewerStore.setState({ measureMode: 'drag' });
    useViewerStore.getState().startMeasurement({ x: 0, y: 0, z: 0, screenX: 11, screenY: 12 });
    render(<><ViewportHud /><MeasureOverlay /></>);
    assert.ok([...document.querySelectorAll('circle')].some((c) => c.getAttribute('cx') === '11'), 'the Distance start is not drawn before the switch');
    act(() => useViewerStore.getState().setMeasureMode('point'));
    assert.equal(useViewerStore.getState().activeMeasurement, null, 'the Distance start survived the switch to Point');
    const { ctx } = fakeCtx({ current: ON_WALL });
    act(() => handleMeasureClickAt(ctx, 3, 4));
    const marks = [...document.querySelectorAll('circle')].map((c) => `${c.getAttribute('cx')},${c.getAttribute('cy')}`);
    assert.ok(marks.includes('3,4'), `no mark at the placed point: ${marks.join(' ')}`);
    assert.ok(!marks.includes('11,12'), 'the stale Distance tap start is drawn in Point mode');
  });

  it('the HUD line is Point-mode only, and switching mode removes it', () => {
    useViewerStore.setState({ measurePointLast: mp(ON_WALL) });
    render(<><ViewportHud /><MeasureOverlay /></>);
    assert.ok(document.querySelector('[data-testid="measure-point-hud"]') !== null);
    act(() => useViewerStore.getState().setMeasureMode('drag'));
    assert.equal(document.querySelector('[data-testid="measure-point-hud"]') === null, true);
    assert.match(hudRegion(), /Click to set the start point/);
  });

  it('keeps the frame stack: Datum and Relative once a reference is set', () => {
    useViewerStore.setState({ measurePointLast: mp(ON_WALL), measureReferencePoint: { x: 1, y: 1, z: -1 } });
    const container = render(<MeasurementsPanel />);
    openPointTab(container);
    assert.equal(coordRow(container, 'Model'), 'X 3.000  Y 5.000  Z 4.000');
    assert.equal(coordRow(container, 'Datum'), 'X 1.000  Y 1.000  Z 1.000');
    assert.ok(coordRow(container, 'Relative'));
    assert.equal(coordRow(container, 'Render'), null, 'no Render row for an unshifted model');
  });
});

describe('Point mode Geo XYZ stack (#8770)', () => {
  const crs: ProjectedCRS = { id: 3, name: 'EPSG:2056', mapUnitScale: 1 };
  const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3,
    eastings: 2600000, northings: 1200000, orthogonalHeight: 400,
    xAxisAbscissa: 1, xAxisOrdinate: 0, factorX: 1, factorY: 1, factorZ: 1 };

  beforeEach(() => {
    const model = fixtureModel('geo');
    assert.ok(model.ifcDataStore);
    model.ifcDataStore.georeferencing = { hasGeoreference: true, projectedCRS: crs, mapConversion: conversion };
    model.ifcDataStore.lengthUnitScale = 1;
    useViewerStore.setState({ ...fixtureModels(model), georefMutations: new Map(), anchorModelIdOverride: null });
    useViewerStore.setState({ measurePointLast: mp(ON_WALL) });
  });

  it('Geo XYZ off: Model only, no Map row and no E/N/H on the HUD', async () => {
    const container = render(<><ViewportHud /><MeasureOverlay /><MeasurementsPanel /></>);
    openPointTab(container);
    assert.ok(coordRow(container, 'Model'));
    // The georef resolves asynchronously: prove it is usable (Geo on would
    // show the row) before concluding Geo off hides it.
    act(() => useViewerStore.setState({ geoReadoutEnabled: true }));
    await waitFor(() => Boolean(coordRow(container, 'Map')), 'Map row with Geo XYZ on');
    act(() => useViewerStore.setState({ geoReadoutEnabled: false }));
    assert.equal(coordRow(container, 'Map'), null);
    assert.equal(document.querySelector('[data-testid="measure-geo-readout"]') === null, true);
  });

  it('Geo XYZ on with a usable georef: Map row in the Point tab and E/N/H on the HUD for the placed point', async () => {
    useViewerStore.setState({ geoReadoutEnabled: true });
    const container = render(<><ViewportHud /><MeasureOverlay /><MeasurementsPanel /></>);
    openPointTab(container);
    await waitFor(() => Boolean(coordRow(container, 'Map')), 'Map row with Geo XYZ on');
    assert.ok(coordRow(container, 'Model'));
    assert.match(coordRow(container, 'Map') ?? '', /E \d+\.\d{3} {2}N \d+\.\d{3} {2}H -?\d+\.\d{3}/);
    const geo = document.querySelector('[data-testid="measure-geo-readout"]')?.textContent ?? '';
    assert.match(geo, /Last/);
    assert.match(geo, /E \d+\.\d{3}/);
  });
});

describe('Point on the Measure mode strip (#8770)', () => {
  const selectedTab = () =>
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null;

  it('choosing Point brings an open Measurements panel to its Point tab', () => {
    useViewerStore.setState({ measureMode: 'drag' });
    render(<MeasurementsPanel />);
    assert.equal(selectedTab(), 'List');
    act(() => useViewerStore.getState().setMeasureMode('point'));
    assert.equal(selectedTab(), 'Point');
    assert.match(document.body.textContent ?? '', /Measure a point to read its coordinates/);
  });

  it('a panel opened while in Point mode starts on the Point tab', () => {
    render(<MeasurementsPanel />);
    assert.equal(selectedTab(), 'Point');
  });

  it('with the Measure tool closed, a remembered Point mode does not pick the tab', () => {
    useViewerStore.setState({ activeTool: 'select' });
    render(<MeasurementsPanel />);
    assert.equal(selectedTab(), 'List');
  });

  it('sits after Radius with a tooltip, and picking it switches mode and hint', () => {
    useViewerStore.setState({ measureMode: 'drag' });
    const container = render(<><ViewportHud /><MeasureOverlay /></>);
    const radios = [...container.querySelectorAll('[aria-label="Measure mode"] [role="radio"]')];
    assert.deepEqual(radios.map((r) => r.textContent?.trim()), ['Distance', 'Polyline', 'Angle', 'Radius', 'Point']);
    const point = radios[4];
    assert.equal(point.getAttribute('title'), 'Click a point to read its X/Y/Z coordinates');
    assert.ok(point.querySelector('svg') !== null, 'Point carries an icon');
    click(point);
    assert.equal(useViewerStore.getState().measureMode, 'point');
    assert.equal(point.getAttribute('aria-checked'), 'true');
    assert.match(hudRegion(), /Click a point to read its coordinates/);
  });
});

/** What the camera pass records about the scene a pick filters by (#8886). */
const sceneOf = (ctx: MouseHandlerContext) => ({
  hidden: ctx.hiddenEntitiesRef.current, isolated: ctx.isolatedEntitiesRef.current, clip: ctx.renderer.getPickClipRevision(),
});
/** A camera pass that last ran for some older camera, over the current scene. */
const olderView = (ctx: MouseHandlerContext) => ({
  position: { x: 9, y: 9, z: 9 }, rotation: { azimuth: 1, elevation: 1 }, distance: 1,
  projectionMode: 'perspective', orthoSize: 1, fov: 1, up: { x: 0, y: 0, z: 1 }, canvasWidth: 1, canvasHeight: 1,
  scene: sceneOf(ctx),
});

describe('Point mode readout staleness (#8828)', () => {
  it('a camera move ends "Live": the reprojection pass drops the hover point and keeps the placed one', () => {
    useViewerStore.setState({ measurePointLive: mp(ELSEWHERE) });
    assert.equal(hasPendingMeasurementState(useViewerStore.getState()), true, 'a lone hover point never reaches the camera pass');
    useViewerStore.getState().placeMeasurePoint(mp(ON_WALL));
    useViewerStore.getState().setMeasurePointLive(mp(ELSEWHERE));
    useViewerStore.setState({ snapTarget: { type: SnapType.VERTEX, position: ELSEWHERE, expressId: 1, confidence: 1 } });
    useViewerStore.getState().updateMeasurementScreenCoords((p) => ({ x: p.x * 10, y: p.y * 10 }));
    const s = useViewerStore.getState();
    assert.equal(s.measurePointLive, null, 'Live outlived a camera move');
    assert.equal(s.snapTarget, null, 'the snap glyph stayed on the hover point the camera move ended');
    assert.deepEqual([s.measurePointLast?.screenX, s.measurePointLast?.screenY], [30, 40]);
  });

  it('a hover brings the camera pass up to the camera it picked under, so the next frame keeps it', () => {
    const { ctx, pose } = fakeCtx({ current: ON_WALL });
    ctx.lastCameraStateRef.current = olderView(ctx);
    hoverMeasurePoint(ctx, 3, 4);
    assert.deepEqual(xyz(useViewerStore.getState().measurePointLive), [3, 4, -5]);
    assert.deepEqual(ctx.lastCameraStateRef.current, {
      ...pose, canvasWidth: ctx.canvas.width, canvasHeight: ctx.canvas.height, scene: sceneOf(ctx),
    }, 'the next animation frame would count the camera as moved and drop the point just picked');
  });

  it('a projection toggle, an orthographic zoom or a viewpoint restore ends "Live"; a pass with the camera unmoved keeps it', () => {
    for (const move of ['projection', 'orthoSize', 'fov', 'up'] as const) {
      const { ctx, pose } = fakeCtx({ current: ON_WALL });
      ctx.canvas.width = 1601;
      ctx.canvas.height = 801;
      const passes: boolean[] = [];
      const update = ctx.updateMeasurementScreenCoords;
      ctx.updateMeasurementScreenCoords = (project, viewMoved) => { passes.push(viewMoved ?? true); update(project, viewMoved); };
      hoverMeasurePoint(ctx, 3, 4);
      passes.length = 0;
      syncMeasureScreenCoords(ctx); // a clamped wheel step: nothing moved
      assert.ok(useViewerStore.getState().measurePointLive !== null, `an unmoved camera ended Live (${move})`);
      // The drawing buffer drops to pixel ratio 1 while the view interacts: no point moves on screen.
      ctx.canvas.width = 800;
      ctx.canvas.height = 400;
      syncMeasureScreenCoords(ctx);
      assert.ok(useViewerStore.getState().measurePointLive !== null, `a drawing-buffer resize ended Live (${move})`);
      assert.deepEqual(passes, [false], 'a drawing-buffer resize must still reproject the markers (the aspect follows it)');
      if (move === 'projection') pose.projectionMode = 'orthographic';
      else if (move === 'orthoSize') pose.orthoSize = 5;
      else if (move === 'fov') pose.fov = 60;
      else pose.up = { x: 0, y: 0, z: 1 };
      syncMeasureScreenCoords(ctx); // the camera pass, as the animation loop and wheel run it
      assert.equal(useViewerStore.getState().measurePointLive, null, `Live outlived a ${move} change`);
    }
  });

  it('a canvas that changes shape under a resting cursor ends "Live"', () => {
    const { ctx } = fakeCtx({ current: ON_WALL });
    ctx.canvas.width = 1600;
    ctx.canvas.height = 800;
    hoverMeasurePoint(ctx, 3, 4);
    ctx.canvas.width = 1200; // a side panel opened
    syncMeasureScreenCoords(ctx);
    assert.equal(useViewerStore.getState().measurePointLive, null, 'Live outlived a canvas reshape');
  });

  it('a collapsed (zero-width) canvas is no view change: no pass, and "Live" is kept', () => {
    const { ctx } = fakeCtx({ current: ON_WALL });
    ctx.canvas.width = 0;
    ctx.canvas.height = 150;
    hoverMeasurePoint(ctx, 3, 4);
    const passes: boolean[] = [];
    const update = ctx.updateMeasurementScreenCoords;
    ctx.updateMeasurementScreenCoords = (project, viewMoved) => { passes.push(viewMoved ?? true); update(project, viewMoved); };
    syncMeasureScreenCoords(ctx);
    assert.deepEqual(passes, [], 'an unchanged zero-width canvas counted as a view change (0/0 aspect)');
    assert.ok(useViewerStore.getState().measurePointLive !== null);
  });

  it('hiding, isolating or a redrawn cut ends "Live" under a resting cursor; an unrelated change keeps it (#8886)', () => {
    const changes: Array<[string, (ctx: MouseHandlerContext, clip: { revision: number }) => void]> = [
      ['hide', (ctx) => { ctx.hiddenEntitiesRef.current = new Set([1]); }],
      ['isolate', (ctx) => { ctx.isolatedEntitiesRef.current = new Set([2]); }],
      ['a section or box cut drawn', (_ctx, clip) => { clip.revision++; }],
    ];
    for (const [name, change] of changes) {
      const { ctx, clip } = fakeCtx({ current: ON_WALL });
      hoverMeasurePoint(ctx, 3, 4);
      useViewerStore.setState({ snapTarget: { type: SnapType.VERTEX, position: ON_WALL, expressId: 1, confidence: 1 }, selectedEntityId: 7 });
      syncMeasureScreenCoords(ctx); // an unrelated store change (a selection) moves nothing under the cursor
      assert.ok(useViewerStore.getState().measurePointLive !== null, `a pass with the scene unchanged ended Live (${name})`);
      change(ctx, clip);
      syncMeasureScreenCoords(ctx); // the pass, as the next animation frame runs it
      const s = useViewerStore.getState();
      assert.equal(s.measurePointLive, null, `Live outlived: ${name}`);
      assert.equal(s.snapTarget, null, `the snap glyph outlived: ${name}`);
      useViewerStore.setState(initialState, true);
      useViewerStore.setState(RESET);
    }
  });

  it('a section change ends "Live" once the renderer draws the cut the pick mirrors, even after a hover in between (#8886)', () => {
    const { ctx, clip } = fakeCtx({ current: ON_WALL });
    hoverMeasurePoint(ctx, 3, 4);
    useViewerStore.setState((s) => ({ sectionPlane: { ...s.sectionPlane, enabled: true, position: s.sectionPlane.position + 10 } }));
    // Before the next render the pick still clips by the old cut: a hover now reads that.
    hoverMeasurePoint(ctx, 3, 4);
    assert.ok(useViewerStore.getState().measurePointLive !== null);
    clip.revision++; // the frame that draws the new cut
    syncMeasureScreenCoords(ctx);
    assert.equal(useViewerStore.getState().measurePointLive, null, 'Live outlived a section change a hover read before the redraw');
  });

  it('hiding a model ends "Live": the effective hidden set the pick reads changes (#8886)', () => {
    const { ctx } = fakeCtx({ current: ON_WALL });
    // A model known by its meshes alone: hiding it hides their ids.
    const model = { ...fixtureModel('m1'), ifcDataStore: undefined, geometryResult: { meshes: [{ expressId: 5 }] } };
    useViewerStore.setState(fixtureModels(model as unknown as ReturnType<typeof fixtureModel>));
    function Probe() {
      // As Viewport does: its refs follow the effective visibility each render.
      const { hiddenEntities, isolatedEntities } = useVisibilityState();
      ctx.hiddenEntitiesRef.current = hiddenEntities;
      ctx.isolatedEntitiesRef.current = isolatedEntities;
      return null;
    }
    render(<Probe />);
    hoverMeasurePoint(ctx, 3, 4);
    // Re-renders that change nothing a pick filters by keep the sets' identity, and Live.
    act(() => { useViewerStore.setState((s) => ({ selectedEntityId: 9, models: new Map(s.models) })); });
    syncMeasureScreenCoords(ctx);
    assert.ok(useViewerStore.getState().measurePointLive !== null, 'an unrelated re-render ended Live');
    act(() => { useViewerStore.getState().setModelVisibility('m1', false); });
    syncMeasureScreenCoords(ctx);
    assert.equal(useViewerStore.getState().measurePointLive, null, 'Live outlived hiding its model');
  });

  it('a resize that keeps the aspect ends "Live"; a pixel-ratio-only box change keeps it (#8886)', () => {
    const { ctx } = fakeCtx({ current: ON_WALL });
    ctx.canvas.width = 1600;
    ctx.canvas.height = 800;
    const noteBox = measureCanvasBoxWatch(ctx.lastCameraStateRef);
    const box = (width: number, height: number) => [{ contentRect: { width, height } }];
    noteBox(box(800, 400)); // the observer's first report
    hoverMeasurePoint(ctx, 3, 4);
    noteBox(box(800, 400)); // the window moved to a display with another pixel ratio: same CSS box
    ctx.canvas.width = 2400; // ...and a 1.5x larger drawing buffer (#9002)
    ctx.canvas.height = 1200;
    syncMeasureScreenCoords(ctx);
    assert.ok(useViewerStore.getState().measurePointLive !== null, 'a pixel-ratio-only change ended Live');
    noteBox(box(804, 402)); // a proportional window resize, aspect unchanged
    ctx.canvas.width = 2412;
    ctx.canvas.height = 1206;
    syncMeasureScreenCoords(ctx);
    assert.equal(useViewerStore.getState().measurePointLive, null, 'Live outlived a proportional resize');
  });

  it('a hover in a frame where the camera moved keeps its own snap glyph (#8886)', () => {
    const { ctx } = fakeCtx({ current: ON_WALL });
    const target = { type: SnapType.VERTEX, position: ON_WALL, expressId: 1, confidence: 1 };
    (ctx.renderer as unknown as Record<string, unknown>).raycastSceneMagnetic = () => ({
      intersection: { point: ON_WALL }, snapTarget: target,
      edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
    });
    ctx.setSnapTarget = (t) => useViewerStore.setState({ snapTarget: t });
    ctx.setSnapVisualization = (v) => useViewerStore.setState({ snapVisualization: v as never });
    useViewerStore.setState({ measurePointLive: mp(ELSEWHERE) });
    ctx.lastCameraStateRef.current = olderView(ctx);
    hoverMeasurePoint(ctx, 3, 4);
    const s = useViewerStore.getState();
    assert.deepEqual(xyz(s.measurePointLive), [3, 4, -5]);
    assert.equal(s.snapTarget?.expressId, 1, 'the camera pass dropped the snap glyph the same hover set');
    assert.ok(s.snapVisualization !== null, 'the camera pass dropped the snap visualization the same hover set');
  });

  it('a wheel zoom on the mounted canvas drops "Live" with no pointer move afterwards', () => {
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 1; }) as typeof requestAnimationFrame;
    try {
      const ui = mountMouseControls({
        activeToolRef: { current: 'measure' },
        hasPendingMeasurements: () => hasPendingMeasurementState(useViewerStore.getState()),
        updateMeasurementScreenCoords: (project, viewMoved) => useViewerStore.getState().updateMeasurementScreenCoords(project, viewMoved),
      });
      (ui.params.rendererRef.current as unknown as Record<string, unknown>).raycastSceneMagnetic = () => ({
        intersection: { point: ON_WALL }, snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
      });
      act(() => { ui.canvas.dispatchEvent(mousePointer('pointermove', 0, 30, 40, { buttons: 0 })); });
      assert.ok(useViewerStore.getState().measurePointLive !== null);
      act(() => { ui.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, clientX: 30, clientY: 40, bubbles: true, cancelable: true })); });
      assert.equal(useViewerStore.getState().measurePointLive, null, 'Live outlived a wheel zoom');
    } finally {
      globalThis.requestAnimationFrame = raf;
      cleanupMouseControls();
    }
  });

  it('a hover frame already queued when the click lands does not flip "Last" back to "Live"', () => {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 0;
    const raf = globalThis.requestAnimationFrame;
    const caf = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { frames.set(++next, cb); return next; }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) => { frames.delete(id); }) as typeof cancelAnimationFrame;
    try {
      const { ctx } = fakeCtx({ current: ON_WALL });
      assert.equal(handleMeasureHover(ctx, 3, 4, hoverMeasurePoint), true);
      assert.equal(frames.size, 1);
      handleMeasureClickAt(ctx, 3, 4);
      for (const frame of [...frames.values()]) frame(0);
      const s = useViewerStore.getState();
      assert.equal(s.measurePointLive, null, 'the late hover frame turned the readout back to Live');
      assert.deepEqual(xyz(s.measurePointLast), [3, 4, -5]);
      assert.equal(ctx.measureRaycastPendingRef.current, false, 'the cancelled frame left the hover throttle shut');
    } finally {
      globalThis.requestAnimationFrame = raf;
      globalThis.cancelAnimationFrame = caf;
    }
  });

  it('a click that misses ends "Live" along with the hover frame it cancelled', () => {
    const hit = { current: ON_WALL as Hit };
    const { ctx, snapTargets } = fakeCtx(hit);
    hoverMeasurePoint(ctx, 3, 4);
    assert.ok(useViewerStore.getState().measurePointLive !== null);
    hit.current = null;
    handleMeasureClickAt(ctx, 50, 50);
    assert.equal(useViewerStore.getState().measurePointLive, null, 'Live named a point no longer under the cursor');
    assert.equal(snapTargets.at(-1), null, 'the snap target of the point no longer under the cursor stayed up');
  });

  it('a model move marks the placed point Stale on the HUD and the Point tab; the next click is current', () => {
    const container = render(<><ViewportHud /><MeasureOverlay /><MeasurementsPanel /></>);
    openPointTab(container);
    const hit = { current: ON_WALL as Hit };
    const { ctx } = fakeCtx(hit);
    act(() => handleMeasureClickAt(ctx, 3, 4));
    assert.doesNotMatch(hudRegion(), /Stale/);
    // What useModelPlacementSync writes when a model moves.
    act(() => useViewerStore.setState({ placementStaleMeasurements: staleMeasurementIds(useViewerStore.getState()) }));
    assert.match(hudRegion(), /Last\s*·\s*Stale\s*Model/);
    assert.match(container.textContent ?? '', /Last point\s*·\s*Stale/);

    act(() => hoverMeasurePoint(ctx, 3, 4));
    assert.doesNotMatch(hudRegion(), /Stale/, 'a live reading is current geometry');

    hit.current = ELSEWHERE;
    act(() => handleMeasureClickAt(ctx, 7, 1));
    assert.match(hudRegion(), /Last\s*Model/);
    assert.doesNotMatch(hudRegion(), /Stale/, 'a point placed after the move is not stale');
    assert.doesNotMatch(container.textContent ?? '', /Stale/);
  });

  it('outside Point mode the last distance endpoint carries its own Stale badge too', () => {
    useViewerStore.setState({ measureMode: 'drag', measurements: [{ id: 'm1', start: mp(ELSEWHERE), end: mp(ON_WALL), distance: 1 }] });
    const container = render(<MeasurementsPanel />);
    openPointTab(container);
    assert.match(container.textContent ?? '', /Last point/);
    assert.doesNotMatch(container.textContent ?? '', /Stale/);
    act(() => useViewerStore.setState({ placementStaleMeasurements: new Set(['m1']) }));
    assert.match(container.textContent ?? '', /Last point\s*·\s*Stale/);
  });

  it('ru: every Live/Last pair agrees in gender with what it labels', () => {
    // HUD point line and geo E/N/H readout: a bare reading, neuter, the pair agreeing.
    assert.equal(measureRu['measure.readout.live'], 'Текущее');
    assert.equal(measureRu['measure.readout.last'], 'Последнее');
    // The Point tab names the point itself ("точка", feminine).
    assert.equal(measureRu['measure.point.live'], 'Текущая точка');
    assert.equal(measureRu['measure.point.last'], 'Последняя точка');
  });
});
