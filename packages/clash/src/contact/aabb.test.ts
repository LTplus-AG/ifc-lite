/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Boundary-pinning tests for `contact/aabb.ts`. Mutation testing (flipping
 * each comparison operator below) found these three closed-interval
 * boundaries had zero test coverage: a fixture merely NEAR a boundary passes
 * under both the `<=`/`<` (or `>=`/`>`) forms, so it doesn't distinguish
 * them. Each test here sits exactly ON its boundary.
 */

import { describe, expect, it } from "vitest";
import { contains, intersects, longestAxis } from "./aabb.js";
import type { AABB } from "./types.js";

describe("intersects() — closed-interval face touch (aabb.ts:16)", () => {
  it("reports overlap when two boxes touch exactly face-to-face on one axis", () => {
    // a.min[0] === b.max[0] exactly: the boxes share the x=1 plane and are
    // clearly overlapping on y/z. `<=` (closed interval) says they touch;
    // a mutated `<` would call this a miss.
    const a: AABB = { min: [1, 0, 0], max: [2, 1, 1] };
    const b: AABB = { min: [0, 0, 0], max: [1, 1, 1] };
    expect(intersects(a, b)).toBe(true);
  });
});

describe("contains() — closed-interval point-on-boundary (aabb.ts:46)", () => {
  it("reports containment for a point exactly on the box's min face", () => {
    // p[0] === a.min[0] exactly. `>=` (closed interval) includes it; a
    // mutated `>` would exclude it.
    const a: AABB = { min: [0, 0, 0], max: [2, 2, 2] };
    const p: readonly [number, number, number] = [0, 1, 1];
    expect(contains(a, p)).toBe(true);
  });
});

describe("longestAxis() — tie-break order (aabb.ts:91)", () => {
  it("returns axis 0 (x) when x and y are exactly tied and both exceed z", () => {
    // dx === dy > dz: a genuine tie, not merely two close values. The
    // production code's tie-break order (x wins ties with y) is the
    // behaviour under test, so asserting the specific axis (not "either")
    // is the point — a mutated `>` on the first clause would fall through
    // to the y/z comparison and return 1 instead.
    const a: AABB = { min: [0, 0, 0], max: [4, 4, 1] };
    expect(longestAxis(a)).toBe(0);
  });
});
