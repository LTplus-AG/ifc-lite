/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #5210, second suggestion: the per-batch `isBoundsPoisoned` check
 * (`coordinate-handler-bounds-recovery.test.ts`) recovers bounds silently —
 * the corrupted vertex is filtered and the caller is never told. This pins
 * `boundsRecoveryFallbackCount`, the counter that surfaces how many batches
 * actually triggered the slow-path fallback, via both
 * `getCurrentCoordinateInfo()` and `getFinalCoordinateInfo()`.
 */

import { describe, it, expect } from 'vitest';
import { CoordinateHandler, NORMAL_COORD_THRESHOLD_M } from './coordinate-handler.js';
import type { MeshData } from './types.js';

/** One triangle, bounds are the single point. */
function meshAt(x: number, y: number, z: number): MeshData {
  return {
    expressId: 1,
    positions: new Float32Array([x, y, z, x, y, z, x, y, z]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

describe('CoordinateHandler.boundsRecoveryFallbackCount', () => {
  it('reads zero for clean batches, on both accessors', () => {
    const handler = new CoordinateHandler();
    const cleanCoord = NORMAL_COORD_THRESHOLD_M * 0.5;

    handler.processMeshesIncremental([meshAt(cleanCoord, 0, 0)]);
    handler.processMeshesIncremental([meshAt(cleanCoord * 1.2, 0, 0)]);
    handler.processMeshesIncremental([meshAt(cleanCoord * 0.8, 0, 0)]);

    expect(handler.getCurrentCoordinateInfo()?.boundsRecoveryFallbackCount).toBe(0);
    expect(handler.getFinalCoordinateInfo().boundsRecoveryFallbackCount).toBe(0);
  });

  it('increments exactly once per poisoned batch', () => {
    const handler = new CoordinateHandler();
    const cleanCoord = NORMAL_COORD_THRESHOLD_M * 0.5;
    const poisonedCoord = 1.0e30;

    // First batch establishes the shift/eligibility decision.
    handler.processMeshesIncremental([meshAt(cleanCoord, 0, 0)]);
    expect(handler.getCurrentCoordinateInfo()?.boundsRecoveryFallbackCount).toBe(0);

    // One poisoned batch: fast path samples the corrupted vertex, isBoundsPoisoned
    // fires, slow path recomputes for this batch. Count goes to 1.
    handler.processMeshesIncremental([meshAt(poisonedCoord, poisonedCoord, poisonedCoord)]);
    expect(handler.getCurrentCoordinateInfo()?.boundsRecoveryFallbackCount).toBe(1);

    // A clean batch afterwards must not increment it further.
    handler.processMeshesIncremental([meshAt(cleanCoord * 0.5, 0, 0)]);
    expect(handler.getCurrentCoordinateInfo()?.boundsRecoveryFallbackCount).toBe(1);

    // A second poisoned batch increments again — one count per poisoned batch, not per vertex.
    handler.processMeshesIncremental([meshAt(poisonedCoord, poisonedCoord, poisonedCoord)]);
    const final = handler.getFinalCoordinateInfo();
    expect(final.boundsRecoveryFallbackCount).toBe(2);
  });

  it('resets to zero on reset()', () => {
    const handler = new CoordinateHandler();
    const cleanCoord = NORMAL_COORD_THRESHOLD_M * 0.5;
    const poisonedCoord = 1.0e30;

    handler.processMeshesIncremental([meshAt(cleanCoord, 0, 0)]);
    handler.processMeshesIncremental([meshAt(poisonedCoord, poisonedCoord, poisonedCoord)]);
    expect(handler.getFinalCoordinateInfo().boundsRecoveryFallbackCount).toBe(1);

    handler.reset();
    handler.processMeshesIncremental([meshAt(cleanCoord, 0, 0)]);
    expect(handler.getFinalCoordinateInfo().boundsRecoveryFallbackCount).toBe(0);
  });
});
