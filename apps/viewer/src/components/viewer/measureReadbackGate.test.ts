/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10880 measure readback over a released scene (#10264). Hover is latest-wins and
 * a cancel drops an in-flight read; an `unavailable` read never raycasts past the
 * unbacked front and clears the preview. A placement (polyline, radius, angle point)
 * reads its own point back first, survives a later press, keeps its order, retries
 * a superseded read, and is dropped only by a gesture reset.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { cancelMeasureRaycast, handleMeasureHover } from './measureHandlers.js';
import { handlePolylineClick } from './selectionHandlers.js';
import { handleMeasureDoubleClick } from './measurementDoubleClick.js';
import { measureReadbacksIdle, runWithReadback, setMeasureReadbackFeedForTest } from './measureReadbackGate.js';
import { setMeasureReadbackGateLoaderForTest } from './measureReadback.js';

type Read = { x: number; y: number; settle: (outcome: string) => void };
let reads: Read[] = [];
let frames: Array<() => void> = [];
const flushFrames = () => { const now = frames; frames = []; for (const frame of now) frame(); };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const released = { isGeometryDataReleased: () => true };
const raycasts: Array<[number, number]> = [];
/** The fake camera's view-projection matrix; an orbit, pan or zoom changes it. */
let view: number[] = [];
/** The renderer's pick-geometry revision; a renderer-side model move bumps it with no store change. */
let pickRevision = 0;
/** The renderer's pick-clip revision; a section cut that changes bumps it. */
let clipRevision = 0;
function ctx(): MouseHandlerContext {
  const renderer = {
    getScene: () => released,
    getCamera: () => ({ getViewProjMatrix: () => ({ m: Float32Array.from(view) }) }),
    getPickGeometryRevision: () => pickRevision,
    getPickClipRevision: () => clipRevision,
    raycastSceneMagnetic: (x: number, y: number) => {
      raycasts.push([x, y]);
      return { intersection: { point: { x, y, z: 0 } }, snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 } };
    },
  };
  return {
    canvas: document.createElement('canvas'), renderer,
    camera: { projectToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }), getPosition: () => ({ x: 0, y: 0, z: 0 }),
      getRotation: () => ({ azimuth: 0, elevation: 0 }), getDistance: () => 10 },
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'measure' }, snapEnabledRef: { current: true },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    hiddenEntitiesRef: { current: new Set() }, isolatedEntitiesRef: { current: null },
    lastHoverSnapTimeRef: { current: 0 }, HOVER_SNAP_THROTTLE_MS: 0,
    measureRaycastPendingRef: { current: false }, measureRaycastFrameRef: { current: null },
    setSnapTarget: (target: unknown) => { snapTargets.push(target); },
    setSnapVisualization: (viz: unknown) => { residue.push(`viz:${JSON.stringify(viz)}`); },
    clearEdgeLock: () => { residue.push('edge-lock cleared'); },
  } as unknown as MouseHandlerContext;
}
let snapTargets: unknown[] = [];
let residue: string[] = [];

/** One hover frame, then the lazy gate's import settles and the read starts. */
async function hover(c: MouseHandlerContext, x: number, y: number, picks: Array<[number, number]>): Promise<void> {
  c.lastHoverSnapTimeRef.current = 0;
  handleMeasureHover(c, x, y, (_c, px, py) => { picks.push([px, py]); });
  flushFrames();
  await tick();
}

