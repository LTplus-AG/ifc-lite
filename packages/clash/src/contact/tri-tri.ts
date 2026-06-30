/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Triangle-triangle overlap tests based on Tomas Möller,
 * "A Fast Triangle-Triangle Intersection Test" (1997),
 * extended to report both strict crossings (with a 3D intersection segment)
 * and the coplanar-overlap case, which is the signal shared-face detection
 * downstream actually cares about.
 */

import type { Triangle } from "./triangle.js";
import { isDegenerate, triangleNormalRaw } from "./triangle.js";
import type { Vec3 } from "./types.js";
import { cross3, dot3, length3, lerp3, sub3 } from "./vec3.js";

export type TriTriResult =
  | { readonly kind: "none" }
  | { readonly kind: "cross"; readonly p0: Vec3; readonly p1: Vec3 }
  | { readonly kind: "coplanar" };

/**
 * Full Möller test.
 *
 * `planeEps` is the absolute tolerance on signed plane distance — distances
 * with |d| / |N| ≤ planeEps are treated as zero (on-plane). Defaults to 1e-6
 * in model-native units.
 */
export function triTriIntersect(a: Triangle, b: Triangle, planeEps = 1e-6): TriTriResult {
  if (isDegenerate(a) || isDegenerate(b)) return { kind: "none" };

  // Plane of B
  const N2 = triangleNormalRaw(b);
  const ln2 = length3(N2);
  const d2 = -dot3(N2, b.v0);
  const dA0 = (dot3(N2, a.v0) + d2) / ln2;
  const dA1 = (dot3(N2, a.v1) + d2) / ln2;
  const dA2 = (dot3(N2, a.v2) + d2) / ln2;
  const sA0 = signOf(dA0, planeEps);
  const sA1 = signOf(dA1, planeEps);
  const sA2 = signOf(dA2, planeEps);
  if (sA0 === sA1 && sA1 === sA2 && sA0 !== 0) return { kind: "none" };

  // Plane of A
  const N1 = triangleNormalRaw(a);
  const ln1 = length3(N1);
  const d1 = -dot3(N1, a.v0);
  const dB0 = (dot3(N1, b.v0) + d1) / ln1;
  const dB1 = (dot3(N1, b.v1) + d1) / ln1;
  const dB2 = (dot3(N1, b.v2) + d1) / ln1;
  const sB0 = signOf(dB0, planeEps);
  const sB1 = signOf(dB1, planeEps);
  const sB2 = signOf(dB2, planeEps);
  if (sB0 === sB1 && sB1 === sB2 && sB0 !== 0) return { kind: "none" };

  // All-zero on either side → coplanar
  if (sA0 === 0 && sA1 === 0 && sA2 === 0) return { kind: "coplanar" };
  if (sB0 === 0 && sB1 === 0 && sB2 === 0) return { kind: "coplanar" };

  // Chord endpoints: 3D points where each triangle's edges cross the opposite plane.
  const chordA = triChord(a, dA0, dA1, dA2);
  const chordB = triChord(b, dB0, dB1, dB2);
  if (!chordA || !chordB) return { kind: "none" };

  // Overlap along the common intersection line.
  const D = cross3(N1, N2);
  const dAxis = dominantAxis(D);
  const ta0 = chordA[0][dAxis] as number;
  const ta1 = chordA[1][dAxis] as number;
  const tb0 = chordB[0][dAxis] as number;
  const tb1 = chordB[1][dAxis] as number;
  const aMin = Math.min(ta0, ta1);
  const aMax = Math.max(ta0, ta1);
  const bMin = Math.min(tb0, tb1);
  const bMax = Math.max(tb0, tb1);
  const oMin = Math.max(aMin, bMin);
  const oMax = Math.min(aMax, bMax);
  if (oMax < oMin - planeEps) return { kind: "none" };

  // Reconstruct 3D endpoints of the overlap on the intersection line by
  // picking the chord whose parameter interval matches the overlap.
  const p0 = pointAtLineParam(chordA, chordB, dAxis, oMin);
  const p1 = pointAtLineParam(chordA, chordB, dAxis, oMax);
  return { kind: "cross", p0, p1 };
}

/**
 * True when triangles lie in the same plane within `planeEps`.
 * Both triangles must be non-degenerate.
 */
