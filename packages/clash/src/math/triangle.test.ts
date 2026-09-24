/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { WORLD_FRAME_OFFSET_M, ulp32 } from '@ifc-lite/world-frame-fixtures';
import type { Vec3 } from '../types.js';
import { triTriIntersect } from './triangle-intersect.js';
import { triTriDistance } from './triangle-distance.js';

const A0: Vec3 = [0, 0, 0];
const A1: Vec3 = [1, 0, 0];
const A2: Vec3 = [0, 1, 0];

describe('triTriIntersect', () => {
  it('detects a triangle piercing another', () => {
    // Vertical triangle crossing the z=0 plane within triangle A.
    const b0: Vec3 = [0.25, 0.25, -0.5];
    const b1: Vec3 = [0.25, 0.25, 0.5];
    const b2: Vec3 = [0.75, 0.25, 0];
    expect(triTriIntersect(A0, A1, A2, b0, b1, b2)).toBe(true);
  });

  it('reports no intersection for separated triangles', () => {
    const b0: Vec3 = [10, 10, 0];
    const b1: Vec3 = [11, 10, 0];
    const b2: Vec3 = [10, 11, 0];
    expect(triTriIntersect(A0, A1, A2, b0, b1, b2)).toBe(false);
  });

  it('treats bare face contact as non-intersecting (touch)', () => {
    // Coincident copy of A — interiors do not overlap in the SAT sense.
    expect(triTriIntersect(A0, A1, A2, A0, A1, A2)).toBe(false);
  });
});

type Tri = [Vec3, Vec3, Vec3];

/** Adjacent float32 values: `dir = +1` one ULP away from zero, `-1` toward. */
function f32Step(x: number, dir: 1 | -1): number {
  const f = new Float32Array([x]);
  const u = new Uint32Array(f.buffer);
  u[0] = u[0]! + (x >= 0 ? dir : -dir);
  return f[0]!;
}

