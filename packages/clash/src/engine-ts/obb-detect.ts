/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Box RECOGNITION: deciding whether a triangle mesh is a rectangular box and
 * recovering its frame. Split out of `obb.ts` (which keeps the penetration
 * DEPTH half) when #5355 pushed that file past the module-size limit; the two
 * halves have no shared state and only `Obb`/`OBB_EPS` in common.
 *
 * Kept bit-identical to the Rust twin, `rust/clash/src/obb_detect.rs`.
 */

import type { Vec3 } from '../types.js';
import { sub, cross, dot } from '../math/vec3.js';
import { OBB_EPS, type MeshLike, type Obb } from './obb.js';

function normalize(v: Vec3): Vec3 | null {
  const len = Math.sqrt(dot(v, v));
  if (!(len > OBB_EPS)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** Flip `n` so its largest-magnitude component is positive, so a face and its
 * antipodal opposite face collapse to the same canonical axis direction. Ties
 * broken in x, y, z order — identical to the Rust `canonical`. */
function canonical(n: Vec3): Vec3 {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  let idx = 0;
  if (ay > ax && ay >= az) idx = 1;
  else if (az > ax && az > ay) idx = 2;
  return n[idx] < 0 ? [-n[0], -n[1], -n[2]] : n;
}

/**
 * f32-ULP scale factor for a "worst-case" single-precision coordinate: for a
 * value with magnitude in `[2, 4)` the true float32 ULP is `2^-22`, and for
 * larger magnitudes the ULP only grows. Same constant (and reasoning) as
 * `F32_ULP_SCALE` in `./depth.js`, and unlike the copies in `../contact/` it
 * really is scaling the same quantity — the f32 quantisation of the same
 * vertex buffer. It is still local because `./depth.js` imports THIS module
 * (`obbPenetration`, `isThroughPenetration`), so importing the constant
 * back out of it would close an import cycle for a one-line literal.
 */
const F32_ULP_SCALE = 1 / 4_194_304; // 2^-22

/**
 * Bound, in radians, on the direction error of a face normal computed as
 * `cross(b - a, c - a)` from vertices that arrived as f32.
 *
 * The vertices carry an absolute coordinate error of about
 * `max|coord| * 2^-22` (`F32_ULP_SCALE`, the same f32-ULP bound the
 * penetration floor uses), so each edge does too. `|cross| = |e1||e2|sin t`,
 * and perturbing the edges by `d` tilts the normal by at most
 * `d * (|e1| + |e2|) / |cross|`. The denominator makes this a property of the
 * TRIANGLE's conditioning rather than a constant: a sliver, or a face with
 * one very short edge, resolves its normal far less sharply than a
 * well-shaped one at the same distance from the origin.
 *
 * This is the quantity an absolute `OBB_EPS` was standing in for, and a fixed
 * bound is simultaneously too loose near the origin and far too tight away
 * from it: a 0.05 m thick panel 1 km out resolves its normals to ~2.7e-4, so
 * `|dot|` between two genuinely perpendicular faces exceeded `1e-6` and the
 * box stopped being recognised as a box purely because it had been
 * translated (#5355).
 */
function normalAngleError(a: Vec3, b: Vec3, c: Vec3): number {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  let maxAbs = 0;
  for (const v of [a, b, c]) {
    for (const k of v) {
      const m = Math.abs(k);
      if (m > maxAbs) maxAbs = m;
    }
  }
  const coordErr = Math.max(maxAbs, 1) * F32_ULP_SCALE;
  const n = cross(e1, e2);
  const nLen = Math.sqrt(dot(n, n));
  if (!(nLen > 0)) return Infinity;
  const e1Len = Math.sqrt(dot(e1, e1));
  const e2Len = Math.sqrt(dot(e2, e2));
  return (coordErr * (e1Len + e2Len)) / nLen;
}

/**
 * Detect whether `mesh` is a rectangular box: every (non-degenerate)
 * triangle's normal falls into exactly 3 mutually orthogonal canonical
 * directions, and every vertex of the triangles in a direction group lies on
 * one of exactly two offset planes along that direction. That combination —
 * 3 orthogonal face families, 2 planes each — forces the mesh to be a closed
 * rectangular box (it rejects, for example, an axis-aligned L-shape, whose
 * notch adds a third offset plane on two of the axes). Triangulation-
 * independent: subdividing a box's faces adds triangles but never a new
 * canonical direction or a third offset plane, so the detection (and the
 * resulting `Obb`) is identical at any tessellation.
 *
 * Returns `null` — not a best-effort guess — when the check fails, so a
 * caller that only trusts a non-null result never certifies a shape this
 * function could not confirm.
 */
export function detectObb(mesh: MeshLike): Obb | null {
  if (mesh.count === 0) return null;
  const groups: Vec3[] = [];
  // Per-family bound on the representative normal's direction error.
  const groupErr: number[] = [];
  const groupOfTri: number[] = new Array(mesh.count).fill(-1);
  for (let t = 0; t < mesh.count; t += 1) {
    const [a, b, c] = mesh.tri(t);
    const n = normalize(cross(sub(b, a), sub(c, a)));
    if (!n) continue; // degenerate triangle: contributes no face-normal evidence
    const cn = canonical(n);
    let gi = -1;
    for (let g = 0; g < groups.length; g += 1) {
      if (dot(groups[g], cn) > 1 - OBB_EPS) {
        gi = g;
        break;
      }
    }
    if (gi === -1) {
      if (groups.length >= 3) return null; // a 4th face-normal family: not a box
      groups.push(cn);
      // The representative IS this triangle's normal, so the bound that
      // applies to the orthogonality test below is this triangle's.
      groupErr.push(normalAngleError(a, b, c));
      gi = groups.length - 1;
    }
    groupOfTri[t] = gi;
  }
  if (groups.length !== 3) return null;
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      // Two unit normals each uncertain in direction by `groupErr` can read
      // as non-perpendicular by up to the sum of those angles
      // (`|dot| = |cos(90deg +/- e)| <= sin e_i + sin e_j <= e_i + e_j`).
      // `OBB_EPS` stays as a FLOOR so a mesh at the origin, where the derived
      // bound collapses towards zero, is judged exactly as strictly as it was
      // before #5355.
      const tol = Math.max(groupErr[i] + groupErr[j], OBB_EPS);
      if (Math.abs(dot(groups[i], groups[j])) > tol) return null;
    }
  }

  const minOff: [number, number, number] = [Infinity, Infinity, Infinity];
  const maxOff: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < mesh.count; t += 1) {
    const gi = groupOfTri[t];
    if (gi === -1) continue;
    const [a, b, c] = mesh.tri(t);
    for (const v of [a, b, c]) {
      const o = dot(v, groups[gi]);
      if (o < minOff[gi]) minOff[gi] = o;
      if (o > maxOff[gi]) maxOff[gi] = o;
    }
  }
  // Reject a 3rd offset plane on any axis (e.g. an L-shaped footprint).
  for (let t = 0; t < mesh.count; t += 1) {
    const gi = groupOfTri[t];
    if (gi === -1) continue;
    const [a, b, c] = mesh.tri(t);
    for (const v of [a, b, c]) {
      const o = dot(v, groups[gi]);
      const scale = Math.max(1, Math.abs(minOff[gi]), Math.abs(maxOff[gi]));
      const nearMin = Math.abs(o - minOff[gi]) <= OBB_EPS * scale;
      const nearMax = Math.abs(o - maxOff[gi]) <= OBB_EPS * scale;
      if (!nearMin && !nearMax) return null;
    }
  }

  const half: [number, number, number] = [0, 0, 0];
  const c0: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    half[i] = (maxOff[i] - minOff[i]) / 2;
    c0[i] = (maxOff[i] + minOff[i]) / 2;
    // Reject a zero-thickness "box": a face family whose triangles are all
    // coplanar passes the 2-plane test above (minOff == maxOff, so both
    // `nearMin` and `nearMax` hold for every vertex) with no positive
    // extent along that axis. An open shell (a slab exported without its
    // top face, or partial `IfcTriangulatedFaceSet` geometry) can produce
    // exactly this — 3 orthogonal families, but one degenerate — and must
    // not be certified as a box (review: #2536).
    if (!(half[i] > OBB_EPS)) return null;
  }
  const center: Vec3 = [
    c0[0] * groups[0][0] + c0[1] * groups[1][0] + c0[2] * groups[2][0],
    c0[0] * groups[0][1] + c0[1] * groups[1][1] + c0[2] * groups[2][1],
    c0[0] * groups[0][2] + c0[1] * groups[1][2] + c0[2] * groups[2][2],
  ];
  return { center, axes: [groups[0], groups[1], groups[2]], half };
}
