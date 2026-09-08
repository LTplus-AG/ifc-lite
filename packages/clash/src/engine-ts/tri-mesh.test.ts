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
import { RAY_DIR, RAY_EPS, TriMesh } from './tri-mesh.js';
import type { Vec3 } from '../types.js';
import { closestPtPointTriangle } from '../math/triangle-distance.js';
import { cross, dot, sub } from '../math/vec3.js';
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

/**
 * Brute-force `containsPoint`: the SAME Möller–Trumbore crossing count, over
 * EVERY triangle instead of the BVH's candidate set. This is the oracle the
 * BVH acceleration never had — `distanceToSurface` has one (the `scan` above,
 * and `kernel_tests.rs:465`), but `containsPoint`'s "the candidate set is a
 * superset of what a linear scan would count" was asserted only in a doc
 * comment, so nothing in the suite would have noticed the traversal starting
 * to prune a triangle the ray really hits.
 *
 * Built once per mesh rather than evaluated per probe. `e1`, `e2`, `pv`, `det`
 * and `1 / det` depend only on the triangle, so hoisting them out of the probe
 * loop leaves exactly the same arithmetic on exactly the same operands — the
 * per-probe expressions below are character-for-character the originals, in the
 * same association order as `math/vec3.ts` (`dot` sums left to right), so every
 * verdict is bit-identical. What it removes is the work: the sphere fixture is
 * ~32 000 probes x 2048 triangles, and re-deriving those terms — each through a
 * tuple-allocating `sub`/`cross` — made the sweep GC-bound. It ran in ~7.6s on
 * a dev machine but 108.8s on a contended CI runner, blowing the 60s budget
 * (CI run 31946652782). Flat typed arrays and no per-probe allocation put the
 * margin back.
 */
function makeContainsPointScan(mesh: TriMesh): (p: Vec3) => boolean {
  const n = mesh.count;
  const v0s = new Float64Array(n * 3);
  const e1s = new Float64Array(n * 3);
  const e2s = new Float64Array(n * 3);
  const pvs = new Float64Array(n * 3);
  const invs = new Float64Array(n);
  // NaN marks "ray parallel to this triangle" — the original's `continue`.
  invs.fill(Number.NaN);
  for (let t = 0; t < n; t += 1) {
    const [v0, v1, v2] = mesh.tri(t);
    const e1 = sub(v1, v0);
    const e2 = sub(v2, v0);
    const pv = cross(RAY_DIR, e2);
    const det = dot(e1, pv);
    if (det > -RAY_EPS && det < RAY_EPS) continue;
    const o = t * 3;
    v0s[o] = v0[0]; v0s[o + 1] = v0[1]; v0s[o + 2] = v0[2];
    e1s[o] = e1[0]; e1s[o + 1] = e1[1]; e1s[o + 2] = e1[2];
    e2s[o] = e2[0]; e2s[o + 1] = e2[1]; e2s[o + 2] = e2[2];
    pvs[o] = pv[0]; pvs[o + 1] = pv[1]; pvs[o + 2] = pv[2];
    invs[t] = 1 / det;
  }
  const [rx, ry, rz] = RAY_DIR;
  return (p: Vec3): boolean => {
    const [px, py, pz] = p;
    let crossings = 0;
    for (let t = 0; t < n; t += 1) {
      const inv = invs[t];
      if (Number.isNaN(inv)) continue;
      const o = t * 3;
      const tvx = px - v0s[o];
      const tvy = py - v0s[o + 1];
      const tvz = pz - v0s[o + 2];
      const u = (tvx * pvs[o] + tvy * pvs[o + 1] + tvz * pvs[o + 2]) * inv;
      if (u < 0 || u > 1) continue;
      const e1x = e1s[o];
      const e1y = e1s[o + 1];
      const e1z = e1s[o + 2];
      const qvx = tvy * e1z - tvz * e1y;
      const qvy = tvz * e1x - tvx * e1z;
      const qvz = tvx * e1y - tvy * e1x;
      const v = (rx * qvx + ry * qvy + rz * qvz) * inv;
      if (v < 0 || u + v > 1) continue;
      if ((e2s[o] * qvx + e2s[o + 1] * qvy + e2s[o + 2] * qvz) * inv > RAY_EPS) crossings += 1;
    }
    return (crossings & 1) === 1;
  };
}

/** Closed UV sphere, radius `r`, `lon` segments x `lat` rings: `lon*(2*lat-2)`
 * triangles — a mesh whose triangles are small relative to the whole, so the
 * BVH actually has something to prune (a 12-triangle box does not). */
