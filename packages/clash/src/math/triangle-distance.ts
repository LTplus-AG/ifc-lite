/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Vec3 } from '../types.js';
import { add, distSq, dot, scale, sub } from './vec3.js';

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const EPS = 1e-12;

/**
 * Closest points between two segments [p1,q1] and [p2,q2].
 * Ericson, Real-Time Collision Detection §5.1.9. Returns squared distance and
 * the closest point on each segment.
 */
export function closestPtSegSeg(
  p1: Vec3,
  q1: Vec3,
  p2: Vec3,
  q2: Vec3,
): { d2: number; c1: Vec3; c2: Vec3 } {
  const d1 = sub(q1, p1);
  const d2v = sub(q2, p2);
  const r = sub(p1, p2);
  const a = dot(d1, d1);
  const e = dot(d2v, d2v);
  const f = dot(d2v, r);

  let s: number;
  let t: number;

  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2v);
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  const c1 = add(p1, scale(d1, s));
  const c2 = add(p2, scale(d2v, t));
  return { d2: distSq(c1, c2), c1, c2 };
}

/**
 * Closest point on triangle (a,b,c) to point p.
 * Ericson, Real-Time Collision Detection §5.1.5.
 */
export function closestPtPointTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, scale(ab, v));
  }

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return add(a, scale(ac, w));
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return add(a, add(scale(ab, v), scale(ac, w)));
}

/**
 * Minimum distance between two triangles, with the closest point on each.
 *
 * Correct for **disjoint** triangles (the minimum lies on an edge–edge pair or
 * a vertex-to-face). Intersecting triangles must be detected separately with
 * `triTriIntersect`; this routine is only invoked for non-intersecting pairs.
 */
export function triTriDistance(
  a0: Vec3,
  a1: Vec3,
  a2: Vec3,
  b0: Vec3,
  b1: Vec3,
  b2: Vec3,
): { dist: number; pA: Vec3; pB: Vec3 } {
  const ea: [Vec3, Vec3][] = [
    [a0, a1],
    [a1, a2],
    [a2, a0],
  ];
  const eb: [Vec3, Vec3][] = [
    [b0, b1],
    [b1, b2],
    [b2, b0],
  ];

  let best = Infinity;
  let pA: Vec3 = a0;
  let pB: Vec3 = b0;

  for (const [s0, s1] of ea) {
    for (const [t0, t1] of eb) {
      const r = closestPtSegSeg(s0, s1, t0, t1);
      if (r.d2 < best) {
        best = r.d2;
        pA = r.c1;
        pB = r.c2;
      }
    }
  }

  for (const v of [a0, a1, a2]) {
    const c = closestPtPointTriangle(v, b0, b1, b2);
    const d2 = distSq(v, c);
    if (d2 < best) {
      best = d2;
      pA = v;
      pB = c;
    }
  }

  for (const v of [b0, b1, b2]) {
    const c = closestPtPointTriangle(v, a0, a1, a2);
    const d2 = distSq(v, c);
    if (d2 < best) {
      best = d2;
      pA = c;
      pB = v;
    }
  }

  return { dist: Math.sqrt(best), pA, pB };
}
