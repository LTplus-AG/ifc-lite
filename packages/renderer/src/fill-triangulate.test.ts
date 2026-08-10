/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  earClip,
  groupRingsByNesting,
  joinHoles,
  signedRingArea,
  triangulateRings,
  type Pt,
} from './fill-triangulate.js';

/**
 * Issue #2516. The shared cut-cap / IfcAnnotationFillArea triangulator did not
 * subtract holes: a 4x4 square with a 2x2 hole came out at area 2 instead of
 * 12, so every section cut through a wall opening or a slab void rendered a
 * near-empty cap.
 *
 * Area is the assertion of record here because it is the one number that
 * distinguishes all three behaviours at once:
 *
 *   2  — the shipped bug (the bridged ring deadlocks the ear clipper)
 *   20 — the naive "flip the hole's winding" fix (hole ADDED, not subtracted)
 *   12 — correct
 *
 * The nested cases exist so an implementation that special-cases one level of
 * holes cannot pass by luck: with even-odd nesting an island inside a hole is
 * solid again, which no single-level rule produces.
 */

function P(pts: Array<[number, number]>): Pt[] {
  return pts.map(([x, z]) => ({ x, z }));
}

function triangulatedArea(points: readonly Pt[], triangles: readonly number[][]): number {
  let sum = 0;
  for (const [i, j, k] of triangles) {
    const a = points[i];
    const b = points[j];
    const c = points[k];
    sum += Math.abs((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)) / 2;
  }
  return sum;
}

function areaOf(rings: Pt[][]): number {
  const { points, triangles } = triangulateRings(rings);
  return triangulatedArea(points, triangles);
}

/** Even-odd containment, computed straight from the rings — the oracle the
 *  triangulation has to agree with pointwise, not just in total area. */
function evenOddInside(p: Pt, rings: readonly Pt[][]): boolean {
  let crossings = 0;
  for (const ring of rings) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (
        a.z > p.z !== b.z > p.z &&
        p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
      ) {
        inside = !inside;
      }
    }
    if (inside) crossings++;
  }
  return crossings % 2 === 1;
}

/** How many emitted triangles strictly contain `p`. */
function coverCount(p: Pt, points: readonly Pt[], triangles: readonly number[][]): number {
  let n = 0;
  for (const [i, j, k] of triangles) {
    const a = points[i];
    const b = points[j];
    const c = points[k];
    const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(det) < 1e-15) continue;
    const l1 = ((b.z - c.z) * (p.x - c.x) + (c.x - b.x) * (p.z - c.z)) / det;
    const l2 = ((c.z - a.z) * (p.x - c.x) + (a.x - c.x) * (p.z - c.z)) / det;
    const l3 = 1 - l1 - l2;
    if (l1 > 1e-7 && l2 > 1e-7 && l3 > 1e-7) n++;
  }
  return n;
}

const SQUARE_4 = P([
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
]);
const HOLE_2 = P([
  [1, 1],
  [1, 3],
  [3, 3],
  [3, 1],
]);

