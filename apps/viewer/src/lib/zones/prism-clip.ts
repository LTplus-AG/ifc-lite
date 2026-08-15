/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The divergence integral for a PRISM zone (issue #2508 item 4).
 *
 * Split out of `./prism.js`, which owns the footprint itself: its validity, its
 * bounds, its trapezoidal sweep, and the point/rectangle tests the assignment
 * engine uses. Everything here is arithmetic over triangles against one
 * already-compiled prism and knows nothing of zones, zone sets or assignment.
 * The seam mirrors `apportionment.ts` / `apportionment-clip.ts` one level up,
 * for the same reason: the integrator is the part with the maths in it.
 *
 * WHY the field works for a prism at all, and why it stays exact, is in
 * `./prism.js`'s module doc. Read that first; this file is the loop.
 */

import type { ElementMeshPiece } from './apportionment-clip.js';
import type { CompiledPrism, Trapezoid } from './prism.js';

/** Scratch polygons. A triangle clipped by six planes has at most nine
 *  vertices; twelve is headroom, and module scope keeps the loop allocation
 *  free, as in the box path. */
const SCRATCH_A = new Float64Array(12 * 3);
const SCRATCH_B = new Float64Array(12 * 3);

/**
 * Clip a polygon against `nx*x + ny*y + nz*z <= d`, writing to `dst`.
 *
 * The general-plane counterpart of the box path's axis-aligned clip. The edge
 * parameter is clamped behind a denominator guard for the same reason it is
 * there: without it a near-coincident plane extrapolates the cut vertex off the
 * end of the edge (#1155).
 */
function clipPlane(
  src: Float64Array,
  srcCount: number,
  dst: Float64Array,
  nx: number,
  ny: number,
  nz: number,
  d: number,
): number {
  let out = 0;
  for (let i = 0; i < srcCount; i++) {
    const ai = i * 3;
    const bi = ((i + 1) % srcCount) * 3;
    const da = d - (nx * src[ai] + ny * src[ai + 1] + nz * src[ai + 2]);
    const db = d - (nx * src[bi] + ny * src[bi + 1] + nz * src[bi + 2]);
    if (da >= 0) {
      dst[out * 3] = src[ai];
      dst[out * 3 + 1] = src[ai + 1];
      dst[out * 3 + 2] = src[ai + 2];
      out++;
    }
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const denom = da - db;
      let t = Math.abs(denom) > 1e-12 ? da / denom : 0;
      if (!(t > 0)) t = 0;
      else if (t > 1) t = 1;
      dst[out * 3] = src[ai] + (src[bi] - src[ai]) * t;
      dst[out * 3 + 1] = src[ai + 1] + (src[bi + 1] - src[ai + 1]) * t;
      dst[out * 3 + 2] = src[ai + 2] + (src[bi + 2] - src[ai + 2]) * t;
      out++;
    }
  }
  return out;
}

/** Fan-triangulate and accumulate `a.x * f(centroid)`, where `f` is the linear
 *  weight of the region this polygon was clipped into. */
function accumulate(
  poly: Float64Array,
  count: number,
  constant: number,
  perZ: number,
  perX: number,
): number {
  if (count < 3) return 0;
  let sum = 0;
  const p0x = poly[0];
  const p0y = poly[1];
  const p0z = poly[2];
  for (let i = 1; i + 1 < count; i++) {
    const ii = i * 3;
    const ji = (i + 1) * 3;
    const uy = poly[ii + 1] - p0y;
    const uz = poly[ii + 2] - p0z;
    const vy = poly[ji + 1] - p0y;
    const vz = poly[ji + 2] - p0z;
    const ax = 0.5 * (uy * vz - uz * vy);
    if (ax === 0) continue;
    const cx = (p0x + poly[ii] + poly[ji]) / 3;
    const cz = (p0z + poly[ii + 2] + poly[ji + 2]) / 3;
    sum += ax * (constant + perX * cx + perZ * cz);
  }
  return sum;
}

/** Integrate one trapezoid's contribution over one already-transformed
 *  triangle held in `SCRATCH_A`. */
