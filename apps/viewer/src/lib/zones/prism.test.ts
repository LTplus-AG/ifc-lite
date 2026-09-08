/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prism zones (#2508 item 4).
 *
 * The strongest test here is not a hand-computed number, it is the ORACLE: a
 * rectangular footprint is a box, so the prism integrator and the box
 * integrator must agree to the last bits on every fixture. They share no code
 * (different decomposition, different clip, different weights), so agreement is
 * evidence rather than tautology. The hand-computed cases then pin the cases a
 * box cannot express at all.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  clippedVolumeForPrism,
  compilePrism,
  footprintOverlapsRect,
  isConvexFootprint,
  isPointInFootprint,
  trapezoidsOfFootprint,
  type FootprintPoint,
} from './prism.js';
import { clippedVolumeForZone, meshVolume } from './apportionment.js';
import { compileZone } from './geometry.js';
import type { Zone } from './types.js';

interface Mesh {
  positions: Float64Array;
  indices: Uint32Array;
}

/** Extrude a positively-wound loop from y0 to y1. Same convention as
 *  `apportionment.test.ts`, deliberately: the two files' fixtures have to be
 *  comparable for the oracle below to mean anything. */
function extrudeLoop(loop: Array<[number, number]>, y0: number, y1: number): Mesh {
  const area = loop.reduce((a, [x0, z0], i) => {
    const [x1, z1] = loop[(i + 1) % loop.length];
    return a + (x0 * z1 - x1 * z0);
  }, 0) / 2;
  const l = area < 0 ? [...loop].reverse() : loop;
  const out: number[] = [];
  const n = l.length;
  for (let i = 0; i < n; i++) {
    const [xa, za] = l[i];
    const [xb, zb] = l[(i + 1) % n];
    out.push(xa, y0, za, xa, y1, za, xb, y1, zb);
    out.push(xa, y0, za, xb, y1, zb, xb, y0, zb);
  }
  const [x0, z0] = l[0];
  for (let i = 1; i + 1 < n; i++) {
    const [xa, za] = l[i];
    const [xb, zb] = l[i + 1];
    out.push(x0, y0, z0, xa, y0, za, xb, y0, zb);
    out.push(x0, y1, z0, xb, y1, zb, xa, y1, za);
  }
  const indices = new Uint32Array(out.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions: new Float64Array(out), indices };
}

/** A 6 x 1 x 1 m wall from x = 0..6, z = 0..1, y = 0..1. Volume 6. */
function wall(): Mesh {
  return extrudeLoop([[0, 0], [6, 0], [6, 1], [0, 1]], 0, 1);
}

const EPS = 1e-9;

describe('footprint validation', () => {
  it('accepts a convex polygon and one with collinear vertices', () => {
    assert.equal(isConvexFootprint([[0, 0], [2, 0], [2, 2], [0, 2]]), true);
    // Collinear points are common in a polygon traced off a plan.
    assert.equal(isConvexFootprint([[0, 0], [1, 0], [2, 0], [2, 2], [0, 2]]), true);
  });

  it('rejects a concave polygon, which every test below would silently mis-answer', () => {
    // An L. The chord at some z is TWO intervals, so the trapezoidal sweep, the
    // point test and the SAT overlap are all wrong for it, quietly.
    assert.equal(isConvexFootprint([[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]]), false);
  });

  it('rejects a self-intersecting star, which turns the same way at every vertex', () => {
    // A pentagram traced point to point: every turn has the same sign, so a
    // convexity test built on sign alone accepts it. The sweep would then find
    // more than two spanning edges in a strip and silently report the volume of
    // the HULL, which is the shape the user did not draw.
    const pentagram: FootprintPoint[] = [
      [0, 1], [0.588, -0.809], [-0.951, 0.309], [0.951, 0.309], [-0.588, -0.809],
    ];
    assert.equal(isConvexFootprint(pentagram), false);
    // The convex pentagon through the same five outer points is still accepted,
    // so the check rejects the crossing rather than the vertex count.
    const pentagon: FootprintPoint[] = [
      [0, 1], [0.951, 0.309], [0.588, -0.809], [-0.588, -0.809], [-0.951, 0.309],
    ];
    assert.equal(isConvexFootprint(pentagon), true);
  });

  it('rejects degenerate input rather than treating it as a zone', () => {
    assert.equal(isConvexFootprint([[0, 0], [1, 1]]), false);
    assert.equal(isConvexFootprint([[0, 0], [1, 1], [2, 2]]), false, 'a line has no area');
    assert.equal(isConvexFootprint([[0, 0], [1, 0], [Number.NaN, 1]]), false);
  });
});

