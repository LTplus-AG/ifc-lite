/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scale-aware geometric predicates for the fill triangulator.
 *
 * Every tolerance in here is RELATIVE. An absolute one would be a trap: a
 * cross product carries squared coordinate units, so a threshold tuned for a
 * cut face measured in metres silently reclassifies every crossing in a face
 * measured in millimetres — collinear where it is not, "clear" where the
 * bridge in fact cuts through a wall. The section overlay sees both, because
 * the model's own unit assignment decides what a coordinate means.
 *
 * So orientation is tested as a SINE (determinant over the two operand
 * lengths) and position along a segment as a PARAMETER (dot over the squared
 * length). Both are dimensionless, so the same constant means the same thing
 * at any model scale.
 */

import type { Pt } from './fill-triangulate.js';

/** Dimensionless tolerance: a sine for orientation, a fraction for position. */
const REL_EPS = 1e-12;

/**
 * Which side of the directed line pq the point r falls on: 1 left, -1 right,
 * 0 collinear within {@link REL_EPS} of the two operands' magnitudes.
 */
export function orient(p: Pt, q: Pt, r: Pt): number {
  const ux = q.x - p.x;
  const uz = q.z - p.z;
  const vx = r.x - p.x;
  const vz = r.z - p.z;
  const det = ux * vz - uz * vx;
  const scale = Math.hypot(ux, uz) * Math.hypot(vx, vz);
  if (Math.abs(det) <= REL_EPS * scale) return 0;
  return det > 0 ? 1 : -1;
}

/** True when ab and cd cross at a point interior to BOTH segments. Shared
 *  endpoints and touching do not count — {@link pointOnSegment} covers those. */
export function properlyCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  return orient(c, d, a) * orient(c, d, b) < 0 && orient(a, b, c) * orient(a, b, d) < 0;
}

/**
 * True when `p` lies on segment ab. `includeEnds` decides whether the two
 * endpoints count, which is the difference between "this vertex is ON the ring"
 * (yes) and "this vertex sits in the middle of my bridge" (no).
 */
export function pointOnSegment(p: Pt, a: Pt, b: Pt, includeEnds: boolean): boolean {
  if (orient(a, b, p) !== 0) return false;
  const len = (b.x - a.x) ** 2 + (b.z - a.z) ** 2;
  if (len === 0) return includeEnds && p.x === a.x && p.z === a.z;
  const t = ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / len;
  return includeEnds ? t >= -REL_EPS && t <= 1 + REL_EPS : t > REL_EPS && t < 1 - REL_EPS;
}

/** Longest side of the ring's bounding box — the characteristic length the
 *  coordinate comparisons below are measured against. */
export function ringScale(ring: readonly Pt[]): number {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  const extent = Math.max(maxX - minX, maxZ - minZ);
  return Number.isFinite(extent) && extent > 0 ? extent : 1;
}

/** True when two vertices are the same point, relative to `scale`. */
export function samePoint(a: Pt, b: Pt, scale: number): boolean {
  const tol = REL_EPS * scale;
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.z - b.z) <= tol;
}