function accumulateTrapezoid(trap: Trapezoid, minY: number, maxY: number): number {
  let count = clipPlane(SCRATCH_A, 3, SCRATCH_B, 0, 1, 0, maxY);
  if (count < 3) return 0;
  count = clipPlane(SCRATCH_B, count, SCRATCH_A, 0, -1, 0, -minY);
  if (count < 3) return 0;
  count = clipPlane(SCRATCH_A, count, SCRATCH_B, 0, 0, 1, trap.z1);
  if (count < 3) return 0;
  count = clipPlane(SCRATCH_B, count, SCRATCH_A, 0, 0, -1, -trap.z0);
  if (count < 3) return 0;

  // Keep only x >= lo(z), i.e. -(x - bLo*z) <= -aLo. Below it the field is
  // zero, so the region contributes nothing at all.
  count = clipPlane(SCRATCH_A, count, SCRATCH_B, -1, 0, trap.bLo, -trap.aLo);
  if (count < 3) return 0;

  // Split at hi(z): inside the chord the weight is `x - lo(z)`; beyond it the
  // weight is the whole chord width `hi(z) - lo(z)`, which is how a face on the
  // far side accounts for the material it shadows. A polygon lying exactly on
  // the split plane must go to ONE side: Sutherland-Hodgman would keep it whole
  // on both and double that face's contribution, and a face sitting precisely
  // on a zone boundary is the common case in a tiling plan, not an edge case.
  let minD = Infinity;
  let maxD = -Infinity;
  for (let i = 0; i < count; i++) {
    const d = SCRATCH_B[i * 3] - (trap.aHi + trap.bHi * SCRATCH_B[i * 3 + 2]);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  const inside = (): number => accumulate(SCRATCH_A, count, -trap.aLo, -trap.bLo, 1);
  if (maxD <= 0) {
    SCRATCH_A.set(SCRATCH_B.subarray(0, count * 3));
    return inside();
  }
  if (minD >= 0) {
    SCRATCH_A.set(SCRATCH_B.subarray(0, count * 3));
    return accumulate(SCRATCH_A, count, trap.aHi - trap.aLo, trap.bHi - trap.bLo, 0);
  }
  const near = clipPlane(SCRATCH_B, count, SCRATCH_A, 1, 0, -trap.bHi, trap.aHi);
  let sum = accumulate(SCRATCH_A, near, -trap.aLo, -trap.bLo, 1);
  const far = clipPlane(SCRATCH_B, count, SCRATCH_A, -1, 0, trap.bHi, -trap.aHi);
  sum += accumulate(SCRATCH_A, far, trap.aHi - trap.aLo, trap.bHi - trap.bLo, 0);
  return sum;
}

/**
 * Volume (cubic metres) of the closed mesh `pieces` inside `prism`.
 *
 * Signed exactly as the mesh's own volume is, like
 * `clippedVolumeForZone`: a globally inward-wound mesh yields a negative number
 * here AND a negative whole volume, and their ratio is still right.
 */
export function clippedVolumeForPrism(pieces: readonly ElementMeshPiece[], prism: CompiledPrism): number {
  if (prism.traps.length === 0) return 0;
  let vol = 0;
  for (const piece of pieces) {
    const positions = piece.positions;
    const indices = piece.indices;
    const ox = piece.origin?.[0] ?? 0;
    const oy = piece.origin?.[1] ?? 0;
    const oz = piece.origin?.[2] ?? 0;

    for (let t = 0; t + 2 < indices.length; t += 3) {
      let degenerate = false;
      let allAboveY = true, allBelowY = true, allBelowX = true, allBelowZ = true, allAboveZ = true;
      for (let k = 0; k < 3; k++) {
        const vi = indices[t + k] * 3;
        const x = positions[vi] + ox;
        const y = positions[vi + 1] + oy;
        const z = positions[vi + 2] + oz;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
          degenerate = true;
          break;
        }
        SCRATCH_A[k * 3] = x;
        SCRATCH_A[k * 3 + 1] = y;
        SCRATCH_A[k * 3 + 2] = z;
        if (y < prism.maxY) allAboveY = false;
        if (y > prism.minY) allBelowY = false;
        if (x > prism.minX) allBelowX = false;
        if (z > prism.minZ) allBelowZ = false;
        if (z < prism.maxZ) allAboveZ = false;
      }
      // Nothing is rejected for lying beyond maxX: that region carries the
      // full-chord weight and is exactly how a far face accounts for the
      // material between it and the prism.
      if (degenerate || allAboveY || allBelowY || allBelowX || allBelowZ || allAboveZ) continue;

      const x0 = SCRATCH_A[0], y0 = SCRATCH_A[1], z0 = SCRATCH_A[2];
      const x1 = SCRATCH_A[3], y1 = SCRATCH_A[4], z1 = SCRATCH_A[5];
      const x2 = SCRATCH_A[6], y2 = SCRATCH_A[7], z2 = SCRATCH_A[8];
      for (const trap of prism.traps) {
        // Each trapezoid clips the ORIGINAL triangle: the scratch buffer is
        // overwritten by the previous strip's clipping.
        SCRATCH_A[0] = x0; SCRATCH_A[1] = y0; SCRATCH_A[2] = z0;
        SCRATCH_A[3] = x1; SCRATCH_A[4] = y1; SCRATCH_A[5] = z1;
        SCRATCH_A[6] = x2; SCRATCH_A[7] = y2; SCRATCH_A[8] = z2;
        vol += accumulateTrapezoid(trap, prism.minY, prism.maxY);
      }
    }
  }
  return vol;
}