describe('trapezoidal decomposition', () => {
  it('gives one strip for a rectangle and two for a diamond', () => {
    assert.equal(trapezoidsOfFootprint([[0, 0], [2, 0], [2, 2], [0, 2]]).length, 1);
    // A diamond has a vertex at mid-height on each side, so the sweep breaks
    // there: below it the chord widens, above it it narrows.
    assert.equal(trapezoidsOfFootprint([[1, 0], [2, 1], [1, 2], [0, 1]]).length, 2);
  });

  it('reports the chord lines of a strip, not just its bounds', () => {
    // The diamond's lower strip runs from the apex at (1,0) outward: lo(z) =
    // 1 - z and hi(z) = 1 + z.
    const [lower] = trapezoidsOfFootprint([[1, 0], [2, 1], [1, 2], [0, 1]]);
    assert.ok(Math.abs(lower.aLo - 1) < EPS && Math.abs(lower.bLo + 1) < EPS, `lo = ${lower.aLo} + ${lower.bLo}z`);
    assert.ok(Math.abs(lower.aHi - 1) < EPS && Math.abs(lower.bHi - 1) < EPS, `hi = ${lower.aHi} + ${lower.bHi}z`);
  });
});

describe('point and rectangle tests', () => {
  const diamond: FootprintPoint[] = [[1, 0], [2, 1], [1, 2], [0, 1]];

  it('places a point by the polygon, not by its bounding box', () => {
    assert.equal(isPointInFootprint(1, 1, diamond), true);
    // Inside the diamond's AABB, outside the diamond: the corner a box zone
    // would wrongly include.
    assert.equal(isPointInFootprint(0.1, 0.1, diamond), false);
  });

  it('overlaps a rectangle by the polygon, not by its bounding box', () => {
    assert.equal(footprintOverlapsRect(0.9, 0.9, 1.1, 1.1, diamond), true);
    assert.equal(footprintOverlapsRect(-0.5, -0.5, 0.2, 0.2, diamond), false);
  });

  it('honours a negative epsilon as a penetration requirement, like the box path', () => {
    const square: FootprintPoint[] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    // Abutting exactly on x = 2: inclusive by default, not a straddle under
    // v1's negative epsilon.
    assert.equal(footprintOverlapsRect(2, 0, 3, 2, square), true);
    assert.equal(footprintOverlapsRect(2, 0, 3, 2, square, -0.001), false);
  });
});

describe('prism volume against the box path (oracle)', () => {
  /** The same region as a box zone and as a rectangular footprint. */
  function bothWays(zone: Zone): { box: number; prism: number } {
    const pieces = [wall()];
    const hx = zone.size[0] / 2;
    const hz = zone.size[2] / 2;
    const [cx, cy, cz] = zone.center;
    const footprint: FootprintPoint[] = [
      [cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz],
    ];
    return {
      box: clippedVolumeForZone(pieces, compileZone(zone)),
      prism: clippedVolumeForPrism(
        pieces,
        compilePrism(footprint, cy - zone.size[1] / 2, cy + zone.size[1] / 2),
      ),
    };
  }

  const cases: Array<[string, Zone]> = [
    ['a zone cutting the wall in two', { id: 'a', name: 'A', center: [1, 0.5, 0.5], size: [4, 4, 4], rotationY: 0 }],
    ['a zone holding all of it', { id: 'b', name: 'B', center: [3, 0.5, 0.5], size: [20, 20, 20], rotationY: 0 }],
    ['a zone holding none of it', { id: 'c', name: 'C', center: [50, 0.5, 0.5], size: [4, 4, 4], rotationY: 0 }],
    ['a zone abutting its end exactly', { id: 'd', name: 'D', center: [9, 0.5, 0.5], size: [6, 4, 4], rotationY: 0 }],
    ['a zone cutting it vertically', { id: 'e', name: 'E', center: [3, 0.25, 0.5], size: [20, 0.5, 4], rotationY: 0 }],
  ];

  for (const [label, zone] of cases) {
    it(`agrees with the box integrator: ${label}`, () => {
      const { box, prism } = bothWays(zone);
      assert.ok(
        Math.abs(box - prism) < 1e-12 * Math.max(1, Math.abs(box)),
        `box ${box} vs prism ${prism}`,
      );
    });
  }
});

