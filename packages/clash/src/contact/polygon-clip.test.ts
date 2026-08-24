/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { convexHull2, type Point2, type Polygon2 } from './polygon-clip.js';

/**
 * `convexHull2` had no direct test, and its collinear-point handling was
 * unexercised by anything.
 *
 * Measured: changing the pruning comparison from `cross2(a, b, p) <= 0` to
 * `< 0` — so exactly-collinear points stop being discarded — left
 * `packages/clash` at 425/425 passing.
 *
 * An earlier version of this note claimed that reversing the inequality IS
 * caught by `contact.test.ts`, "so the module is not blind in general". That
 * was wrong. Reversing both comparisons to `>= 0` leaves this file AND
 * `contact.test.ts` at 34/34 passing — measured on this branch with the vitest
 * transform cache cleared. The tests added here kill the `< 0` mutant (6 of 16
 * fail) and do not kill the reversal. So the pruning comparison is unpinned in
 * BOTH directions by everything outside this file, and pinned in one direction
 * by it.
 *
 * That matters here because building geometry is overwhelmingly axis-aligned,
 * so collinear boundary points are the ordinary case rather than an edge case,
 * and this hull becomes the reported contact boundary for a clash
 * (`shared-faces.ts:204` → `polygonCentroid`, `polygonSpans`, and the viewer's
 * outline).
 *
 * The reason the existing suite cannot see it: the shoelace area is invariant
 * to a redundant collinear vertex, so `area_m2` thresholds are unchanged, and
 * the only structural check downstream is `boundary.length >= 3`, which a
 * hull carrying extra vertices still satisfies. The damage shows up instead on
 * degenerate inputs, where the mutated algorithm returns a **self-intersecting
 * polygon** — it walks out along a line and back over its own points.
 *
 * Expected vertices below are stated as SETS with an explicit count, not as
 * ordered arrays. The set is fixed by geometry; the starting vertex and
 * winding are implementation choices no consumer depends on
 * (`sutherlandHodgman` re-orients its clip polygon itself, and
 * `polygonCentroid` is orientation-invariant), so pinning them would
 * over-constrain.
 */

const key = (p: Point2): string => `${p[0]},${p[1]}`;
const asSet = (poly: Polygon2): Set<string> => new Set(poly.map(key));

/** > 0 left turn, < 0 right turn, 0 collinear. Independent of the hull code. */
function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * A convex hull must never contain three consecutive collinear vertices —
 * that is exactly the property the `<=` prunes for. Checking it directly
 * catches the regression on ANY input with collinear points, not only the
 * fixtures chosen here.
 */
function hasCollinearRun(poly: Polygon2): boolean {
  if (poly.length < 3) return false;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point2;
    const b = poly[(i + 1) % poly.length] as Point2;
    const c = poly[(i + 2) % poly.length] as Point2;
    if (cross(a, b, c) === 0) return true;
  }
  return false;
}

/**
 * True when every non-collinear turn goes the same way round.
 *
 * That is NOT the same as "convex and not self-crossing", which an earlier
 * version of this comment claimed. Collinear triples are skipped (`c === 0`),
 * and a monotone-chain result always shares one turn sign, so this returns
 * true for the two degenerate outputs the collinear tests below produce — the
 * walk-out-and-back line and the duplicated-corner square. It is a weak
 * invariant that catches a hull with a genuinely inverted turn, and it is not
 * evidence that a self-crossing result would be rejected.
 */