const original = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;
beforeEach(() => {
  reads = []; frames = []; snapTargets = []; residue = []; raycasts.length = 0;
  view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; pickRevision = 0; clipRevision = 0;
  globalThis.requestAnimationFrame = ((cb: () => void) => { frames.push(cb); return frames.length; }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
  setMeasureReadbackFeedForTest((_r, x, y) => new Promise((settle) => { reads.push({ x, y, settle }); }));
  useViewerStore.setState({ measureMode: 'polyline', activePolyline: null, polylineMeasurements: [], activeMeasurement: null });
});
afterEach(() => {
  setMeasureReadbackFeedForTest(null);
  globalThis.requestAnimationFrame = original;
  globalThis.cancelAnimationFrame = originalCancel;
});

describe('#10880 hover readback', () => {
  it('latest wins: an older read that resolves after a newer one never acts', async () => {
    const c = ctx(), picks: Array<[number, number]> = [];
    await hover(c, 10, 10, picks);
    await hover(c, 20, 20, picks);
    assert.equal(reads.length, 2);
    reads[1].settle('fed'); await tick();
    reads[0].settle('fed'); await tick();
    assert.deepEqual(picks, [[20, 20]], 'only the newest hover publishes');
  });

  it('an unavailable read never raycasts past the unbacked front; it clears the preview', async () => {
    const c = ctx(), picks: Array<[number, number]> = [];
    await hover(c, 10, 10, picks);
    reads[0].settle('unavailable'); await tick();
    assert.deepEqual(picks, [], 'no raycast or snap behind the unbacked surface');
    assert.deepEqual(snapTargets, [null], 'and the stale preview is cleared');
    assert.deepEqual(residue, ['viz:null', 'edge-lock cleared'], 'with its snap visualisation and edge lock');
  });

  it('a cancelled (superseded) read does not act for the old pointer', async () => {
    const c = ctx(), picks: Array<[number, number]> = [];
    await hover(c, 10, 10, picks);
    reads[0].settle('cancelled'); await tick();
    assert.deepEqual(picks, []);
  });

  it('a press cancels an in-flight hover read: its completion publishes nothing', async () => {
    const c = ctx(), picks: Array<[number, number]> = [];
    await hover(c, 10, 10, picks);
    cancelMeasureRaycast(c);
    reads[0].settle('fed'); await tick();
    assert.deepEqual(picks, []);
  });
});

describe('#10880 drag and placement readback', () => {
  it('a drag preview raycasts only after its own point is read back, and a cancel drops it', async () => {
    const c = ctx(), acted: string[] = [];
    runWithReadback(c.renderer, 5, 5, {}, () => acted.push('a'));
    await tick();
    assert.equal(acted.length, 0, 'no synchronous raycast over released geometry');
    reads[0].settle('fed'); await measureReadbacksIdle();
    assert.deepEqual(acted, ['a']);
    runWithReadback(c.renderer, 6, 6, {}, () => acted.push('b'));
    await tick();
    cancelMeasureRaycast(c);
    reads[1].settle('fed'); await measureReadbacksIdle();
    assert.deepEqual(acted, ['a'], 'the cancelled preview never acts');
  });

  it('a polyline click reads its point back first, survives the next press, and keeps click order', async () => {
    const c = ctx();
    handlePolylineClick(c, 0, 0);
    assert.equal(raycasts.length, 0, 'no synchronous raycast over released geometry');
    cancelMeasureRaycast(c); // the next click's press and release
    handlePolylineClick(c, 40, 0);
    await tick();
    reads[0].settle('cancelled'); await tick(); // a moving hover superseded it once
    reads[1].settle('cancelled'); await tick(); // and again
    reads[2].settle('fed'); await tick();
    reads[3].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(raycasts, [[0, 0], [40, 0]], 'both points, in click order');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 2);
  });

  it('a placement whose view moved before its read ran is dropped, not placed on what is now under the pixel', async () => {
    const c = ctx();
    handlePolylineClick(c, 0, 0); // clicked on surface A under this view
    handlePolylineClick(c, 40, 0);
    await tick();
    reads[0].settle('fed'); await tick(); // the first lands under the same view
    view = view.map((v, i) => (i === 12 ? v + 5 : v)); // then the user orbits/pans before the second read runs
    reads[1].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(raycasts, [[0, 0]], 'the moved click is never raycast under the new view');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1, 'only the point placed under its own view');
  });

  it('a placement whose model moved (renderer-side) before its read ran is dropped', async () => {
    const c = ctx();
    handlePolylineClick(c, 0, 0);
    handlePolylineClick(c, 40, 0);
    await tick();
    reads[0].settle('fed'); await tick(); // the first lands
    pickRevision++; // setModelTranslation moves the model under the second click's pixel, with no store change
    reads[1].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(raycasts, [[0, 0]], 'the second click is never raycast after its model moved');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1);
  });

  it('a placement whose Snap setting changed before its read ran is dropped', async () => {
    const c = ctx();
    handlePolylineClick(c, 0, 0);
    handlePolylineClick(c, 40, 0);
    await tick();
    reads[0].settle('fed'); await tick();
    c.snapEnabledRef.current = false; // the second point was clicked snapped; it must not land unsnapped
    reads[1].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(raycasts, [[0, 0]], 'the second click is never raycast after Snap changed');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1);
  });

  it('a placement whose section cut changed before its read ran is dropped', async () => {
    const c = ctx();
    handlePolylineClick(c, 0, 0);
    handlePolylineClick(c, 40, 0);
    await tick();
    reads[0].settle('fed'); await tick();
    clipRevision++; // a section plane moves, exposing another surface under the second click's pixel
    reads[1].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(raycasts, [[0, 0]], 'the second click is never raycast after the cut changed');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1);
  });

  it('a placement whose hide or isolate changed before its read ran is dropped, not placed on what is now shown', async () => {
    const c = ctx();
    handlePolylineClick(c, 0, 0); // clicked on surface A
    handlePolylineClick(c, 40, 0);
    await tick();
    reads[0].settle('fed'); await tick(); // the first lands under the same visibility
    c.hiddenEntitiesRef.current = new Set([7]); // then A is hidden, exposing B at the second click's pixel
    reads[1].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(raycasts, [[0, 0]], 'the second click is never raycast under the new visibility');
    assert.equal(useViewerStore.getState().activePolyline?.points.length, 1, 'only the point placed under its own visibility');
  });

  it('a gesture reset (Esc, a mode or tool switch) drops a pending placement', async () => {
    const c = ctx();
    handlePolylineClick(c, 0, 0);
    await tick();
    useViewerStore.getState().resetMeasureGesture();
    reads[0].settle('fed'); await measureReadbacksIdle();
    assert.equal(raycasts.length, 0);
    assert.equal(useViewerStore.getState().activePolyline, null);
  });
});