describe('prism volume on shapes a box cannot express', () => {
  it('takes a diagonal band by its own edges', () => {
    // A 45-degree band 0.4 m wide across the wall, the same case #2508 uses to
    // show an AABB estimate crediting 20% of a brace to a zone it never
    // enters. As a footprint it is four points; the intersection with the
    // 1 m-deep wall is a parallelogram of area 0.4 * sqrt(2) ... times the
    // wall's 1 m height.
    const c = 3;
    const footprint: FootprintPoint[] = [
      [c - 0.2 * Math.SQRT2, -1], [c + 0.2 * Math.SQRT2, -1],
      [c + 0.2 * Math.SQRT2 + 2, 1], [c - 0.2 * Math.SQRT2 + 2, 1],
    ];
    const volume = clippedVolumeForPrism([wall()], compilePrism(footprint, -1, 2));
    // The band's width along x is constant at 0.4*sqrt(2); it crosses the
    // wall's full 1 m depth and 1 m height inside the wall's own x range.
    assert.ok(Math.abs(volume - 0.4 * Math.SQRT2) < 1e-9, `diagonal band took ${volume}`);
  });

  it('takes a trapezoid whose edges are NOT parallel, so the chord width varies with z', () => {
    // Every other slanted fixture here is a PARALLELOGRAM (the diagonal band's
    // two edges share a slope), which makes `bHi - bLo` zero and the far
    // region's z-slope term vanish; the tiling case above asserts a + b = whole,
    // an identity every divergence-1 field satisfies, so it cannot see the
    // slope either. Between them the integrator's dependence on z was
    // unobservable: `cz` could be forced to 0, or read off the Y component,
    // with the whole suite still green.
    //
    // The box is deliberately 2 m tall and 1 m deep, rather than `wall()`, which
    // is 1 x 1 in (y, z): a square end face has a diagonal triangulation
    // symmetric under swapping y for z, which hides a `cz` that reads the Y
    // component. Unequal extents make that swap observable too.
    //
    // The wedge has lo(z) = 1 and hi(z) = 2 + 2z, so bLo = 0 but bHi = 2 and the
    // chord widens from 1 m at z = 0 to 3 m at z = 1. Its area is the trapezoid
    // (1 + 3)/2 * 1 = 2, and it sits inside the box's x and z range, so the
    // volume taken is 2 * the box's 2 m height = 4.
    const tall = extrudeLoop([[0, 0], [6, 0], [6, 1], [0, 1]], 0, 2);
    const wedge: FootprintPoint[] = [[1, 0], [2, 0], [4, 1], [1, 1]];
    const traps = trapezoidsOfFootprint(wedge);
    // Pin the asymmetry itself: if a future edit made this fixture a
    // parallelogram again the assertion below would go quiet rather than fail.
    assert.ok(
      traps.some((t) => Math.abs(t.bHi - t.bLo) > 0.5),
      `fixture must have non-parallel edges, got ${JSON.stringify(traps)}`,
    );
    const volume = clippedVolumeForPrism([tall], compilePrism(wedge, -1, 3));
    assert.ok(Math.abs(volume - 4) < EPS, `wedge took ${volume}, expected 4`);
  });

  it('counts a face lying exactly on the hi(z) split plane ONCE', () => {
    // The split at hi(z) hands a polygon to the inside branch or the far
    // branch; a polygon lying exactly ON the plane satisfies both keep-tests, so
    // a Sutherland-Hodgman split that kept it on each side would count that face
    // twice. `accumulateTrapezoid` avoids that by testing `maxD <= 0` and
    // `minD >= 0` before it ever splits -- and nothing pinned it, because no
    // fixture put a face on a zone boundary at all, which is the ordinary case
    // in a tiling plan rather than an edge case.
    //
    // This box ends exactly at x = 3 and the footprint's hi edge is x = 3, so
    // the box's far face is coplanar with the split. The zone takes x in [1, 3]
    // of a 3 x 2 x 1 m box: volume 4, and 8 if that face is counted twice.
    const box = extrudeLoop([[0, 0], [3, 0], [3, 1], [0, 1]], 0, 2);
    const flush: FootprintPoint[] = [[1, 0], [3, 0], [3, 1], [1, 1]];
    const volume = clippedVolumeForPrism([box], compilePrism(flush, -1, 3));
    assert.ok(Math.abs(volume - 4) < EPS, `flush face took ${volume}, expected 4`);
  });

  it('sums to the whole across a footprint tiling, which is the invariant that matters', () => {
    // Two triangles that tile the wall's plan exactly, sharing the diagonal.
    const lower: FootprintPoint[] = [[-1, -1], [8, -1], [8, 2]];
    const upper: FootprintPoint[] = [[-1, -1], [8, 2], [-1, 2]];
    const pieces = [wall()];
    const a = clippedVolumeForPrism(pieces, compilePrism(lower, -1, 2));
    const b = clippedVolumeForPrism(pieces, compilePrism(upper, -1, 2));
    const whole = meshVolume(pieces);
    assert.ok(Math.abs(a + b - whole) < 1e-9, `${a} + ${b} != ${whole}`);
    // ... and neither piece is the whole thing, or the test would pass on an
    // integrator that ignored the footprint entirely.
    assert.ok(a > 0.1 && b > 0.1, `degenerate split ${a} / ${b}`);
  });

  it('reports zero for a footprint the element never reaches', () => {
    const away: FootprintPoint[] = [[100, 100], [102, 100], [102, 102]];
    assert.equal(Math.abs(clippedVolumeForPrism([wall()], compilePrism(away, -1, 2))) < 1e-12, true);
  });

  it('is bounded above by the element, whatever the footprint', () => {
    const huge: FootprintPoint[] = [[-100, -100], [100, -100], [100, 100], [-100, 100]];
    const volume = clippedVolumeForPrism([wall()], compilePrism(huge, -100, 100));
    assert.ok(Math.abs(volume - meshVolume([wall()])) < 1e-9, `got ${volume}`);
  });

  it('takes nothing from a prism whose vertical extent misses the element', () => {
    const over: FootprintPoint[] = [[-1, -1], [8, -1], [8, 2], [-1, 2]];
    assert.ok(Math.abs(clippedVolumeForPrism([wall()], compilePrism(over, 10, 12))) < 1e-12);
  });
});