describe('triangulateRings — holes are subtracted (#2516)', () => {
  it('gives a 4x4 square with a 2x2 hole its exact analytic area of 12', () => {
    const area = areaOf([SQUARE_4, HOLE_2]);
    assert.ok(
      Math.abs(area - 12) < 1e-6,
      `square-with-hole triangulated to ${area}; 2 = the #2516 bug, ` +
        `20 = the hole added instead of subtracted, 12 = correct`,
    );
  });

  it('leaves a hole-free profile byte-identical: same vertices, same order', () => {
    const { points, triangles } = triangulateRings([SQUARE_4]);
    assert.deepStrictEqual(points, SQUARE_4, 'hole-free rings must pass through untouched');
    assert.strictEqual(triangles.length, 2);
    assert.ok(Math.abs(triangulatedArea(points, triangles) - 16) < 1e-6);
  });

  it('keeps a concave hole-free cross-section at its true area', () => {
    // L-shape, area 3 of a 2x2 bounding box.
    const l = P([
      [0, 0],
      [2, 0],
      [2, 1],
      [1, 1],
      [1, 2],
      [0, 2],
    ]);
    assert.ok(Math.abs(areaOf([l]) - 3) < 1e-6);
  });

  it('fills an island inside a hole (even-odd, not one level of holes)', () => {
    const outer = P([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    const hole = P([
      [2, 2],
      [2, 8],
      [8, 8],
      [8, 2],
    ]);
    const island = P([
      [4, 4],
      [4, 6],
      [6, 6],
      [6, 4],
    ]);
    // 100 - 36 + 4. A rule that treats "every ring after the first" as a hole
    // yields 100 - 36 - 4 = 60; the shipped bug yields ~2.
    const area = areaOf([outer, hole, island]);
    assert.ok(Math.abs(area - 68) < 1e-6, `nested island area was ${area}, expected 68`);
  });

  it('alternates fill and void four rings deep', () => {
    const rings = [1, 2, 3, 4].map((_, i) => {
      const d = i;
      return P([
        [d, d],
        [10 - d, d],
        [10 - d, 10 - d],
        [d, 10 - d],
      ]);
    });
    // 100 - 64 + 36 - 16.
    assert.ok(Math.abs(areaOf(rings) - 56) < 1e-6);
  });

  it('does not care which winding the caller supplies', () => {
    const cwOuter = P([
      [0, 4],
      [4, 4],
      [4, 0],
      [0, 0],
    ]);
    const cwHole = P([
      [1, 1],
      [3, 1],
      [3, 3],
      [1, 3],
    ]);
    for (const rings of [
      [SQUARE_4, HOLE_2],
      [SQUARE_4, cwHole],
      [cwOuter, HOLE_2],
      [cwOuter, cwHole],
    ]) {
      assert.ok(Math.abs(areaOf(rings) - 12) < 1e-6);
    }
  });

  it('does not care which order the rings arrive in', () => {
    assert.ok(Math.abs(areaOf([HOLE_2, SQUARE_4]) - 12) < 1e-6);
  });

  it('treats two disjoint rings as two filled boundaries, not one holed one', () => {
    const a = P([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ]);
    const b = P([
      [5, 5],
      [7, 5],
      [7, 7],
      [5, 7],
    ]);
    assert.ok(Math.abs(areaOf([a, b]) - 8) < 1e-6);
  });

  it('subtracts a hole flush against the outer edge', () => {
    const flush = P([
      [2, 1],
      [2, 3],
      [4, 3],
      [4, 1],
    ]);
    assert.ok(Math.abs(areaOf([SQUARE_4, flush]) - 12) < 1e-6);
  });

  it('subtracts two separate holes', () => {
    const outer = P([
      [0, 0],
      [10, 0],
      [10, 6],
      [0, 6],
    ]);
    const h1 = P([
      [1, 1],
      [1, 3],
      [3, 3],
      [3, 1],
    ]);
    const h2 = P([
      [5, 1],
      [5, 3],
      [7, 3],
      [7, 1],
    ]);
    assert.ok(Math.abs(areaOf([outer, h1, h2]) - 52) < 1e-6);
  });

  it('drops rings with fewer than 3 vertices instead of corrupting the result', () => {
    const stub = P([
      [1, 1],
      [2, 2],
    ]);
    assert.ok(Math.abs(areaOf([SQUARE_4, stub]) - 16) < 1e-6);
    assert.deepStrictEqual(triangulateRings([stub]).triangles, []);
    assert.deepStrictEqual(triangulateRings([]).triangles, []);
  });

  it('covers every interior point exactly once and no exterior point at all', () => {
    // Area alone cannot tell "right total, overlapping triangles + gaps" from
    // "right tessellation". Sampling can.
    const rings = [SQUARE_4, HOLE_2];
    const { points, triangles } = triangulateRings(rings);
    let seed = 987654321;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let s = 0; s < 4000; s++) {
      const p = { x: -1 + rnd() * 6, z: -1 + rnd() * 6 };
      const want = evenOddInside(p, rings) ? 1 : 0;
      assert.strictEqual(
        coverCount(p, points, triangles),
        want,
        `point (${p.x}, ${p.z}) covered wrongly`,
      );
    }
  });

  it('holds on a fuzz of concave star boundaries with concave star holes', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const star = (cx: number, cz: number, r0: number, r1: number, n: number): Pt[] => {
      const pts: Pt[] = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        const r = i % 2 === 0 ? r1 : r0 + rnd() * (r1 - r0);
        pts.push({ x: cx + Math.cos(t) * r, z: cz + Math.sin(t) * r });
      }
      return pts;
    };
    const centres: Array<[number, number]> = [
      [-2.4, -1.8],
      [2.4, -1.8],
      [0, 2.4],
    ];

    for (let iter = 0; iter < 200; iter++) {
      const outer = star(0, 0, 6, 10, 6 + Math.floor(rnd() * 10) * 2);
      const rings = [outer];
      const holeCount = Math.floor(rnd() * 3);
      for (let h = 0; h < holeCount; h++) {
        rings.push(star(centres[h][0], centres[h][1], 0.8, 1.6, 4 + Math.floor(rnd() * 4) * 2));
      }
      let expected = Math.abs(signedRingArea(outer));
      for (let h = 1; h < rings.length; h++) expected -= Math.abs(signedRingArea(rings[h]));
      const got = areaOf(rings);
      assert.ok(
        Math.abs(got - expected) < 1e-6 * Math.max(1, expected),
        `iter ${iter} (${holeCount} holes): area ${got}, expected ${expected}`,
      );
    }
  });
});

