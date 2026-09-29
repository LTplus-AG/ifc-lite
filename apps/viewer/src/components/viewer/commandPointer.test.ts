/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The command pointer (charter #6232, WP2) on the WP3 solver: a running
 * `wall.place` snaps its start to an existing wall end through the semantic
 * wall source, Alt suspends snapping, and a typed length holds the end on
 * its circle. A fake renderer: the cursor ray drops straight onto the storey
 * floor at (x/100, −y/100) m, and nothing is under it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import '@/lib/commands/modeling/builtin';
import { getCommandRuntime, writeCommandField } from '@/lib/commands/modeling/runtime';
import type { WallPlaceGesture } from '@/lib/commands/modeling/commands/wall-place-geometry';
import type { SlabPlaceGesture } from '@/lib/commands/modeling/commands/slab-place-geometry';
import { routeCommandPointer } from './commandPointer.js';
import { handleSelectionClick } from './selectionHandlers.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

const W = 1000, H = 1000;

function fakeCtx(): MouseHandlerContext {
  const canvas = { width: W, height: H, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  return {
    renderer: {
      getCamera: () => ({ unprojectToRay: (sx: number, sy: number) => ({ origin: { x: sx / 100, y: 20, z: sy / 100 }, direction: { x: 0, y: -1, z: 0 } }) }),
      getCanvas: () => canvas,
      raycastScene: () => null,
      raycastSceneMagnetic: () => ({ snapTarget: null, intersection: null, edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: false, isCorner: false, cornerValence: 0 } }),
    },
    getPickOptions: () => ({ isStreaming: false, hiddenIds: new Set<number>(), isolatedIds: null }),
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, lockStrength: 0 } },
    snapEnabledRef: { current: true },
    setSnapTarget: () => {},
    setEdgeLock: () => {},
    clearEdgeLock: () => {},
    measureRaycastPendingRef: { current: false },
    measureRaycastFrameRef: { current: null },
  } as unknown as MouseHandlerContext;
}

const gesture = () => getCommandRuntime().gesture as WallPlaceGesture;
const down = (ctx: MouseHandlerContext, x: number, y: number, altKey = false) =>
  routeCommandPointer(ctx, 'down', x, y, { shiftKey: false, altKey });

beforeEach(async () => {
  await seedModelingSession();
  const wall = useViewerStore.getState().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in wall);
  useViewerStore.getState().startCommand('wall.place');
});
afterEach(() => { useViewerStore.getState().exitModelWorkspace(); });

describe('command pointer on the snap engine (#6232 WP2)', () => {
  it('snaps a click near an existing wall end onto the end (semantic source)', () => {
    down(fakeCtx(), 404, -3); // 4.04 m, 0.03 m: a few pixels off the wall end
    assert.deepEqual(gesture().chain.map((p) => p.map((v) => +v.toFixed(6))), [[4, 0]]);
  });

  it('Alt suspends snapping', () => {
    down(fakeCtx(), 404, -3, true);
    assert.deepEqual(gesture().chain.map((p) => p.map((v) => +v.toFixed(6))), [[4.04, 0.03]]);
  });

  it('a typed length holds the solved end on its circle', () => {
    const ctx = fakeCtx();
    down(ctx, 1000, -1000); // (10, 10), nowhere near a wall
    writeCommandField(0, 2);
    down(ctx, 1000, -1500); // aims +y from the anchor, 5 m away
    const walls = useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities()
      .filter((e) => e.type.toUpperCase() === 'IFCWALL').map((e) => useViewerStore.getState().readWallEndpoints(MODEL_ID, e.expressId)!);
    const placed = walls.find((w) => Math.abs(w.start[0] - 10) < 1e-6)!;
    assert.ok(placed, 'the typed wall was placed from (10, 10)');
    assert.deepEqual(placed.end.map((v) => +v.toFixed(6)), [10, 12, 0]);
  });
});

describe('command pointer: clicks and modifiers for the placing commands (#6232 M2.2)', () => {
  const slabs = () => useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCSLAB');
  const slab = () => getCommandRuntime().gesture as SlabPlaceGesture;
  const at = (x: number, y: number, mods: { shiftKey?: boolean; detail?: number } = {}) =>
    routeCommandPointer(fakeCtx(), 'down', x * 100, -y * 100, { shiftKey: false, altKey: false, ...mods });

  beforeEach(() => {
    useViewerStore.getState().setAuthoringDefaults({ slabMode: 'polygon' });
    useViewerStore.getState().startCommand('slab.place');
  });

  it("a click's second half (event.detail 2) closes the polygon instead of adding a corner", () => {
    at(10, 10); at(13, 10); at(13, 13, { detail: 1 });
    assert.equal(slabs().length, 0);
    at(13, 13, { detail: 2 });
    assert.equal(slabs().length, 1, 'the double-click closed a three-corner slab');
  });

  it('a click a few pixels off the first corner snaps onto it and closes the polygon', () => {
    at(10, 10); at(13, 10); at(13, 13);
    at(10.03, 9.98);
    assert.equal(slabs().length, 1);
  });

  it('Shift held on the mouse reaches the gesture: the clicked rectangle is squared', () => {
    useViewerStore.getState().setAuthoringDefaults({ slabMode: 'rectangle' });
    useViewerStore.getState().startCommand('slab.place');
    at(10, 10);
    at(13, 11, { shiftKey: true });
    const view = useViewerStore.getState().mutationViews.get(MODEL_ID)!;
    const profile = view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCRECTANGLEPROFILEDEF').at(-1)!; // the seeded wall owns the first
    assert.deepEqual([profile.attributes[3], profile.attributes[4]].map((v) => +(v as number).toFixed(6)), [3, 3]);
    assert.equal(slab().points.length, 0);
  });

  // Review of #6396: no caller was seen to build `detail`. None needs to:
  // the canvas click listener hands the DOM MouseEvent itself to
  // handleSelectionClick, which passes it on as the modifiers. So a real
  // click event's `detail` must decide it, with no hand-built mods.
  it('a real canvas click event: detail 1 adds a corner, detail 2 closes the polygon', async () => {
    const base = fakeCtx();
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const ctx = { ...base, canvas, mouseState: { didDrag: false }, activeToolRef: { current: 'command' } } as unknown as MouseHandlerContext;
    const clickAt = (x: number, y: number, detail: number) => handleSelectionClick(ctx, new window.MouseEvent('click', {
      clientX: x * 100, clientY: -y * 100, detail,
    }) as unknown as MouseEvent);
    await clickAt(10, 10, 1);
    await clickAt(13, 10, 1);
    await clickAt(13, 13, 1); // first click of a double-click: a corner
    assert.equal(slab().points.length, 3);
    assert.equal(slabs().length, 0);
    await clickAt(13, 13, 2); // its second click: close
    assert.equal(slabs().length, 1, 'the double-click closed the slab');
  });
});
