/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isSnapWithinScreenRadius, gateSnapToScreen } from './measureHandlers.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import type { MagneticSnapResult } from '@ifc-lite/renderer';

describe('isSnapWithinScreenRadius', () => {
  it('keeps a snap inside the radius', () => {
    assert.strictEqual(isSnapWithinScreenRadius({ x: 105, y: 100 }, 100, 100, 60), true);
  });

  it('keeps a snap exactly on the radius boundary', () => {
    assert.strictEqual(isSnapWithinScreenRadius({ x: 160, y: 100 }, 100, 100, 60), true);
  });

  it('rejects a snap outside the radius', () => {
    assert.strictEqual(isSnapWithinScreenRadius({ x: 200, y: 100 }, 100, 100, 60), false);
  });

  it('measures diagonal distance (3-4-5)', () => {
    // 30px right + 40px down = 50px < 60 → inside; 40+30 with radius 40 → 50 > 40 outside
    assert.strictEqual(isSnapWithinScreenRadius({ x: 130, y: 140 }, 100, 100, 60), true);
    assert.strictEqual(isSnapWithinScreenRadius({ x: 130, y: 140 }, 100, 100, 40), false);
  });

  it('keeps the snap when it cannot be projected (behind camera)', () => {
    assert.strictEqual(isSnapWithinScreenRadius(null, 100, 100, 60), true);
  });
});

// ---- gateSnapToScreen ----

const RELEASED_LOCK = {
  edge: null,
  meshExpressId: null,
  edgeT: 0,
  shouldLock: false,
  shouldRelease: false,
  isCorner: false,
  cornerValence: 0,
};

function makeResult(snapWorld: { x: number; y: number; z: number } | null): MagneticSnapResult {
  return {
    snapTarget: snapWorld
      ? { type: 'vertex' as never, position: snapWorld, expressId: 1, confidence: 1 }
      : null,
    edgeLock: { ...RELEASED_LOCK },
  };
}

/**
 * Minimal context: a 1:1 (no DPR scaling) 1000x1000 canvas and a projection
 * that simply echoes the world XY as screen pixels, so we can place the snap
 * at a known screen distance from the cursor.
 */
function makeCtx(opts: { lockedEdge?: boolean } = {}): MouseHandlerContext {
  return {
    canvas: {
      width: 1000,
      height: 1000,
      getBoundingClientRect: () => ({ width: 1000, height: 1000 }),
    },
    camera: {
      projectToScreen: (pos: { x: number; y: number; z: number }) => ({ x: pos.x, y: pos.y }),
    },
    edgeLockStateRef: { current: { edge: opts.lockedEdge ? { v0: {}, v1: {} } : null } },
    snapEnabledRef: { current: true },
  } as unknown as MouseHandlerContext;
}

describe('gateSnapToScreen', () => {
  it('keeps a snap near the cursor', () => {
    const result = makeResult({ x: 120, y: 100, z: 0 }); // 20px from cursor (100,100)
    gateSnapToScreen(makeCtx(), result, 100, 100, 60);
    assert.ok(result.snapTarget, 'snap within radius should be kept');
  });

  it('demotes a snap far from the cursor and releases the lock', () => {
    const result = makeResult({ x: 300, y: 100, z: 0 }); // 200px from cursor
    gateSnapToScreen(makeCtx(), result, 100, 100, 60);
    assert.strictEqual(result.snapTarget, null, 'far snap should be demoted');
    assert.strictEqual(result.edgeLock.shouldRelease, true, 'lock should be released');
  });

  it('is skipped while an edge lock is active (preserves sliding)', () => {
    const result = makeResult({ x: 300, y: 100, z: 0 }); // far, but we are sliding
    gateSnapToScreen(makeCtx({ lockedEdge: true }), result, 100, 100, 60);
    assert.ok(result.snapTarget, 'active lock should bypass the gate');
  });

  it('is a no-op when snapping is off (radius 0)', () => {
    const result = makeResult({ x: 300, y: 100, z: 0 });
    gateSnapToScreen(makeCtx(), result, 100, 100, 0);
    assert.ok(result.snapTarget, 'radius 0 should bypass the gate');
  });

  it('does nothing when there is no snap target', () => {
    const result = makeResult(null);
    gateSnapToScreen(makeCtx(), result, 100, 100, 60);
    assert.strictEqual(result.snapTarget, null);
  });
});