describe('triangulateRings — degradation on malformed rings', () => {
  /**
   * The ear clipper can run out of ears on a ring that is not simple. It then
   * returns a PARTIAL fill rather than throwing. These inputs are all
   * schema-illegal (IFC requires inner bounds to be contained in their outer
   * bound, and rings not to self-intersect), so there is no correct answer to
   * assert — what is pinned here is the failure MODE.
   *
   * Note what is deliberately NOT claimed: that the degradation only ever
   * omits area. It does for an inner bound that pokes out of its outer bound,
   * but NOT for a self-intersecting ring — a bow-tie triangulates to 16 where
   * even-odd says 8, because ear clipping reads "inside" from the ring's
   * normalised orientation rather than from crossing parity. Asserting
   * one-sidedness here would be asserting something false.
   *
   * What does hold, and is what a render thread actually needs, is that every
   * one of these RETURNS, in bounded time, with finite geometry that stays
   * inside the input's own extent.
   */
  const malformed: Array<[string, Pt[][]]> = [
    [
      'inner bound pokes outside its outer bound',
      [SQUARE_4, P([[3, 3], [6, 3], [6, 6], [3, 6]])],
    ],
    ['self-intersecting bow-tie', [P([[0, 0], [4, 4], [4, 0], [0, 4]])]],
    [
      'two overlapping inner bounds',
      [
        P([[0, 0], [10, 0], [10, 10], [0, 10]]),
        P([[2, 2], [6, 2], [6, 6], [2, 6]]),
        P([[4, 4], [8, 4], [8, 8], [4, 8]]),
      ],
    ],
    ['ring that doubles back on itself', [P([[0, 0], [10, 0], [10, 10], [5, 10], [5, 5], [5, 10], [0, 10]])]],
    ['fully collinear ring', [P([[0, 0], [1, 0], [2, 0], [3, 0]])]],
  ];

  for (const [name, rings] of malformed) {
    it(`degrades inside the input's own extent: ${name}`, () => {
      const { points, triangles } = triangulateRings(rings);
      const covered = triangulatedArea(points, triangles);
      assert.ok(Number.isFinite(covered), 'degraded output must still be finite');

      // Every emitted vertex has to be one of the input's own, so a stalled
      // clipper can only ever under-report — it can never invent geometry
      // somewhere else on the plane.
      const all = rings.flat();
      for (const p of points) {
        assert.ok(
          all.some((q) => q.x === p.x && q.z === p.z),
          `emitted vertex (${p.x}, ${p.z}) is not an input vertex`,
        );
      }

      // And it cannot cover more than the bounding box it was handed.
      const xs = all.map((p) => p.x);
      const zs = all.map((p) => p.z);
      const bbox =
        (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
      assert.ok(covered <= bbox + 1e-9, `covered ${covered} exceeds the bbox ${bbox}`);
    });
  }

  it('terminates on a ring built to starve the ear clipper', () => {
    // 200 vertices spiralling into themselves. The guard here is that the test
    // returns at all: an unbounded retry loop would hang the render thread.
    const spiral: Pt[] = [];
    for (let i = 0; i < 200; i++) {
      const t = (i / 200) * Math.PI * 12;
      const r = 10 - i * 0.045;
      spiral.push({ x: Math.cos(t) * r, z: Math.sin(t) * r });
    }
    const { points, triangles } = triangulateRings([spiral]);
    assert.ok(Number.isFinite(triangulatedArea(points, triangles)));
  });
});

describe('groupRingsByNesting', () => {
  it('reads depth, not arrival order, when deciding what is a hole', () => {
    const outer = P([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    const hole = P([
      [2, 2],
      [2, 8],
      [8, 8],
      [8, 2],
    ]);
    const island = P([
      [4, 4],
      [4, 6],
      [6, 6],
      [6, 4],
    ]);
    const groups = groupRingsByNesting([island, hole, outer]);
    assert.strictEqual(groups.length, 2, 'outer and island are both filled boundaries');
    const withHole = groups.find((g) => g.holes.length === 1);
    assert.ok(withHole, 'the depth-0 ring must own the depth-1 ring as a hole');
    assert.strictEqual(Math.abs(signedRingArea(withHole.outer)), 100);
    assert.strictEqual(Math.abs(signedRingArea(withHole.holes[0])), 36);
    const islandGroup = groups.find((g) => g.holes.length === 0);
    assert.ok(islandGroup);
    assert.strictEqual(Math.abs(signedRingArea(islandGroup.outer)), 4);
  });
});

describe('joinHoles + earClip', () => {
  it('bridges the hole in with exactly two duplicated vertices', () => {
    const stitched = joinHoles(SQUARE_4, [HOLE_2]);
    // 4 outer + 4 hole + 2 bridge duplicates.
    assert.strictEqual(stitched.length, 10);
  });

  it('clips the bridged ring rather than stalling on the bridge duplicates', () => {
    // The #2516 root cause: the old ear test let a vertex sitting exactly ON a
    // candidate ear veto it, and the bridge puts two such vertices in the ring,
    // so the clipper emitted 1 triangle out of 8 and stopped.
    const stitched = joinHoles(SQUARE_4, [HOLE_2]);
    const tris = earClip(stitched);
    assert.strictEqual(tris.length, stitched.length - 2, 'a simple n-gon has n-2 triangles');
    assert.ok(Math.abs(triangulatedArea(stitched, tris) - 12) < 1e-6);
  });

  it('emits counter-clockwise triangles whatever the ring winding is', () => {
    // A 3-vertex fast path used to return the caller's index order unchanged,
    // so a clockwise TRIANGLE came back clockwise while a clockwise quad came
    // back counter-clockwise. Nothing renders differently today (both cap
    // pipelines are cullMode 'none') but anything deriving a facing direction
    // from these indices would read one of the two backwards.
    const orientationOf = (ring: Pt[], tri: number[]): number => {
      const [i, j, k] = tri;
      const a = ring[i];
      const b = ring[j];
      const c = ring[k];
      return Math.sign((b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z));
    };
    const rings: Array<[string, Pt[]]> = [
      ['CW triangle', P([[0, 0], [0, 4], [4, 0]])],
      ['CCW triangle', P([[0, 0], [4, 0], [0, 4]])],
      ['CW quad', P([[0, 0], [0, 4], [4, 4], [4, 0]])],
      ['CCW quad', SQUARE_4],
      ['CW concave L', P([[0, 0], [0, 2], [1, 2], [1, 1], [2, 1], [2, 0]])],
    ];
    for (const [name, ring] of rings) {
      const tris = earClip(ring);
      assert.ok(tris.length > 0, `${name} produced no triangles`);
      for (const tri of tris) {
        assert.strictEqual(orientationOf(ring, tri), 1, `${name} emitted a non-CCW triangle`);
      }
    }
  });

  it('returns the ring untouched when there are no holes', () => {
    assert.strictEqual(joinHoles(SQUARE_4, []), SQUARE_4);
  });

  it('reports ring winding by signed area', () => {
    assert.ok(signedRingArea(SQUARE_4) > 0);
    assert.strictEqual(signedRingArea(SQUARE_4), 16);
    assert.strictEqual(signedRingArea(SQUARE_4.slice().reverse()), -16);
  });
});
