/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Closest-point maths for the walk capsule (Ericson, Real-Time Collision
 * Detection, ch. 5), ported from RvtGo's `GeoMath` (public domain).
 *
 * Scalar arguments and caller-owned output arrays, never `{x, y, z}` objects:
 * the controller calls these thousands of times per second, and an object per
 * call would make collision a garbage-collector benchmark.
 */

const EPSILON = 1e-12;

/** Closest point on triangle ABC to P, written to `out[o..o+2]`. */
export function closestPointOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float64Array, o: number,
): void {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) { out[o] = ax; out[o + 1] = ay; out[o + 2] = az; return; }

  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) { out[o] = bx; out[o + 1] = by; out[o + 2] = bz; return; }

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[o] = ax + v * abx; out[o + 1] = ay + v * aby; out[o + 2] = az + v * abz;
    return;
  }

  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) { out[o] = cx; out[o + 1] = cy; out[o + 2] = cz; return; }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[o] = ax + w * acx; out[o + 1] = ay + w * acy; out[o + 2] = az + w * acz;
    return;
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    out[o] = bx + w * (cx - bx); out[o + 1] = by + w * (cy - by); out[o + 2] = bz + w * (cz - bz);
    return;
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  out[o] = ax + abx * v + acx * w;
  out[o + 1] = ay + aby * v + acy * w;
  out[o + 2] = az + abz * v + acz * w;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Squared distance between segments P1Q1 and P2Q2. Writes the closest point
 * on the first to `out[0..2]` and on the second to `out[3..5]`.
 */
export function closestSegmentSegment(
  p1x: number, p1y: number, p1z: number, q1x: number, q1y: number, q1z: number,
  p2x: number, p2y: number, p2z: number, q2x: number, q2y: number, q2z: number,
  out: Float64Array,
): number {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number;
  let t: number;
  if (a <= EPSILON && e <= EPSILON) {
    s = 0; t = 0;
  } else if (a <= EPSILON) {
    s = 0; t = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPSILON) {
      t = 0; s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const c1x = p1x + d1x * s, c1y = p1y + d1y * s, c1z = p1z + d1z * s;
  const c2x = p2x + d2x * t, c2y = p2y + d2y * t, c2z = p2z + d2z * t;
  out[0] = c1x; out[1] = c1y; out[2] = c1z;
  out[3] = c2x; out[4] = c2y; out[5] = c2z;
  const dx = c1x - c2x, dy = c1y - c2y, dz = c1z - c2z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Two-sided Möller–Trumbore: the hit parameter along `dir` in [0, tMax], or
 * -1 for a miss. `dir` need not be unit length.
 */
export function rayTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  tMax: number,
): number {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const pvx = dy * e2z - dz * e2y, pvy = dz * e2x - dx * e2z, pvz = dx * e2y - dy * e2x;
  const det = e1x * pvx + e1y * pvy + e1z * pvz;
  if (Math.abs(det) < EPSILON) return -1;
  const inv = 1 / det;
  const tvx = ox - ax, tvy = oy - ay, tvz = oz - az;
  const u = (tvx * pvx + tvy * pvy + tvz * pvz) * inv;
  if (u < 0 || u > 1) return -1;
  const qvx = tvy * e1z - tvz * e1y, qvy = tvz * e1x - tvx * e1z, qvz = tvx * e1y - tvy * e1x;
  const v = (dx * qvx + dy * qvy + dz * qvz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qvx + e2y * qvy + e2z * qvz) * inv;
  return t >= 0 && t <= tMax ? t : -1;
}

const scratch = new Float64Array(6);

/**
 * Squared distance between segment PQ and triangle ABC. Writes the closest
 * point on the segment to `out[0..2]` and on the triangle to `out[3..5]`.
 * A piercing segment returns 0 with both points at the piercing point.
 */
export function closestSegmentTriangle(
  px: number, py: number, pz: number, qx: number, qy: number, qz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: Float64Array,
): number {
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  const hit = rayTriangle(px, py, pz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz, 1);
  if (hit >= 0) {
    out[0] = out[3] = px + dx * hit;
    out[1] = out[4] = py + dy * hit;
    out[2] = out[5] = pz + dz * hit;
    return 0;
  }

  closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, scratch, 0);
  let ex = px - scratch[0], ey = py - scratch[1], ez = pz - scratch[2];
  let best = ex * ex + ey * ey + ez * ez;
  out[0] = px; out[1] = py; out[2] = pz;
  out[3] = scratch[0]; out[4] = scratch[1]; out[5] = scratch[2];

  closestPointOnTriangle(qx, qy, qz, ax, ay, az, bx, by, bz, cx, cy, cz, scratch, 0);
  ex = qx - scratch[0]; ey = qy - scratch[1]; ez = qz - scratch[2];
  let d = ex * ex + ey * ey + ez * ez;
  if (d < best) {
    best = d;
    out[0] = qx; out[1] = qy; out[2] = qz;
    out[3] = scratch[0]; out[4] = scratch[1]; out[5] = scratch[2];
  }

  d = closestSegmentSegment(px, py, pz, qx, qy, qz, ax, ay, az, bx, by, bz, scratch);
  if (d < best) { best = d; out.set(scratch); }
  d = closestSegmentSegment(px, py, pz, qx, qy, qz, bx, by, bz, cx, cy, cz, scratch);
  if (d < best) { best = d; out.set(scratch); }
  d = closestSegmentSegment(px, py, pz, qx, qy, qz, cx, cy, cz, ax, ay, az, scratch);
  if (d < best) { best = d; out.set(scratch); }
  return best;
}
