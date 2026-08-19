/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boundary-pinning test for the inflated-AABB overlap test in
 * `contact/mesh-bvh.ts`. Mutation testing (flipping `<=` to `<` on
 * `boundsOverlap`'s first axis clause) found zero test coverage: nothing sat
 * exactly on the eps-inflated touching boundary. Unlike `bvh.ts`'s
 * `boundsOverlapInflated`, this `boundsOverlap` has no `eps === 0`
 * short-circuit, so any eps value reaches the same comparison.
 */

import { describe, expect, it } from "vitest";
import { buildMeshBvh, queryMeshCross } from "./mesh-bvh.js";
import type { Mesh } from "./types.js";

function triMesh(id: string, v0: [number, number, number], v1: [number, number, number], v2: [number, number, number]): Mesh {
  return {
    id,
    positions: new Float32Array([...v0, ...v1, ...v2]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe("queryMeshCross — inflated-bounds closed-interval touch (mesh-bvh.ts:107)", () => {
  it("reports a triangle pair whose eps-inflated AABBs touch exactly (not merely overlap)", () => {
    const eps = 0.5;
    // Triangle A's AABB is [1,0,0]-[2,1,1]; triangle B's is [-1,0,0]-[0,1,1].
    // a.min[0] - eps === b.max[0] + eps exactly (1 - 0.5 === 0 + 0.5): the
    // inflated boxes touch exactly on x, and clearly overlap on y/z.
    const meshA = triMesh("A", [1, 0, 0], [2, 1, 0], [1, 0, 1]);
    const meshB = triMesh("B", [-1, 0, 0], [0, 1, 0], [-1, 0, 1]);
    const bvhA = buildMeshBvh(meshA);
    const bvhB = buildMeshBvh(meshB);
    expect(queryMeshCross(bvhA, bvhB, eps)).toEqual([[0, 0]]);
  });
});
