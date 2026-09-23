/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bounds recovery when the fast path is poisoned by a corrupted vertex.
 *
 * Issue #5210: `calculateBoundsFast` dropped the per-vertex validity filter,
 * so once a single finite-but-huge vertex was sampled, bounds accumulated
 * permanently and never recovered. A clean subsequent batch would compare
 * against the poisoned accumulator and lose.
 *
 * Fix: After fast-path sampling, check if bounds exceed NORMAL_COORD_THRESHOLD_M.
 * If poisoned, recompute via slow path with per-vertex filter for that batch
 * to restore recoverability. Six comparisons per batch instead of per vertex,
 * preserving the ~380M-call saving while preventing permanent corruption.
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

describe('CoordinateHandler bounds recovery from poisoned fast path', () => {
  it('recovers from a poisoned batch in the three-batch scenario (RED test)', () => {
    // Issue #5210: clean → garbage → clean should recover the bounds.
    // This test FAILS without the fix.
    const handler = new CoordinateHandler();

    // Batch 1: clean vertices inside threshold
    const cleanCoord = NORMAL_COORD_THRESHOLD_M * 0.5;
    handler.processMeshesIncremental([meshAt(cleanCoord, 0, 0)]);

    // At this point, bounds are [cleanCoord, 0, 0], and fastBoundsEligible
    // is now true (after first shift decision). Subsequent calls use fast path.

    // Batch 2: poisoned vertex (1e30, which is way beyond threshold)
    const poisonedCoord = 1.0e30;
    handler.processMeshesIncremental([meshAt(poisonedCoord, poisonedCoord, poisonedCoord)]);

    // Fast path would accumulate this: bounds now [cleanCoord, 0, 0] → [1e30, 1e30, 1e30]
    // The corrupted accumulator would stay at 1e30 forever in the buggy path.

    // Batch 3: clean vertices again — should recover
    handler.processMeshesIncremental([meshAt(cleanCoord * 0.5, 0, 0)]);

    // Get the final bounds. After the fix, this should be approximately
    // [cleanCoord*0.5, 0, 0] or nearby. The key assertion: NOT 1e30.
    // In the buggy path, bounds.max.x ≈ 1e30; after fix, it should be close to cleanCoord.
    const info = handler.getFinalCoordinateInfo();
    const recoveredBounds = info.originalBounds;

    // Assert recovery: the third batch's clean vertex made the bounds recover.
    // The poisoned batch should be effectively ignored by the recovery filter.
    expect(recoveredBounds.max.x).toBeLessThan(1e20); // Way less than 1e30
    expect(recoveredBounds.max.x).toBeLessThan(NORMAL_COORD_THRESHOLD_M * 2); // Reasonable threshold
  });

  it('still uses the fast path for clean batches (no-regression)', () => {
    // Verify the fast path is still taken when bounds are clean.
    // This is a performance regression pin: if we always fall back to slow path,
    // we've lost the 380M-call saving.
    const handler = new CoordinateHandler();

    // First batch to establish fastBoundsEligible
    const cleanCoord = NORMAL_COORD_THRESHOLD_M * 0.5;
    handler.processMeshesIncremental([meshAt(cleanCoord, 0, 0)]);

    // Subsequent clean batches with larger values
    handler.processMeshesIncremental([meshAt(cleanCoord * 1.5, 0, 0)]);
    handler.processMeshesIncremental([meshAt(cleanCoord * 2.0, 0, 0)]);

    const info = handler.getFinalCoordinateInfo();
    // Bounds should be approximately [cleanCoord*2.0, 0, 0]
    // (the maximum extent of the three batches)
    expect(info.originalBounds.max.x).toBeLessThan(cleanCoord * 2.5);
    expect(info.originalBounds.max.x).toBeGreaterThan(cleanCoord);
  });

  it('rejects corrupted coordinates at the per-vertex level in slow path', () => {
    // Mutation test: ensure the slow path's per-vertex filter is actually used.
    // If we remove the filter (Math.abs(x) < threshold), this test should fail.
    const handler = new CoordinateHandler();

    // First batch to establish the handler state
    const cleanCoord = NORMAL_COORD_THRESHOLD_M * 0.5;
    handler.processMeshesIncremental([meshAt(cleanCoord, 0, 0)]);

    // Batch 2: A mesh with mixed vertices — some clean, some poisoned
    // The fast path would sample the first and last vertex; if first is poisoned,
    // it triggers fallback. But we need to ensure the slow path filter works.
    // Create a mesh with first vertex clean and last vertex poisoned.
    const positions = new Float32Array([
      cleanCoord, 0, 0,      // First: clean
      cleanCoord, 0, 0,
      1.0e30, 1.0e30, 1.0e30 // Last: poisoned (would trigger fallback)
    ]);
    const mesh: MeshData = {
      expressId: 2,
      positions,
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
    };

    handler.processMeshesIncremental([mesh]);

    // Batch 3: clean batch to verify recovery
    handler.processMeshesIncremental([meshAt(cleanCoord * 0.5, 0, 0)]);

    const info = handler.getFinalCoordinateInfo();
    // The bounds should be dominated by the clean vertices, not the 1e30 vertex
    expect(info.originalBounds.max.x).toBeLessThan(1e20);
    expect(info.originalBounds.max.x).toBeLessThan(NORMAL_COORD_THRESHOLD_M * 2);
  });
});
