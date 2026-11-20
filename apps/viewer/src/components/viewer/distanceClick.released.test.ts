/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Click-click Distance and Distance taps over released CPU geometry (#10264, #10884),
 * through the one measure readback gate (#10880). A press, a finishing release and a
 * tap are placements: each reads its own point back first, lands even after a quick
 * click's release, keeps its order, and is dropped only by a gesture reset.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { useViewerStore } from '@/store';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { handleMeasureDown, handleMeasureUp } from './distanceClick.js';
import { handleMeasureTap } from './touchRouting.js';
import { handlePointClick } from './measurePointMode.js';
import { measureReadbacksIdle, setMeasureReadbackFeedForTest } from './measureReadbackGate.js';

type Read = { x: number; settle: (outcome: string) => void };
let reads: Read[] = [];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** Let the lazy gate's import settle and the queued read start. */
const settleImports = async () => { for (let i = 0; i < 4; i++) await tick(); };

function releasedCtx() {
  const raycasts: number[] = [];
  const log: string[] = [];
  const active: { current: { start: { x: number; y: number; z: number } } | null } = { current: null };
  const ctx = {
    canvas: Object.assign(document.createElement('canvas'), { getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    renderer: {
      getScene: () => ({ isGeometryDataReleased: () => true }),
      raycastSceneMagnetic: (x: number) => {
        raycasts.push(x);
        return { intersection: { point: { x, y: 0, z: 0 } }, snapTarget: null,
          edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 } };
      },
    },
    camera: { projectToScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }) },
    mouseState: { isDragging: false, didDrag: false },
    activeToolRef: { current: 'measure' },
    activeMeasurementRef: active,
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    measurementConstraintEdgeRef: { current: null },
    measureRaycastFrameRef: { current: null }, measureRaycastPendingRef: { current: false },
    hiddenEntitiesRef: { current: new Set() }, isolatedEntitiesRef: { current: null }, snapEnabledRef: { current: true },
    lastHoverSnapTimeRef: { current: 0 },
    clearEdgeLock: () => {}, setSnapTarget: () => {}, setSnapVisualization: () => {}, setMeasurementConstraintEdge: () => {},
    startMeasurement: (start: { x: number; y: number; z: number }) => { active.current = { start }; log.push(`start ${start.x}`); },
    updateMeasurement: (end: { x: number }) => log.push(`end ${end.x}`),
    finalizeMeasurement: () => { active.current = null; log.push('finished'); },
  } as unknown as MouseHandlerContext;
  return { ctx, log, raycasts };
}
const down = (x: number) => new window.MouseEvent('pointerdown', { clientX: x, clientY: 5 }) as unknown as PointerEvent;
const up = (x: number) => new window.MouseEvent('pointerup', { clientX: x, clientY: 5 }) as unknown as PointerEvent;
/** The pointer controls call `handleMeasureUp` only with a measurement pending (useMouseControls). */
function release(ctx: MouseHandlerContext, x: number): void {
  if (ctx.activeMeasurementRef.current) handleMeasureUp(ctx, up(x));
  else ctx.mouseState.isDragging = false;
}

beforeEach(() => {
  reads = [];
  setMeasureReadbackFeedForTest((_r, x) => new Promise((settle) => { reads.push({ x, settle }); }));
  useViewerStore.setState({ measureMode: 'drag', activeTool: 'measure' } as never);
});
afterEach(() => setMeasureReadbackFeedForTest(null));

describe('click-click distance over released geometry', () => {
  it('#10884 a quick first click whose release beats its readback still sets the start', async () => {
    const { ctx, log, raycasts } = releasedCtx();
    handleMeasureDown(ctx, down(10));
    release(ctx, 10); // pointerup before the read lands: isDragging is false, no measurement pending yet
    await settleImports();
    assert.deepEqual(raycasts, [], 'no synchronous raycast over released geometry');
    reads[0].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10'], 'the click placed its start');
    // The second click finishes there, after reading its own point back.
    handleMeasureDown(ctx, down(300));
    release(ctx, 300);
    await settleImports();
    reads[1].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10', 'end 300', 'finished']);
  });

  it('#10884 a second press before the first start lands finishes at its own point, in order', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    handleMeasureDown(ctx, down(300)); release(ctx, 300);
    await settleImports();
    reads[0].settle('fed'); await tick();
    reads[1].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10', 'end 300', 'finished'], 'one distance from the first click to the second');
  });

  it('#10884 a second press dragged and released while its own start still reads back finishes at the RELEASE point', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10); // the first click, still reading back
    handleMeasureDown(ctx, down(300)); // the second press, also deferred (no start was pending yet)
    await settleImports();
    reads[0].settle('fed'); await tick(); // the first start lands
    assert.deepEqual(log, ['start 10']);
    ctx.mouseState.didDrag = true; // dragged from 300 to 400
    release(ctx, 400); // a start is pending now, so the controls hand the release to handleMeasureUp
    await settleImports();
    reads[1].settle('fed'); await tick(); // the second press lands: a second click, its release queued behind it
    reads[2].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10', 'end 400', 'finished'], 'measured to where it was released, not where it was pressed');
  });

  it('#10884 a dragged second press whose release was never seen keeps the start pending, never measuring to the press point', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    handleMeasureDown(ctx, down(300));
    ctx.mouseState.didDrag = true;
    release(ctx, 400); // no start pending yet: the controls never call handleMeasureUp
    await settleImports();
    reads[0].settle('fed'); await tick();
    reads[1].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10'], 'the start stays pending for the next click');
  });

  it('#10884 Esc while the second click reads back drops the finish', async () => {
    const { ctx, log } = releasedCtx();
    ctx.activeMeasurementRef.current = { start: { x: 0, y: 0, z: 0 } } as never; // the first click's pending start
    ctx.mouseState.isDragging = true;
    handleMeasureUp(ctx, up(300));
    await settleImports();
    useViewerStore.getState().resetMeasureGesture();
    reads[0].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(log, [], 'nothing measured after the reset');
  });
});