function isConvex(poly: Polygon2): boolean {
  if (poly.length < 3) return true;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = cross(
      poly[i] as Point2,
      poly[(i + 1) % poly.length] as Point2,
      poly[(i + 2) % poly.length] as Point2,
    );
    if (c === 0) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

describe('convexHull2 collinear handling', () => {
  it('drops a point lying on an edge of the hull', () => {
    // The canonical axis-aligned case: a square with an extra point halfway
    // along its bottom edge. The midpoint is ON the hull but is not a vertex
    // OF it. With the pruning weakened it survives as a fifth vertex, and the
    // area is identical either way — which is why nothing downstream notices.
    const hull = convexHull2([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [1, 0],
    ]);
    expect(hull).toHaveLength(4);
    expect(asSet(hull)).toEqual(new Set(['0,0', '2,0', '2,2', '0,2']));
    expect(hasCollinearRun(hull)).toBe(false);
  });

  it('reduces an entirely collinear input to its two extremes', () => {
    // Four points on one line have no area, so the only sensible "hull" is the
    // segment between the extremes. With the pruning weakened this returns six
    // points that walk out along the line and back — a self-crossing shape
    // from a function named convexHull2.
    const hull = convexHull2([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(hull).toHaveLength(2);
    expect(asSet(hull)).toEqual(new Set(['0,0', '3,0']));
  });

  it('collapses duplicated points rather than emitting a bowtie', () => {
    // Repeated vertices are ordinary in meshed geometry, where the same corner
    // arrives from two triangles. Weakened pruning turns this into a nine-point
    // self-intersecting polygon.
    const hull = convexHull2([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
      [2, 0],
    ]);
    expect(hull).toHaveLength(4);
    expect(asSet(hull)).toEqual(new Set(['0,0', '2,0', '2,2', '0,2']));
    expect(isConvex(hull)).toBe(true);
  });

  it('ignores points strictly inside the hull', () => {
    const hull = convexHull2([
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [2, 2],
      [1, 3],
    ]);
    expect(hull).toHaveLength(4);
    expect(asSet(hull)).toEqual(new Set(['0,0', '4,0', '4,4', '0,4']));
  });
});

describe('convexHull2 degenerate inputs', () => {
  it('passes through fewer than three points unchanged', () => {
    // The `points.length < 3` early return was also untested.
    expect(convexHull2([])).toEqual([]);
    expect(convexHull2([[5, 5]])).toEqual([[5, 5]]);
    expect(convexHull2([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });

  it('does not alias the caller array on the early-return path', () => {
    // Scoped to that path on purpose. For length >= 3 the hull DOES alias the
    // caller's point tuples -- they are pushed into the chains and returned as
    // they are -- so a general "copies its input" claim would be false. What
    // stops that mattering is `Point2` being a readonly tuple, not a copy.
    // If it returned the caller's array itself, a downstream mutation of the
    // hull would reach back into the boundary points `shared-faces.ts` holds.
    const input: Point2[] = [[0, 0], [1, 1]];
    const hull = convexHull2(input);
    expect(hull).not.toBe(input);
    expect(hull[0]).not.toBe(input[0]);
  });

  it('handles three points that are already a triangle', () => {
    const hull = convexHull2([[0, 0], [1, 0], [0, 1]]);
    expect(hull).toHaveLength(3);
    expect(asSet(hull)).toEqual(new Set(['0,0', '1,0', '0,1']));
  });

  it('runs the hull on three points rather than passing them through', () => {
    // The triangle case above cannot tell these apart: its fixture is already
    // CCW, so widening the `< 3` early return to `< 4` returns the same three
    // points and the test stays green. Three COLLINEAR points separate them --
    // the early return would hand back all three, the hull keeps two. This is
    // also the above side of the `< 3` boundary; the case above it walks only
    // the below side (0, 1 and 2 points).
    expect(convexHull2([[0, 0], [1, 0], [2, 0]])).toHaveLength(2);
  });
});

describe('convexHull2 invariants hold across shapes', () => {
  // Property assertions rather than fixtures: these catch the regression on
  // any input with collinear points, including ones nobody thought to write
  // down. Each case below carries collinear points on purpose.
  const cases: ReadonlyArray<{ name: string; points: Point2[] }> = [
    { name: 'axis-aligned rectangle with midpoints on every edge', points: [
      [0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5],
    ] },
    { name: 'L-shaped footprint sampled densely along its edges', points: [
      [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [3, 2], [2, 2], [1, 2], [1, 3], [1, 4], [0, 4], [0, 2],
    ] },
    { name: 'a wall face sampled at a fine step', points: [
      [0, 0], [0.1, 0], [0.2, 0], [0.3, 0], [0.3, 2.5], [0.2, 2.5], [0.1, 2.5], [0, 2.5],
    ] },
  ];

  for (const { name, points } of cases) {
    it(`${name}: no three consecutive vertices are collinear`, () => {
      expect(hasCollinearRun(convexHull2(points))).toBe(false);
    });

    it(`${name}: no interior vertex turns the wrong way`, () => {
      expect(isConvex(convexHull2(points))).toBe(true);
    });

    it(`${name}: every vertex came from the input`, () => {
      // The hull may not invent points. Paired with the two properties above,
      // this pins the output without hand-listing an expected polygon.
      const inputKeys = asSet(points);
      for (const v of convexHull2(points)) {
        expect(inputKeys.has(key(v)), `${key(v)} is not an input point`).toBe(true);
      }
    });
  }
});
