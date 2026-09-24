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
import { sub, cross, dot, scale } from '../math/vec3.js';
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
function normalAngleError(a: Vec3, b: Vec3, c: Vec3): [number, number] {
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
  if (!(nLen > 0)) return [Infinity, coordErr];
  const e1Len = Math.sqrt(dot(e1, e1));
  const e2Len = Math.sqrt(dot(e2, e2));
  return [(coordErr * (e1Len + e2Len)) / nLen, coordErr];
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
/**
 * Largest angle (radians) that f32 noise may widen a box-recognition
 * tolerance to (#5474). The noise bounds are worst cases: for a thin face far
 * from the origin they can exceed the 45 deg at which a box's perpendicular
 * face families stop being told apart at all. Noise may widen a tolerance
 * only up to this angle; data that disagrees by more is not certified a box
 * (the conservative outcome: the caller falls back to the labelled AABB
 * estimate). Exact data far out still certifies, because the tests compare
 * the MEASURED agreement against the tolerance. Same literal as the Rust
 * `MAX_NOISE_ANGLE`.
 */
const MAX_NOISE_ANGLE = 0.1;

export function detectObb(mesh: MeshLike): Obb | null {
  if (mesh.count === 0) return null;
  // Everything position-dependent is measured from a point ON the mesh, not
  // from the world origin (#5474). The box's centre used to be rebuilt as
  // `sum_i c_i * axis_i` from offsets `dot(v, axis_i)` of ABSOLUTE vertex
  // coordinates, so any error in the axes was multiplied by the element's
  // distance from the origin: a 0.05 m panel 123 m out reported a 23 mm depth
  // for a 20 mm overlap, and 1 km out a 65 mm one. Measured from `p0`, the
  // lever arm is the element's own size.
  const p0 = mesh.tri(0)[0];
  const groups: Vec3[] = [];
  // Per family: the direction error bound of its representative (the first
  // triangle's normal, used only to decide membership), and the area-weighted
  // sum of its triangles' normals with the numerator of that sum's direction
  // error bound (see `familyAxes`).
  const repErr: number[] = [];
  const sums: Vec3[] = [];
  const errNum: number[] = [];
  const groupOfTri: number[] = new Array(mesh.count).fill(-1);
  let coordErr = 0;
  let reach = 0;
  for (let t = 0; t < mesh.count; t += 1) {
    const [a, b, c] = mesh.tri(t);
    for (const v of [a, b, c]) {
      const d = sub(v, p0);
      const r = Math.sqrt(dot(d, d));
      if (r > reach) reach = r;
    }
    const raw = cross(sub(b, a), sub(c, a));
    const n = normalize(raw);
    if (!n) continue; // degenerate triangle: contributes no face-normal evidence
    const cn = canonical(n);
    const [err, triCoordErr] = normalAngleError(a, b, c);
    if (triCoordErr > coordErr) coordErr = triCoordErr;
    let gi = -1;
    for (let g = 0; g < groups.length; g += 1) {
      // Two normals of the same face agree to within the sum of their own
      // direction errors (`1 - cos e <= e^2 / 2`). `OBB_EPS` stays as the
      // floor, so a mesh at the origin groups exactly as before; far out, a
      // thin face's triangles no longer split into a 4th "family" and
      // decertify a perfect box (#5474).
      const e = Math.min(repErr[g] + err, MAX_NOISE_ANGLE);
      if (1 - dot(groups[g], cn) <= Math.max(OBB_EPS, 0.5 * e * e)) {
        gi = g;
        break;
      }
    }
    if (gi === -1) {
      if (groups.length >= 3) return null; // a 4th face-normal family: not a box
      groups.push(cn);
      repErr.push(err);
      sums.push([0, 0, 0]);
      errNum.push(0);
      gi = groups.length - 1;
    }
    // `raw` is twice the triangle's area along its normal, so the sum is
    // area-weighted; oriented to the representative so opposite faces add
    // rather than cancel.
    const sign = dot(raw, groups[gi]) < 0 ? -1 : 1;
    const sum = sums[gi];
    for (let k = 0; k < 3; k += 1) sum[k] += sign * raw[k];
    errNum[gi] += err * Math.sqrt(dot(raw, raw));
    groupOfTri[t] = gi;
  }
  if (groups.length !== 3) return null;
  const frame = familyAxes(sums, errNum);
  if (!frame) return null;
  const [axes, axisErr] = frame;
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      // The families' own normals must be perpendicular, to within the sum of
      // their direction errors; `OBB_EPS` stays as a FLOOR so a mesh at the
      // origin is judged as strictly as before #5355.
      const ni = scale(sums[i], 1 / Math.sqrt(dot(sums[i], sums[i])));
      const nj = scale(sums[j], 1 / Math.sqrt(dot(sums[j], sums[j])));
      const tol = Math.max(Math.min(axisErr[i] + axisErr[j], MAX_NOISE_ANGLE), OBB_EPS);
      if (Math.abs(dot(ni, nj)) > tol) return null;
    }
  }

  const minOff: [number, number, number] = [Infinity, Infinity, Infinity];
  const maxOff: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < mesh.count; t += 1) {
    const gi = groupOfTri[t];
    if (gi === -1) continue;
    const [a, b, c] = mesh.tri(t);
    for (const v of [a, b, c]) {
      const o = dot(sub(v, p0), axes[gi]);
      if (o < minOff[gi]) minOff[gi] = o;
      if (o > maxOff[gi]) maxOff[gi] = o;
    }
  }
  // Reject a 3rd offset plane on any axis (e.g. an L-shaped footprint). A
  // vertex on one of the two planes is off it by its own f32 rounding
  // (`coordErr` bounds the difference of two vertices' roundings) plus the
  // axis's direction error across the mesh (`reach` from `p0`); the relative
  // `OBB_EPS` term is the floor that applied before #5474.
  for (let t = 0; t < mesh.count; t += 1) {
    const gi = groupOfTri[t];
    if (gi === -1) continue;
    const [a, b, c] = mesh.tri(t);
    const scaleOff = Math.max(Math.max(1, Math.abs(minOff[gi])), Math.abs(maxOff[gi]));
    const tol = Math.max(OBB_EPS * scaleOff, coordErr + Math.min(axisErr[gi], MAX_NOISE_ANGLE) * reach);
    for (const v of [a, b, c]) {
      const o = dot(sub(v, p0), axes[gi]);
      const nearMin = Math.abs(o - minOff[gi]) <= tol;
      const nearMax = Math.abs(o - maxOff[gi]) <= tol;
      if (!nearMin && !nearMax) return null;
    }
  }

  const half: [number, number, number] = [0, 0, 0];
  const c0: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i += 1) {
    half[i] = (maxOff[i] - minOff[i]) / 2;
    c0[i] = (maxOff[i] + minOff[i]) / 2;
    // Reject a zero-thickness "box": a face family whose triangles are all
    // coplanar passes the 2-plane test above (`minOff === maxOff`) with no
    // positive extent along that axis — an open shell (review: #2536).
    if (!(half[i] > OBB_EPS)) return null;
  }
  const center: Vec3 = [
    p0[0] + c0[0] * axes[0][0] + c0[1] * axes[1][0] + c0[2] * axes[2][0],
    p0[1] + c0[0] * axes[0][1] + c0[1] * axes[1][1] + c0[2] * axes[2][1],
    p0[2] + c0[0] * axes[0][2] + c0[1] * axes[1][2] + c0[2] * axes[2][2],
  ];
  return { center, axes: [axes[0], axes[1], axes[2]], half };
}