it('#10880 a gate chunk that fails to load is retried by the next action, not cached as a failure', async () => {
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args[0]); };
  try {
    // The first load fails (a network blip); later ones succeed. Nothing resets the gate between the clicks.
    let loads = 0;
    setMeasureReadbackGateLoaderForTest(() => (loads++ === 0
      ? Promise.reject(new Error('chunk failed to load'))
      : import('./measureReadbackGate.js')));
    const c = ctx();
    handlePolylineClick(c, 0, 0);
    await tick(); await tick();
    assert.equal(reads.length, 0, 'a failed load runs nothing');
    assert.ok(errors.some((e) => String(e).includes('did not load')), 'and says so');
    handlePolylineClick(c, 40, 0);
    await tick();
    reads[0].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(raycasts, [[40, 0]], 'the next action loads the gate and acts');
    assert.equal(loads, 2, 'the failed load was retried, once');
  } finally {
    console.error = originalError;
    setMeasureReadbackGateLoaderForTest(null);
  }
});

it('#10880 a refused Point-mode hover clears the live point an earlier hover showed', async () => {
  useViewerStore.setState({ measureMode: 'point' });
  useViewerStore.getState().setMeasurePointLive({ position: { x: 1, y: 2, z: 3 } } as never);
  assert.ok(useViewerStore.getState().measurePointLive);
  const c = ctx(), picks: Array<[number, number]> = [];
  await hover(c, 10, 10, picks);
  reads[0].settle('unavailable'); await tick();
  assert.equal(useViewerStore.getState().measurePointLive, null, 'no live point left from before the refused hover');
});

it('#10880 a double-click with two placements still pending finishes after both land', async () => {
  const c = ctx();
  handlePolylineClick(c, 0, 0);
  handlePolylineClick(c, 40, 0);
  handlePolylineClick(c, 40, 40);
  await tick();
  reads[0].settle('fed'); await tick(); // the first point lands; two are still pending
  let prevented = false;
  handleMeasureDoubleClick(c, { preventDefault: () => { prevented = true; } } as unknown as MouseEvent);
  assert.equal(prevented, true, 'the double-click is claimed now');
  assert.ok(useViewerStore.getState().activePolyline, 'and not finished before its points');
  reads[1].settle('fed'); await tick();
  reads[2].settle('fed');
  await measureReadbacksIdle();
  const state = useViewerStore.getState();
  assert.equal(state.activePolyline, null, 'the finish ran, after the points');
  assert.equal(state.polylineMeasurements.length, 1, 'one polyline was recorded');
  assert.equal(state.polylineMeasurements[0].points.length, 3, 'with all three points');
});