export function trianglesCoplanar(a: Triangle, b: Triangle, planeEps = 1e-6): boolean {
  if (isDegenerate(a) || isDegenerate(b)) return false;
  const N2 = triangleNormalRaw(b);
  const d2 = -dot3(N2, b.v0);
  const n2Len = length3(N2);
  if (n2Len === 0) return false;
  if (Math.abs(dot3(N2, a.v0) + d2) / n2Len > planeEps) return false;
  if (Math.abs(dot3(N2, a.v1) + d2) / n2Len > planeEps) return false;
  if (Math.abs(dot3(N2, a.v2) + d2) / n2Len > planeEps) return false;

  const N1 = triangleNormalRaw(a);
  const d1 = -dot3(N1, a.v0);
  const n1Len = length3(N1);
  if (n1Len === 0) return false;
  if (Math.abs(dot3(N1, b.v0) + d1) / n1Len > planeEps) return false;
  if (Math.abs(dot3(N1, b.v1) + d1) / n1Len > planeEps) return false;
  if (Math.abs(dot3(N1, b.v2) + d1) / n1Len > planeEps) return false;

  return true;
}

/** Signed distance (unit-normalised) from point `p` to triangle's plane. */
export function signedDistanceToPlane(t: Triangle, p: Vec3): number {
  const n = triangleNormalRaw(t);
  const ln = length3(n);
  if (ln === 0) return 0;
  const d = -dot3(n, t.v0);
  return (dot3(n, p) + d) / ln;
}

function signOf(x: number, eps: number): -1 | 0 | 1 {
  if (x > eps) return 1;
  if (x < -eps) return -1;
  return 0;
}

function dominantAxis(v: Vec3): 0 | 1 | 2 {
  const ax = Math.abs(v[0]);
  const ay = Math.abs(v[1]);
  const az = Math.abs(v[2]);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

/** Intersection point of segment `p→q` with a plane, given signed distances `dp,dq` (opposite signs). */
function edgePlane(p: Vec3, q: Vec3, dp: number, dq: number): Vec3 {
  const t = dp / (dp - dq);
  return lerp3(p, q, t);
}

/** Two 3D points where triangle's edges cross the opposite plane. */
function triChord(tri: Triangle, d0: number, d1: number, d2: number): readonly [Vec3, Vec3] | null {
  const pts: Vec3[] = [];
  // Count crossings by edge
  if ((d0 > 0 && d1 < 0) || (d0 < 0 && d1 > 0)) pts.push(edgePlane(tri.v0, tri.v1, d0, d1));
  if ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) pts.push(edgePlane(tri.v1, tri.v2, d1, d2));
  if ((d2 > 0 && d0 < 0) || (d2 < 0 && d0 > 0)) pts.push(edgePlane(tri.v2, tri.v0, d2, d0));
  // On-plane vertices contribute themselves once
  if (d0 === 0) pts.push(tri.v0);
  if (d1 === 0) pts.push(tri.v1);
  if (d2 === 0) pts.push(tri.v2);
  if (pts.length < 2) return null;
  const first = pts[0] as Vec3;
  const last = pts[pts.length - 1] as Vec3;
  return [first, last];
}

/**
 * Given two chord segments on the same line, parametrised by their
 * dominant-axis coordinate, return the 3D point whose dominant-axis
 * coordinate is `t`. We look up the chord whose interval contains `t`
 * (or the closer one) and lerp along it in 3D.
 */
function pointAtLineParam(
  chordA: readonly [Vec3, Vec3],
  chordB: readonly [Vec3, Vec3],
  axis: 0 | 1 | 2,
  t: number,
): Vec3 {
  // Prefer chord A unless B clearly contains t better.
  const ta0 = chordA[0][axis] as number;
  const ta1 = chordA[1][axis] as number;
  const tb0 = chordB[0][axis] as number;
  const tb1 = chordB[1][axis] as number;
  const aMin = Math.min(ta0, ta1);
  const aMax = Math.max(ta0, ta1);
  const bMin = Math.min(tb0, tb1);
  const bMax = Math.max(tb0, tb1);
  const aContains = t >= aMin - 1e-12 && t <= aMax + 1e-12;
  const bContains = t >= bMin - 1e-12 && t <= bMax + 1e-12;
  if (aContains) return lerpChord(chordA, axis, t);
  if (bContains) return lerpChord(chordB, axis, t);
  // numerical fallback — pick whichever is closer
  const distA = Math.min(Math.abs(t - aMin), Math.abs(t - aMax));
  const distB = Math.min(Math.abs(t - bMin), Math.abs(t - bMax));
  return distA <= distB ? lerpChord(chordA, axis, t) : lerpChord(chordB, axis, t);
}

function lerpChord(chord: readonly [Vec3, Vec3], axis: 0 | 1 | 2, t: number): Vec3 {
  const a = chord[0][axis] as number;
  const b = chord[1][axis] as number;
  const denom = b - a;
  if (Math.abs(denom) < 1e-15) return chord[0];
  const u = (t - a) / denom;
  return lerp3(chord[0], chord[1], u);
}

// Keep import of sub3 so bundlers don't eagerly tree-shake indirect users;
// triangleNormalRaw uses it transitively.
void sub3;
