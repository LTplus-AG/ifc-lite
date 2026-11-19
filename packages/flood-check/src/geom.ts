/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generic planar polygon primitives in map coordinates. Questions about the
 * building's footprint are asked of the prepared footprint (`region.ts`), never
 * of raw rings.
 */

import type { MapBBox, MapPoint } from './types.js';

/** Even-odd point-in-ring test. */
export function insideRing(p: MapPoint, ring: readonly MapPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const orientation = (a: MapPoint, b: MapPoint, c: MapPoint): number => {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const acx = c.x - a.x;
  const acy = c.y - a.y;
  const cross = abx * acy - aby * acx;
  const tolerance = 1e-12 * Math.max(1, Math.abs(abx * acy), Math.abs(aby * acx));
  return Math.abs(cross) <= tolerance ? 0 : Math.sign(cross);
};

function onSegment(p: MapPoint, a: MapPoint, b: MapPoint): boolean {
  if (orientation(a, b, p) !== 0) return false;
  const tolerance = 1e-9;
  return p.x >= Math.min(a.x, b.x) - tolerance && p.x <= Math.max(a.x, b.x) + tolerance &&
    p.y >= Math.min(a.y, b.y) - tolerance && p.y <= Math.max(a.y, b.y) + tolerance;
}

/** Inclusive segment intersection: a shared endpoint, touch or collinear overlap counts. */
export function segmentsIntersect(a: MapPoint, b: MapPoint, c: MapPoint, d: MapPoint): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC !== abD && cdA !== cdB) return true;
  return (abC === 0 && onSegment(c, a, b)) || (abD === 0 && onSegment(d, a, b)) ||
    (cdA === 0 && onSegment(a, c, d)) || (cdB === 0 && onSegment(b, c, d));
}

function ringsTouchOrCross(a: readonly MapPoint[], b: readonly MapPoint[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i];
    const a1 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a0, a1, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/** True only when a simple ring lies strictly inside another without touching or crossing its boundary. */
export function ringContainsRing(inner: readonly MapPoint[], outer: readonly MapPoint[]): boolean {
  return inner.length >= 3 && outer.length >= 3 && !ringsTouchOrCross(inner, outer) && insideRing(inner[0], outer);
}

function closestOnSegment(p: MapPoint, a: MapPoint, b: MapPoint): MapPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** The closest point on any ring's boundary, its distance and the index of that ring. */
export function closestBoundaryPoint(
  p: MapPoint,
  rings: readonly (readonly MapPoint[])[],
): { point: MapPoint; distance: number; ring: number } | null {
  let best: { point: MapPoint; distance: number; ring: number } | null = null;
  rings.forEach((ring, r) => {
    for (let i = 0; i < ring.length; i++) {
      const q = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.distance) best = { point: q, distance: d, ring: r };
    }
  });
  return best;
}

export function ringArea(ring: readonly MapPoint[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  return Math.abs(s) / 2;
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, without the closing point. */
export function convexHull(points: readonly MapPoint[]): MapPoint[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const turn = (o: MapPoint, a: MapPoint, b: MapPoint) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: MapPoint[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: MapPoint[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

export function bboxOf(points: Iterable<MapPoint>): MapBBox | null {
  let box: MapBBox | null = null;
  for (const p of points) {
    if (!box) box = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
    else {
      box.minX = Math.min(box.minX, p.x);
      box.minY = Math.min(box.minY, p.y);
      box.maxX = Math.max(box.maxX, p.x);
      box.maxY = Math.max(box.maxY, p.y);
    }
  }
  return box;
}

export function expandBBox(box: MapBBox, by: number): MapBBox {
  return { minX: box.minX - by, minY: box.minY - by, maxX: box.maxX + by, maxY: box.maxY + by };
}

/**
 * Join polylines end to end into ONE closed ring, matching endpoints within
 * `tolerance`. Null unless every polyline is used and the chain closes (a
 * T-junction, a gap or two separate loops all give null).
 */
export function chainIntoRing(polylines: readonly (readonly MapPoint[])[], tolerance: number): MapPoint[] | null {
  const lines = polylines.filter((l) => l.length >= 2);
  if (lines.length < 3) return null;
  const near = (a: MapPoint, b: MapPoint) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance;
  const used = new Uint8Array(lines.length);
  const ring: MapPoint[] = [...lines[0]];
  used[0] = 1;
  for (let placed = 1; placed < lines.length; placed++) {
    const end = ring[ring.length - 1];
    let next = -1;
    let reversed = false;
    for (let i = 0; i < lines.length && next < 0; i++) {
      if (used[i]) continue;
      if (near(lines[i][0], end)) next = i;
      else if (near(lines[i][lines[i].length - 1], end)) {
        next = i;
        reversed = true;
      }
    }
    if (next < 0) return null;
    used[next] = 1;
    const pts = reversed ? [...lines[next]].reverse() : lines[next];
    ring.push(...pts.slice(1));
  }
  if (!near(ring[ring.length - 1], ring[0])) return null;
  ring.pop();
  return ring.length >= 3 ? ring : null;
}
