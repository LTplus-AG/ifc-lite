/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Coverage gap closed for issue #5210: the recovery fix in `calculateBounds`
 * checks the accumulated fast-path result once per batch via
 * `isBoundsPoisoned`, falling back to the filtered slow path when a bound
 * exceeds `MAX_REASONABLE_COORD`. Every existing test in this file's siblings
 * (`coordinate-handler-bounds-recovery*.test.ts`) asserts the *bounds values*
 * that come out, and the slow path produces correct bounds too — so tightening
 * `MAX_REASONABLE_COORD` from 1e7 to 1000 makes no existing test fail, even
 * though it would make the fast path fall back on every batch for every
 * georeferenced model, destroying the ~380M-call optimisation it exists for.
 * (The PR's own first version made exactly this mistake, comparing against
 * the 10,000 m `NORMAL_COORD_THRESHOLD_M` instead.)
 *
 * This test asserts that `calculateBoundsFast` is actually the method that
 * ran, for clean geometry at realistic UTM survey magnitudes (eastings around
 * 500,000 m, northings around 5,000,000 m, carried via the per-element
 * `MeshData.origin`, per `calculateBoundsFast`'s own doc comment: it operates
 * on `world = origin + position`). That is the shape of coordinate that would
 * have caught the original (10,000 m) threshold mistake; a test at kilometre
 * magnitude cannot, and one already exists.
 *
 * `fastBoundsEligible` is reached here the way a real native/desktop producer
 * reaches it: no `setWasmMetadata` call, so `processMeshesIncremental` falls
 * back to `inferWasmRtcApplied` (`coordinate-rtc-policy.ts`), which votes on
 * `positions` magnitude alone (a local per-element frame, a few metres) and
 * does not look at `origin` — so it infers "RTC applied" and makes the fast
 * path eligible even though `world = origin + position` is still UTM-scale.
 * That gap between what the vote sees and what the bounds check sees is
 * exactly the shape of model the accumulated-result check has to be right for.
 */

import { describe, it, expect, vi } from 'vitest';
import { CoordinateHandler } from './coordinate-handler.js';
import type { MeshData } from './types.js';

/**
 * A small, clean local-frame triangle placed at a UTM-scale site origin.
 * `world = origin + positions[i]`, matching `calculateBoundsFast`'s contract.
 * `positions` stay metre-scale so `inferWasmRtcApplied`'s first-vertex vote
 * (which only looks at `positions`, not `origin`) reads this as RTC-applied.
 */
function utmMesh(expressId: number, originEasting: number, originNorthing: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 1, 0, 2, 0, 0.5]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    origin: [originEasting, originNorthing, 0],
  };
}

describe('CoordinateHandler actually takes the fast path (performance pin, #5210)', () => {
  it('calls calculateBoundsFast for steady-state clean UTM-scale batches', () => {
    const handler = new CoordinateHandler();
    const fastSpy = vi.spyOn(
      handler as unknown as { calculateBoundsFast: (m: MeshData[]) => unknown },
      'calculateBoundsFast',
    );

    // First batch makes the shift/eligibility decision; `shiftCalculated` is
    // false until it completes, so this one always goes through the slow
    // path regardless of the fix.
    handler.processMeshesIncremental([utmMesh(1, 500_000, 5_000_000)]);
    fastSpy.mockClear();

    // Steady-state batches: clean geometry at real UTM eastings/northings.
    // This is exactly the case (~500,000 m easting) that a 10,000 m
    // threshold — the PR's first, incorrect version — would have poisoned on
    // every single batch, permanently killing the fast path for this model.
    for (let i = 0; i < 5; i++) {
      handler.processMeshesIncremental([utmMesh(2 + i, 500_000 + i * 10, 5_000_000 + i * 10)]);
    }

    expect(fastSpy).toHaveBeenCalledTimes(5);
  });
});