function uvSphere(r: number, lon: number, lat: number): TriMesh {
  const pos: number[] = [];
  for (let j = 0; j < lat; j += 1) {
    const phi = (Math.PI * j) / (lat - 1);
    for (let i = 0; i < lon; i += 1) {
      const th = (2 * Math.PI * i) / lon;
      pos.push(r * Math.sin(phi) * Math.cos(th), r * Math.sin(phi) * Math.sin(th), r * Math.cos(phi));
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < lat - 1; j += 1) {
    for (let i = 0; i < lon; i += 1) {
      const a = j * lon + i;
      const b = j * lon + ((i + 1) % lon);
      const c = a + lon;
      const d = b + lon;
      // Both quad halves on every ring, poles included: the pole rings' outer
      // triangle is zero-area, which Möller–Trumbore's parallel-reject drops
      // in the BVH path and the scan alike, so the count stays exactly
      // `lon * (lat - 1) * 2`.
      idx.push(a, b, d, a, d, c);
    }
  }
  return new TriMesh(new Float32Array(pos), new Uint32Array(idx));
}

/** Closed CONCAVE L-prism: the L footprint extruded z = 0..1. Concavity means
 * the ray can re-enter, so the crossing count is genuinely > 1 and a dropped
 * candidate flips the parity rather than being masked. */
function lPrism(): TriMesh {
  const fp: [number, number][] = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
  const pos: number[] = [];
  for (const [x, y] of fp) pos.push(x, y, 0);
  for (const [x, y] of fp) pos.push(x, y, 1);
  const idx: number[] = [];
  for (let k = 1; k < 5; k += 1) idx.push(0, k + 1, k, 6, 6 + k, 6 + k + 1); // caps (fans)
  for (let k = 0; k < 6; k += 1) {
    const a = k;
    const b = (k + 1) % 6;
    idx.push(a, b, 6 + b, a, 6 + b, 6 + a);
  }
  return new TriMesh(new Float32Array(pos), new Uint32Array(idx));
}

describe('containsPoint against a brute-force oracle', () => {
  // Deterministic LCG: the sweep must be the same 40 000 probes on every run.
  let seed = 987654321;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  it.each([
    ['2048-triangle sphere', () => { const m = uvSphere(1, 32, 33); expect(m.count).toBe(2048); return m; }, [-1.3, -1.3, -1.3], [2.6, 2.6, 2.6]],
    ['concave L-prism', () => lPrism(), [-0.3, -0.3, -0.3], [2.6, 2.6, 1.6]],
  ] as [string, () => TriMesh, Vec3, Vec3][])(
    'agrees with an exhaustive scan on %s, over 20k random points and every vertex',
    (_name, build, origin, span) => {
      const mesh = build();
      const containsPointByScan = makeContainsPointScan(mesh);
      let probes = 0;
      let mismatches = 0;
      let inside = 0;
      // One `expect` per probe costs more than the scan itself, so tally and
      // assert once — a single mismatch still fails the test.
      const check = (p: Vec3) => {
        const got = mesh.containsPoint(p);
        if (got !== containsPointByScan(p)) mismatches += 1;
        if (got) inside += 1;
        probes += 1;
      };
      for (let n = 0; n < 20000; n += 1) {
        check([origin[0] + rnd() * span[0], origin[1] + rnd() * span[1], origin[2] + rnd() * span[2]]);
      }
      // Every triangle vertex nudged just off the surface in z: the grazing
      // cases, where a pruned candidate is likeliest to change the parity.
      for (let t = 0; t < mesh.count; t += 1) {
        for (const vert of mesh.tri(t)) {
          check([vert[0], vert[1], vert[2] + 1e-9]);
          check([vert[0], vert[1], vert[2] - 1e-9]);
        }
      }
      expect(mismatches).toBe(0);
      expect(probes).toBeGreaterThan(20000);
      // Guard against a vacuous sweep: the probe cloud must straddle the
      // surface, or "0 mismatches" would only prove both sides say `false`.
      expect(inside).toBeGreaterThan(1000);
      expect(inside).toBeLessThan(probes - 1000);
    },
    // 32 288 probes x an all-triangle scan each. ~0.2s on a dev machine with
    // the hoisted oracle above; the budget is sized for a contended CI runner,
    // which was measured ~14x slower on this sweep.
    60_000,
  );
});
