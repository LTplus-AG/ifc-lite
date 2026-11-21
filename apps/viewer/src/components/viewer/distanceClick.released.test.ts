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
import { handleMeasureDown, handleMeasureUp, noteDistancePointerUp, takeDoubleClickStart } from './distanceClick.js';
import { handleMeasureTap } from './touchRouting.js';
import { handlePointClick } from './measurePointMode.js';
import { measureReadbacksIdle, setMeasureReadbackFeedForTest } from './measureReadbackGate.js';

type Read = { x: number; settle: (outcome: string) => void; done?: boolean };
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
/** As the pointer controls do: `handleMeasureUp` with a measurement pending, or a press still reading its start back. */
function release(ctx: MouseHandlerContext, x: number): void {
  const pending = noteDistancePointerUp(ctx.mouseState); // every measure-tool release
  if (ctx.activeMeasurementRef.current || pending) handleMeasureUp(ctx, up(x));
  else ctx.mouseState.isDragging = false;
}
/** A pointerdown as the controls make it: a new press starts undragged. */
function press(ctx: MouseHandlerContext, x: number): void {
  ctx.mouseState.didDrag = false;
  handleMeasureDown(ctx, down(x));
}
/** Settle the next read in queue order (reads start one at a time, each after the previous lands). */
async function settleNext(outcome = 'fed'): Promise<void> {
  await settleImports();
  const next = reads.find((read) => !read.done);
  assert.ok(next, 'a read is pending');
  next.settle(outcome);
}
/** Settle every read in queue order, including those queued by earlier ones landing. */
async function settleAll(outcome = 'fed'): Promise<void> {
  for (let guard = 0; guard < 50; guard++) {
    await settleImports();
    const next = reads.find((read) => !read.done);
    if (!next) break;
    next.settle(outcome);
  }
  await measureReadbacksIdle();
}

beforeEach(() => {
  reads = [];
  setMeasureReadbackFeedForTest((_r, x) => new Promise((resolve) => {
    const read: Read = { x, settle: (outcome) => { read.done = true; resolve(outcome); } };
    reads.push(read);
  }));
  useViewerStore.setState({ measureMode: 'drag', activeTool: 'measure' } as never);
});
afterEach(async () => {
  // A test that failed mid-gesture must not leave a read pending for the next test to queue behind.
  for (const read of reads) if (!read.done) read.settle('cancelled');
  await measureReadbacksIdle();
  setMeasureReadbackFeedForTest(null);
});

describe('click-click distance over released geometry', () => {
  it('#10884 a quick first click whose release beats its readback still sets the start', async () => {
    const { ctx, log, raycasts } = releasedCtx();
    handleMeasureDown(ctx, down(10));
    release(ctx, 10); // pointerup before the read lands: isDragging is false, no measurement pending yet
    await settleImports();
    assert.deepEqual(raycasts, [], 'no synchronous raycast over released geometry');
    await settleAll();
    assert.deepEqual(log, ['start 10'], 'the click placed its start');
    // The second click finishes there, after reading its own point back.
    handleMeasureDown(ctx, down(300));
    release(ctx, 300);
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 300', 'finished']);
  });

  it('#10884 a second press before the first start lands finishes at its own point, in order', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    handleMeasureDown(ctx, down(300)); release(ctx, 300);
    await settleAll();
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
    await settleAll(); // the second press lands as a second click, its release queued behind it
    assert.deepEqual(log, ['start 10', 'end 400', 'finished'], 'measured to where it was released, not where it was pressed');
  });

  it('#10884 a dragged second press released before any start lands finishes at its release point, never its press point', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    handleMeasureDown(ctx, down(300));
    ctx.mouseState.didDrag = true;
    release(ctx, 400); // no start yet: the controls still hand a pending press its release (r4650402562)
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 400', 'finished'], 'as resident: the second press dragged to 400 finishes there');
  });

  it('r4650402562 a FIRST press dragged and lifted before its start lands measures press to lift, as resident', async () => {
    const { ctx, log } = releasedCtx();
    press(ctx, 10); ctx.mouseState.didDrag = true; release(ctx, 60); // a drag-measure, lifted before the read lands
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 60', 'finished'], 'never left as a start at 10 waiting for another click');
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

describe('#10884 click order over released geometry', () => {
  it('#10884 a second press still held when its own read lands finishes on its release', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10); // the first click, still reading back
    handleMeasureDown(ctx, down(300)); // the second press, deferred too, and still held
    await settleAll(); // the first start lands, then the second press, while held: a second click
    assert.deepEqual(log, ['start 10']);
    const next = reads.length;
    release(ctx, 300); // now released: an ordinary second click
    await settleImports();
    assert.equal(reads[next]?.x, 300, 'the release reads its own point back');
    assert.deepEqual(log, ['start 10'], 'nothing finishes before that read lands');
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 300', 'finished'], 'the second click finishes the distance');
  });

  it('#10884 two more quick clicks before the finishing read lands: the second finishes, the third starts the next distance', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    await settleAll();
    handleMeasureDown(ctx, down(300)); release(ctx, 300); // queued finish
    handleMeasureDown(ctx, down(500)); release(ctx, 500); // queued behind it, the distance still pending
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 300', 'finished', 'start 500'], 'no click is dropped: the third starts the next distance');
  });
});