/**
 * The box frame from the three families' area-weighted normal sums, with a
 * direction error bound per axis (#5474).
 *
 * Each family's sum is dominated by its largest faces, which resolve their
 * normal most sharply (`errNum / |sum|` is the area-weighted mean of the
 * triangles' `normalAngleError`). The frame is then made EXACTLY orthonormal,
 * most precise family first: its axis is its own normalised sum, the next is
 * Gram-Schmidt'ed against it, the last is their cross product. A thin panel's
 * 5 cm side faces therefore inherit the precision of its 3 m faces instead of
 * contributing their own, and a centre rebuilt from the frame cannot pick up
 * a non-orthogonality error. Ties in precision keep family order, so the
 * frame is deterministic. Bit-identical to the Rust `family_axes`.
 */
function familyAxes(sums: Vec3[], errNum: number[]): [Vec3[], number[]] | null {
  const err = [0, 0, 0];
  for (let g = 0; g < 3; g += 1) {
    const len = Math.sqrt(dot(sums[g], sums[g]));
    if (!(len > 0)) return null;
    err[g] = errNum[g] / len;
  }
  const order = [0, 1, 2];
  // Stable insertion sort on the error bound (3 elements).
  for (let i = 1; i < 3; i += 1) {
    let j = i;
    while (j > 0 && err[order[j]] < err[order[j - 1]]) {
      [order[j], order[j - 1]] = [order[j - 1], order[j]];
      j -= 1;
    }
  }
  const [f0, f1, f2] = order;
  const a0 = normalize(sums[f0]);
  if (!a0) return null;
  const a1 = normalize(sub(sums[f1], scale(a0, dot(sums[f1], a0))));
  if (!a1) return null;
  let a2 = cross(a0, a1);
  if (dot(a2, sums[f2]) < 0) a2 = scale(a2, -1);
  const axes: Vec3[] = [];
  axes[f0] = a0;
  axes[f1] = a1;
  axes[f2] = a2;
  // An orthogonalised axis is as precise as the axes it was built from.
  const axisErr = [0, 0, 0];
  axisErr[f0] = err[f0];
  axisErr[f1] = err[f0] + err[f1];
  axisErr[f2] = err[f0] + err[f1];
  return [axes, axisErr];
}