function crosses(a: Tri, b: Tri): boolean {
  return triTriIntersect(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/** `t` translated by `off` and baked through f32, as ingestion stores it. */
function baked(t: Tri, off: Vec3): Tri {
  return t.map((v) => v.map((c, k) => Math.fround(c + off[k]!)) as unknown as Vec3) as Tri;
}

/** Plane heights spanning six orders of magnitude, none a power of two. */
const HEIGHTS = [0.05, 1.0, 3.3, 100.25, 1000.1, 10_000.3];

function straddlingPair(z0: number): [Tri, Tri] {
  const z = Math.fround(z0);
  return [
    [[0, 0, z], [1, 0, z], [0, 1, z]],
    [[0.2, 0.2, z], [1.2, 0.2, f32Step(z, -1)], [0.2, 1.2, f32Step(z, 1)]],
  ];
}

/** Generic-orientation plane (no axis-aligned normal), baked through f32 so
 *  its vertices are NOT bit-identically coplanar. */
function onRotatedPlane(pts: Array<[number, number]>): Tri {
  const e1 = [0.8, 0.36, 0.48];
  const e2 = [-0.6, 0.48, 0.64];
  const o = [1.7, -2.3, 0.9];
  return pts.map(([u, v]) => [0, 1, 2].map((k) => Math.fround(o[k]! + u * e1[k]! + v * e2[k]!))) as unknown as Tri;
}

/** The two coplanar end faces of `rust/clash/src/world_frame_tests.rs`'s
 *  three-axis-rotated panel and mullion, 20 mm apart in their shared plane:
 *  one triangle of each, verbatim as the session stores them (f32). */
function coplanarEndFaces20mmApart(): [Tri, Tri] {
  const f = (v: Vec3): Vec3 => v.map(Math.fround) as unknown as Vec3;
  return [
    [f([-1.7465223, 2.6160913, 1.2723408]), f([-2.9620407, 2.9383893, 0.45310998]), f([-1.7253773, 2.6576362, 1.25426])],
    [f([-2.2528067, 2.7959137, 0.89986265]), f([-2.4176953, 2.8333476, 0.79304266]), f([-2.333115, 2.999527, 0.7207196])],
  ];
}

/** A pair that ONLY the edge-edge axis `(a1 - a0) x (b2 - b1)` separates,
 *  0.124 apart along it at unit scale. */
function edgeSeparatedPair(scale: number, shiftTowardA: number): [Tri, Tri] {
  const a: Tri = [[0.21, 0.58, 0.07], [-0.62, -0.64, -0.84], [0.65, -0.77, -0.95]];
  const b: Tri = [[0.93, -0.6, 0.79], [-0.83, -0.07, -0.55], [0.66, 0.23, 0.28]];
  const n = [-0.3980124791332504, -0.3589431092237397, 0.8442428032236925];
  return [
    a.map((v) => v.map((c) => c * scale)) as unknown as Tri,
    b.map((v) => v.map((c, k) => (c - shiftTowardA * n[k]!) * scale)) as unknown as Tri,
  ];
}

/**
 * Flush and coplanar contact, scale, and translation (#5406). One-for-one
 * mirror of `rust/clash/src/triangle_tests.rs`: both kernels run the same
 * generated predicate, so this is what proves the TS flattening codemod kept
 * it. The session-level consequences are in `rust/clash/src/world_frame_tests.rs`.
 */
describe('triTriIntersect: contact within f32 noise (#5406)', () => {
  it('does not cross when a triangle straddles the other\'s plane by one ULP', () => {
    // Before #5406 every height reported a crossing: the face-normal axis
    // separated only on an exact `<=` tie, which one ULP breaks.
    for (const z of HEIGHTS) {
      const [a, b] = straddlingPair(z);
      expect(crosses(a, b), `z = ${z}`).toBe(false);
      expect(crosses(b, a), `z = ${z}, swapped`).toBe(false);
    }
  });

  it('still crosses for a genuine shallow crossing at every height', () => {
    // 100 f32 ULPs of the height (the band keeps its unit floor below 1.0).
    for (const z0 of HEIGHTS) {
      const z = Math.fround(z0);
      const tilt = 100 * ulp32(Math.max(z, 1));
      const a: Tri = [[0, 0, z], [1, 0, z], [0, 1, z]];
      const b: Tri = [[0.2, 0.2, z], [1.2, 0.2, z - tilt], [0.2, 1.2, z + tilt]];
      expect(crosses(a, b), `z = ${z0}`).toBe(true);
    }
  });

  it('does not cross for coplanar faces 20 mm apart in their plane', () => {
    // Before #5406: crossed, which turned the session's 20 mm clearance into
    // a -1.38 m hard clash. For coplanar triangles the face normals and every
    // non-degenerate edge-edge axis are the shared normal, along which each
    // triangle projects to a point, so no axis could see the in-plane gap.
    const [a, b] = coplanarEndFaces20mmApart();
    expect(crosses(a, b)).toBe(false);
    expect(crosses(b, a)).toBe(false);
  });

  it('treats coplanar overlap as touch when coplanar only to within f32 rounding', () => {
    const a = onRotatedPlane([[0, 0], [1, 0], [0, 1]]);
    const b = onRotatedPlane([[0.2, 0.2], [1.2, 0.2], [0.2, 1.2]]);
    expect(crosses(a, b)).toBe(false);
  });

  it('finds an edge-edge separating axis at every scale', () => {
    // Before #5406 the absolute `|ea x eb|^2 > 1e-12` dropped every edge axis
    // below ~1 mm edge length, so this read as crossing at 1e-4 scale.
    for (const scale of [1, 1e-2, 1e-4, 1e2]) {
      const [a, b] = edgeSeparatedPair(scale, 0);
      expect(crosses(a, b), `scale ${scale}`).toBe(false);
    }
  });

  it('crosses once the edge-separated pair is moved through itself, at every scale', () => {
    for (const scale of [1, 1e-2, 1e-4, 1e2]) {
      const [a, b] = edgeSeparatedPair(scale, 0.2);
      expect(crosses(a, b), `scale ${scale}`).toBe(true);
    }
  });

  it('keeps every verdict under translation, including 10 km out on an orthogonal axis', () => {
    // A 1 mm Z crossing stays a crossing 10 km out in X, where a
    // max-over-axes band (~2.4 mm) would swallow it.
    const offsets: Vec3[] = [
      [0, 0, 0],
      [WORLD_FRAME_OFFSET_M, 0, 0],
      [7.4, 0, 0],
      [123.456, -45.678, 9.1],
      [0, 1000, 0],
    ];
    const z = 1.0;
    const cases: Array<[string, [Tri, Tri], boolean]> = [
      ['flush straddle', straddlingPair(z), false],
      [
        '1 mm crossing',
        [
          [[0, 0, z], [1, 0, z], [0, 1, z]],
          [[0.2, 0.2, z], [1.2, 0.2, z - 0.001], [0.2, 1.2, z + 0.001]],
        ],
        true,
      ],
      ['coplanar, 20 mm apart', coplanarEndFaces20mmApart(), false],
      ['edge-separated', edgeSeparatedPair(1, 0), false],
      ['edge-separated, moved through', edgeSeparatedPair(1, 0.2), true],
    ];
    for (const [name, [a, b], expected] of cases) {
      for (const off of offsets) {
        expect(crosses(baked(a, off), baked(b, off)), `${name} at ${off}`).toBe(expected);
      }
    }
  });
});

describe('triTriDistance', () => {
  it('measures the gap between parallel triangles', () => {
    const b0: Vec3 = [0, 0, 0.5];
    const b1: Vec3 = [1, 0, 0.5];
    const b2: Vec3 = [0, 1, 0.5];
    const { dist } = triTriDistance(A0, A1, A2, b0, b1, b2);
    expect(dist).toBeCloseTo(0.5, 6);
  });

  it('is zero for touching triangles', () => {
    const { dist } = triTriDistance(A0, A1, A2, A0, A1, A2);
    expect(dist).toBeCloseTo(0, 6);
  });

  it('measures a clean edge-to-edge gap', () => {
    // Triangle B starts at x = 3; nearest features (A max x = 1, B min x = 3) are 2.0 apart.
    const b0: Vec3 = [3, 0, 0];
    const b1: Vec3 = [4, 0, 0];
    const b2: Vec3 = [3, 1, 0];
    const { dist } = triTriDistance(A0, A1, A2, b0, b1, b2);
    expect(dist).toBeCloseTo(2, 6);
  });
});
