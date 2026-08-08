/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact-value pins for the two BVH-driven point probes, `containsPoint` and
 * `distanceToSurface`.
 *
 * The literals below are the values the pre-BVH linear scans produced, to the
 * last bit, and `rust/clash/src/kernel_tests.rs::probe_fixture_matches_the_ts_kernel`
 * asserts the SAME literals on the SAME fixture. Two things are pinned at once:
 * that BVH traversal did not change the answer, and that the TS and Rust
 * kernels still agree bit-for-bit (`toBe` on a number is `Object.is`, so a
 * one-ulp drift fails — the differential suite's 1e-6 epsilon would not catch
 * it). Keep the two fixtures in lockstep.
 *
 * The prism is deliberately not axis-aligned on one face, so the slanted face
 * makes most of the expected distances irrational and a wrong-but-close
 * candidate set cannot coincidentally reproduce them.
 */

import { describe, expect, it } from 'vitest';
import { TriMesh } from './tri-mesh.js';
import type { Vec3 } from '../types.js';
import { closestPtPointTriangle } from '../math/triangle-distance.js';
import { distSq } from '../math/vec3.js';

/** Triangular prism: footprint (0,0)-(2,0)-(0,2), extruded z 0 → 1. */
const PRISM_POSITIONS = new Float32Array([
  0, 0, 0, 2, 0, 0, 0, 2, 0,
  0, 0, 1, 2, 0, 1, 0, 2, 1,
]);
const PRISM_INDICES = new Uint32Array([
  0, 1, 2, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5,
]);

/** `[point, inside, distanceToSurface]` — shared with the Rust fixture. */
const PROBES: ReadonlyArray<readonly [Vec3, boolean, number]> = [
  // Closest feature is the slanted face → irrational.
  [[0.9, 0.85, 0.5], true, 0.17677669529663689],
  // Closest feature is the x = 0 face → exact.
  [[0.3, 0.4, 0.5], true, 0.29999999999999999],
  // Outside, past the slanted face.
  [[1.5, 1.5, 0.5], false, 0.70710678118654757],
  // Inside, closest to the z = 0 cap (a different closest-point branch).
  [[0.05, 0.05, 0.02], true, 0.02],
  // Outside and above: closest feature is the slanted face's top EDGE.
  [[1.9, 1.9, 1.5], false, 1.3674794331177342],
  // Outside along -x, closest to the x = 0 face's interior.
  [[-0.75, 0.125, 0.5], false, 0.75],
];

describe('TriMesh point probes', () => {
  const mesh = new TriMesh(PRISM_POSITIONS, PRISM_INDICES);

  for (const [p, inside, distance] of PROBES) {
    it(`containsPoint ${JSON.stringify(p)} === ${inside}`, () => {
      expect(mesh.containsPoint(p)).toBe(inside);
    });

    it(`distanceToSurface ${JSON.stringify(p)} is exact`, () => {
      expect(mesh.distanceToSurface(p)).toBe(distance);
    });
  }

  it('finds a near triangle the seed cube missed, behind a wide-AABB decoy', () => {
    // The DECOY is one big slanted triangle whose AABB swallows the probe cube
    // while its surface sits 0.548 away. The real nearest surface is a fine grid
    // at z = 0.435, OUTSIDE the seed cube (half-size 0.29 for this extent and
    // triangle count). So the first candidate set contains only the decoy and its
    // minimum, 0.548, is NOT the answer — the widened second query at half-size
    // 0.548 is what pulls in the grid. Every expectation is checked against a
    // brute-force scan, so returning the decoy's distance fails.
    const A = 0.95;
    const SPAN = 1.16;
    const Z = 0.435;
    const positions: number[] = [-A, -A, -A, A, -A, A, -A, A, A];
    const indices: number[] = [0, 1, 2];
    const k = 16;
    const base = 3;
    for (let j = 0; j <= k; j += 1) {
      for (let i = 0; i <= k; i += 1) {
        positions.push(-SPAN + (2 * SPAN * i) / k, -SPAN + (2 * SPAN * j) / k, Z);
      }
    }
    for (let j = 0; j < k; j += 1) {
      for (let i = 0; i < k; i += 1) {
        const p0 = base + j * (k + 1) + i;
        indices.push(p0, p0 + 1, p0 + k + 2, p0, p0 + k + 2, p0 + k + 1);
      }
    }
    const mesh = new TriMesh(new Float32Array(positions), new Uint32Array(indices));
    expect(mesh.count).toBe(513);

    const scan = (p: Vec3): number => {
      let best = Infinity;
      for (let t = 0; t < mesh.count; t += 1) {
        const [a, b, c] = mesh.tri(t);
        const q = closestPtPointTriangle(p, a, b, c);
        const d2 = distSq(p, q);
        if (d2 < best) best = d2;
      }
      return Math.sqrt(best);
    };

    // The probe that discriminates: the answer must be the grid (~0.435), not
    // the decoy (~0.548) the seed cube found first.
    const centre: Vec3 = [0, 0, 0];
    expect(mesh.distanceToSurface(centre)).toBe(scan(centre));
    expect(mesh.distanceToSurface(centre)).toBeLessThan(0.5);

    for (const p of [[0.1, -0.2, 0.05], [0, 0, -0.8], [0.4, 0.4, 0.3], [9, 9, 9]] as Vec3[]) {
      expect(mesh.distanceToSurface(p)).toBe(scan(p));
    }
  });

  it('reports Infinity for an empty mesh', () => {
    const empty = new TriMesh(new Float32Array(), new Uint32Array());
    expect(empty.distanceToSurface([0, 0, 0])).toBe(Infinity);
    expect(empty.containsPoint([0, 0, 0])).toBe(false);
  });
});