describe('#10884 a press keeps its own press point and drag behind a queued read', () => {
  it('r4649781963 an unseen dragged second press never finishes at its press point after a later click resets the drag', async () => {
    const { ctx, log } = releasedCtx();
    press(ctx, 10); release(ctx, 10); // the first click, still reading back
    press(ctx, 300); ctx.mouseState.didDrag = true; release(ctx, 400); // dragged before any start landed
    await settleNext(); // the first start lands
    press(ctx, 500); release(ctx, 500); // a third click resets the shared drag state
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 400', 'finished', 'start 500'], 'the drag finishes at its own lift (never 300); the third click starts anew');
  });

  it('r4649781967 a drag pressed while a finish is queued starts the next distance and finishes at its release', async () => {
    const { ctx, log } = releasedCtx();
    press(ctx, 10); release(ctx, 10);
    await settleAll();
    press(ctx, 300); release(ctx, 300); // its finish is queued
    press(ctx, 500); ctx.mouseState.didDrag = true; release(ctx, 600); // pressed and dragged before that finish lands
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 300', 'finished', 'start 500', 'end 600', 'finished'], 'the drag measures 500 to 600, as resident');
  });

  it('r4649781971 a click pressed while a finish is queued starts the next distance at its PRESS point', async () => {
    const { ctx, log } = releasedCtx();
    press(ctx, 10); release(ctx, 10);
    await settleAll();
    press(ctx, 300); release(ctx, 300);
    press(ctx, 500); release(ctx, 502); // within the click slop
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 300', 'finished', 'start 500'], 'started where pressed, as resident');
  });
});

describe('#10884 the double-click marker over released geometry', () => {
  it('r4651056761 a start placed after a finish that was still queued at press-down is dropped by the dblclick, as resident', async () => {
    const { ctx, log } = releasedCtx();
    press(ctx, 10); release(ctx, 10);
    await settleAll();
    press(ctx, 300); release(ctx, 300); // the dblclick's first click: its finish is queued
    press(ctx, 300); release(ctx, 300); // its second press, made before that finish lands
    await settleAll();
    assert.deepEqual(log, ['start 10', 'end 300', 'finished', 'start 300']);
    assert.equal(takeDoubleClickStart(ctx), true, 'the dblclick drops the stray start, as in a resident scene');
  });
});

describe('#10880 a Distance point that cannot be read back discards the half-made distance', () => {
  const epoch = () => useViewerStore.getState().measureGestureEpoch;

  it('#10884 click-click: a second click whose read is refused records no one-ended distance', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    await settleAll();
    assert.deepEqual(log, ['start 10']);
    const before = epoch();
    handleMeasureDown(ctx, down(300)); release(ctx, 300);
    await settleNext('unavailable'); await settleAll();
    assert.deepEqual(log, ['start 10'], 'never finished with an end it could not read');
    assert.equal(epoch(), before + 1, 'the half-made distance is discarded (a gesture reset)');
  });

  it('#10884 a deferred second press whose queued release is refused discards, never finishing at the press point', async () => {
    const { ctx, log } = releasedCtx();
    handleMeasureDown(ctx, down(10)); release(ctx, 10);
    handleMeasureDown(ctx, down(300));
    await settleNext(); // the first start lands
    ctx.mouseState.didDrag = true;
    release(ctx, 400); // queued behind the second press
    const before = epoch();
    await settleNext(); // the first click's own release (a click: nothing more)
    await settleNext(); // the second press lands as a second click
    await settleNext('unavailable'); // its release point cannot be read
    await settleAll();
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