describe('Distance taps and Point clicks over released geometry', () => {
  it('#10884 a tap pending when the tool switches to Select (mode still drag) places nothing', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureTap(ctx, 10, 5);
    await settleImports();
    ctx.activeToolRef.current = 'select';
    useViewerStore.setState({ activeTool: 'select' } as never);
    reads[0].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(log, []);
  });

  it('#10884 a Point-mode click reads its own point back before it places', async () => {
    useViewerStore.setState({ measureMode: 'point', measurePointLast: null } as never);
    const { ctx, raycasts } = releasedCtx();
    handlePointClick(ctx, 42, 5);
    await settleImports();
    assert.deepEqual(raycasts, [], 'no synchronous raycast over released geometry');
    assert.equal(reads[0]?.x, 42, 'the read is at the click');
    reads[0].settle('fed');
    await measureReadbacksIdle();
    assert.deepEqual(raycasts, [42]);
    assert.equal((useViewerStore.getState() as unknown as { measurePointLast: { x: number } | null }).measurePointLast?.x, 42);
  });
});

describe('#10880 a Distance point that cannot be read back discards the half-made distance', () => {
  const epoch = () => useViewerStore.getState().measureGestureEpoch;

  it('#10884 click-click: a second click whose read is refused records no one-ended distance', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    await settleImports();
    reads[0].settle('fed'); await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10']);
    const before = epoch();
    handleMeasureDown(ctx, down(300)); release(ctx, 300);
    await settleImports();
    reads[1].settle('unavailable'); await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10'], 'never finished with an end it could not read');
    assert.equal(epoch(), before + 1, 'the half-made distance is discarded (a gesture reset)');
  });

  it('#10884 a deferred second press whose queued release is refused discards, never finishing at the press point', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    handleMeasureDown(ctx, down(300));
    await settleImports();
    reads[0].settle('fed'); await tick();
    ctx.mouseState.didDrag = true;
    release(ctx, 400); // queued behind the second press
    await settleImports();
    const before = epoch();
    reads[1].settle('fed'); await tick(); // the second press lands as a second click
    reads[2].settle('unavailable'); // its release point cannot be read
    await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10'], 'no end at 300 or 400');
    assert.equal(epoch(), before + 1, 'discarded');
  });

  it('#10884 a second Distance tap whose read is refused discards the pending start', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureTap(ctx, 10, 5);
    await settleImports();
    reads[0].settle('fed'); await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10']);
    const before = epoch();
    handleMeasureTap(ctx, 300, 5);
    await settleImports();
    reads[1].settle('unavailable'); await measureReadbacksIdle();
    assert.deepEqual(log, ['start 10']);
    assert.equal(epoch(), before + 1);
  });
});
