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
import { routeCommandPointer } from './commandPointer.js';
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