describe('a face all but coincident with a strip boundary (#1155 regime)', () => {
  /** `n` ULPs away from `x`, toward +/-Infinity as `n` is signed. */
  function ulps(x: number, n: number): number {
    const buf = new Float64Array([x]);
    const bits = new BigInt64Array(buf.buffer);
    bits[0] += BigInt(n);
    return buf[0];
  }

  // `clipPlane` used to carry a `t` clamp behind a `|da - db| > 1e-12`
  // denominator guard, ported from the shape of the #1155 fix in
  // `rust/geometry/src/csg/plane_eps.rs`. Nothing in this suite reached that
  // guard: instrumenting the crossing branch over every fixture in
  // `src/lib/zones/*.test.ts` gives 164 crossings whose smallest `|da - db|`
  // is 1 -- twelve orders above the threshold. So the guard was removed, and
  // this is the fixture that puts the suite INSIDE the regime it covered:
  // the far face is tilted across the strip boundary by four ULPs, so
  // twelve of the twenty-four crossings here run with `|da - db| = 3.6e-15`.
  //
  // Removing the guard is safe because `da` and `db` are strictly opposite in
  // sign in that branch, so `t = da / (da - db)` is a positive quantity over a
  // strictly larger one. The precondition is the BAND-FREE classification
  // (`da >= 0`), and this test is what pins it: the box-vs-prism oracle above
  // cannot -- it calls `clipPlane` against mirrored planes, for which any
  // deterministic symmetric rule still tiles the polygon, so it accepts a
  // constant `t` as readily as the real one.
  const box = () => extrudeLoop([[0, 0], [ulps(3, 4), 0], [ulps(3, -4), 1], [0, 1]], 0, 1);
  const flush: FootprintPoint[] = [[1, 0], [3, 0], [3, 1], [1, 1]];

  it('stays finite and bounded by the element when the cut is ULPs from the face', () => {
    const volume = clippedVolumeForPrism([box()], compilePrism(flush, -1, 2));
    assert.ok(Number.isFinite(volume), `non-finite volume ${volume}`);
    const whole = meshVolume([box()]);
    assert.ok(
      Math.abs(volume) <= Math.abs(whole) + EPS,
      `took ${volume} of an element whose whole volume is ${whole}`,
    );
  });

  it('still takes x in [1, 3] of it, so no vertex was reclassified across the plane', () => {
    // An epsilon band in the classification -- the #1155 precondition -- puts
    // the whole far face on the wrong side here and yields 4, more than the
    // element holds. Exact answer: a 3 x 1 x 1 m box, x from 1 to 3.
    const volume = clippedVolumeForPrism([box()], compilePrism(flush, -1, 2));
    assert.ok(Math.abs(volume - 2) < 1e-12, `near-coincident cut took ${volume}, expected 2`);
  });
});
