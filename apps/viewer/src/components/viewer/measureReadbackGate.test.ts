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
import { measureReadbacksIdle, runWithReadback, setMeasureReadbackFeedForTest } from './measureReadbackGate.js';

type Read = { x: number; y: number; settle: (outcome: string) => void };
let reads: Read[] = [];
let frames: Array<() => void> = [];
const flushFrames = () => { const now = frames; frames = []; for (const frame of now) frame(); };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const released = { isGeometryDataReleased: () => true };
const raycasts: Array<[number, number]> = [];
function ctx(): MouseHandlerContext {
  const renderer = {
    getScene: () => released,
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
  } as unknown as MouseHandlerContext;
}
let snapTargets: unknown[] = [];

function hover(c: MouseHandlerContext, x: number, y: number, picks: Array<[number, number]>): void {
  c.lastHoverSnapTimeRef.current = 0;
  handleMeasureHover(c, x, y, (_c, px, py) => { picks.push([px, py]); });
  flushFrames();
}

const original = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;
beforeEach(() => {
  reads = []; frames = []; snapTargets = []; raycasts.length = 0;
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
    hover(c, 10, 10, picks);
    hover(c, 20, 20, picks);
    assert.equal(reads.length, 2);
    reads[1].settle('fed'); await tick();
    reads[0].settle('fed'); await tick();
    assert.deepEqual(picks, [[20, 20]], 'only the newest hover publishes');
  });

  it('an unavailable read never raycasts past the unbacked front; it clears the preview', async () => {
    const c = ctx(), picks: Array<[number, number]> = [];
    hover(c, 10, 10, picks);
    reads[0].settle('unavailable'); await tick();
    assert.deepEqual(picks, [], 'no raycast or snap behind the unbacked surface');
    assert.deepEqual(snapTargets, [null], 'and the stale preview is cleared');
  });

  it('a cancelled (superseded) read does not act for the old pointer', async () => {
    const c = ctx(), picks: Array<[number, number]> = [];
    hover(c, 10, 10, picks);
    reads[0].settle('cancelled'); await tick();
    assert.deepEqual(picks, []);
  });

  it('a press cancels an in-flight hover read: its completion publishes nothing', async () => {
    const c = ctx(), picks: Array<[number, number]> = [];
    hover(c, 10, 10, picks);
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
