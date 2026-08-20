/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boundary-pinning test for the inflated-AABB overlap test in
 * `contact/bvh.ts`. Mutation testing (flipping `<=` to `<` on
 * `boundsOverlapInflated`'s first axis clause) found zero test coverage:
 * nothing sat exactly on the eps-inflated touching boundary.
 *
 * `boundsOverlapInflated` short-circuits to `intersects()` when `eps === 0`
 * (already covered by `aabb.test.ts`), so this test uses eps != 0 to reach
 * the inflated comparison itself.
 */

import { describe, expect, it } from "vitest";
import { Bvh } from "./bvh.js";
import type { AABB, MeshBounds } from "./types.js";

describe("Bvh.queryPairs — inflated-bounds closed-interval touch (bvh.ts:204)", () => {
  it("reports a pair whose eps-inflated boxes touch exactly (not merely overlap)", () => {
    const eps = 0.5;
    // a.min[0] - eps === b.max[0] + eps exactly (1 - 0.5 === 0 + 0.5): the
    // inflated boxes touch exactly on x. y/z overlap generously so no other
    // axis is anywhere near its own boundary.
    const a: AABB = { min: [1, 0, 0], max: [2, 1, 1] };
    const b: AABB = { min: [-1, 0, 0], max: [0, 1, 1] };
    const items: MeshBounds[] = [
      { id: "A", aabb: a },
      { id: "B", aabb: b },
    ];
    const bvh = Bvh.build(items);
    expect(bvh.queryPairs(eps)).toEqual([["A", "B"]]);
  });
});
