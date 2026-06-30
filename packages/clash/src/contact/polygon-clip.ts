/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 2D polygon utilities: Sutherland–Hodgman clip of a subject polygon by
 * a convex clip polygon, shoelace area, perimeter, centroid.
 *
 * Both polygons are arrays of `[x, y]` pairs. CCW winding gives positive
 * area (standard convention).
 */

export type Point2 = readonly [number, number];
export type Polygon2 = readonly Point2[];

/** Shoelace-formula signed area (positive when CCW). */
export function polygonSignedArea(poly: Polygon2): number {
  const n = poly.length;
  if (n < 3) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as Point2;
    const b = poly[(i + 1) % n] as Point2;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

export const polygonArea = (poly: Polygon2): number => Math.abs(polygonSignedArea(poly));

export function polygonPerimeter(poly: Polygon2): number {
  const n = poly.length;
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as Point2;
    const b = poly[(i + 1) % n] as Point2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    sum += Math.sqrt(dx * dx + dy * dy);
  }
  return sum;
}

/** Area-weighted centroid. Falls back to vertex mean for degenerate input. */
export function polygonCentroid(poly: Polygon2): Point2 {
  const n = poly.length;
  if (n === 0) return [0, 0];
  if (n === 1) {
    const p0 = poly[0] as Point2;
    return [p0[0], p0[1]];
  }
  const a2 = polygonSignedArea(poly) * 2;
  if (Math.abs(a2) < 1e-18) {
    let mx = 0;
    let my = 0;
    for (const p of poly) {
      mx += p[0];
      my += p[1];
    }
    return [mx / n, my / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i] as Point2;
    const b = poly[(i + 1) % n] as Point2;
    const cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  return [cx / (3 * a2), cy / (3 * a2)];
}

/**
 * Sutherland–Hodgman polygon clip. `subject` may be any simple polygon;
 * `clip` must be **convex** (CCW). Returns the intersection polygon, which
 * can be empty (no overlap) or degenerate (collinear/point contact).
 */
export function sutherlandHodgman(subject: Polygon2, clip: Polygon2): Polygon2 {
  if (subject.length === 0 || clip.length < 3) return [];
  // Enforce CCW clip — if the clip is CW we flip it.
  const clipCCW = polygonSignedArea(clip) >= 0 ? clip : [...clip].reverse();
  let output: Point2[] = subject.map((p) => [p[0], p[1]] as Point2);

  for (let i = 0; i < clipCCW.length; i++) {
    if (output.length === 0) break;
    const a = clipCCW[i] as Point2;
    const b = clipCCW[(i + 1) % clipCCW.length] as Point2;
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const current = input[j] as Point2;
      const prev = input[(j - 1 + input.length) % input.length] as Point2;
      const curIn = isLeftOrOn(a, b, current);
      const prevIn = isLeftOrOn(a, b, prev);
      if (curIn) {
        if (!prevIn) {
          const ip = segmentIntersection(prev, current, a, b);
          if (ip) output.push(ip);
        }
        output.push(current);
      } else if (prevIn) {
        const ip = segmentIntersection(prev, current, a, b);
        if (ip) output.push(ip);
      }
    }
  }
  return output;
}

/** True when point `p` is to the left of, or on, directed edge `a → b`. */
function isLeftOrOn(a: Point2, b: Point2, p: Point2): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return cross >= 0;
}

/** Intersection of segment `p1→p2` with infinite line through `a→b`. */
function segmentIntersection(p1: Point2, p2: Point2, a: Point2, b: Point2): Point2 | null {
  const r0 = p2[0] - p1[0];
  const r1 = p2[1] - p1[1];
  const s0 = b[0] - a[0];
  const s1 = b[1] - a[1];
  const denom = r0 * s1 - r1 * s0;
  if (Math.abs(denom) < 1e-15) return null; // parallel
  const qp0 = a[0] - p1[0];
  const qp1 = a[1] - p1[1];
  const t = (qp0 * s1 - qp1 * s0) / denom;
  return [p1[0] + t * r0, p1[1] + t * r1];
}

/**
 * Convex polygon from (unordered) points: sort by angle around centroid
 * and return CCW. For use as a Sutherland-Hodgman clip.
 */
export function convexHull2(points: Polygon2): Polygon2 {
  if (points.length < 3) return points.map((p) => [p[0], p[1]] as Point2);
  // Andrew's monotone chain
  const pts = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const lower: Point2[] = [];
  for (const p of pts) {
    while (lower.length >= 2) {
      const a = lower[lower.length - 2] as Point2;
      const b = lower[lower.length - 1] as Point2;
      if (cross2(a, b, p) <= 0) lower.pop();
      else break;
    }
    lower.push(p as Point2);
  }
  const upper: Point2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as Point2;
    while (upper.length >= 2) {
      const a = upper[upper.length - 2] as Point2;
      const b = upper[upper.length - 1] as Point2;
      if (cross2(a, b, p) <= 0) upper.pop();
      else break;
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function cross2(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
