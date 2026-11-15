/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Planar helpers over footprint rings in map coordinates. */

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

export function insideAny(p: MapPoint, rings: readonly (readonly MapPoint[])[]): boolean {
  return rings.some((ring) => insideRing(p, ring));
}

function closestOnSegment(p: MapPoint, a: MapPoint, b: MapPoint): MapPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** The closest point on any ring's boundary, and its distance. */
export function closestBoundaryPoint(
  p: MapPoint,
  rings: readonly (readonly MapPoint[])[],
): { point: MapPoint; distance: number } | null {
  let best: { point: MapPoint; distance: number } | null = null;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const q = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length]);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.distance) best = { point: q, distance: d };
    }
  }
  return best;
}

/**
 * Signed distance to the footprint: positive outside, negative inside, in
 * metres. Infinity when there are no rings.
 */
export function signedDistance(p: MapPoint, rings: readonly (readonly MapPoint[])[]): number {
  const c = closestBoundaryPoint(p, rings);
  if (!c) return Infinity;
  return insideAny(p, rings) ? -c.distance : c.distance;
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
