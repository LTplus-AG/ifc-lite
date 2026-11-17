/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 2D footprints in EPSG:2056: a building's footprint from its base vertices,
 * whether it touches the site square, and how much it overlaps the model's
 * own footprint (to find the subject building).
 */

import type { MapPoint } from './types.js';

/**
 * Least overlap for a footprint match: the intersection must cover at least
 * this share of the smaller of the two areas (model footprint, building
 * footprint). The smaller area makes a coarse model footprint (a bounding
 * rectangle) still match its building, and a small annex not swallow it.
 */
export const SUBJECT_MIN_OVERLAP = 0.5;

/**
 * Base vertices: those in the lowest quarter of the building's height. Walls
 * are vertical, so their base outline is the footprint; roof overhangs, which
 * stick out above, are left out.
 */
export const BASE_BAND = 0.25;

/** Andrew's monotone chain; counter-clockwise, no repeated closing point. */
export function convexHull(points: MapPoint[]): MapPoint[] {
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
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Signed shoelace area (counter-clockwise positive); a closing repeat of the first point is harmless. */
export function ringArea(ring: MapPoint[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/**
 * The footprint of a building from its vertices in EPSG:2056 (f64, `xyz`
 * triplets): the convex hull of the base vertices (see `BASE_BAND`). A
 * courtyard or notch is filled; that only makes a footprint match more
 * forgiving.
 */
export function baseFootprint(xyz: Float64Array): MapPoint[] {
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 2; i < xyz.length; i += 3) {
    zmin = Math.min(zmin, xyz[i]);
    zmax = Math.max(zmax, xyz[i]);
  }
  const limit = zmin + BASE_BAND * (zmax - zmin);
  const base: MapPoint[] = [];
  for (let i = 0; i < xyz.length; i += 3) if (xyz[i + 2] <= limit) base.push({ x: xyz[i], y: xyz[i + 1] });
  return convexHull(base);
}

/** Sutherland–Hodgman: `subject` (any simple ring) clipped by `clip` (convex, counter-clockwise). */
export function clipToConvex(subject: MapPoint[], clip: MapPoint[]): MapPoint[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const side = (p: MapPoint) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
  }
  return out;
}

/** Area of `ring` inside the convex counter-clockwise `hull`. */
export function overlapArea(ring: MapPoint[], hull: MapPoint[]): number {
  if (hull.length < 3 || ring.length < 3) return 0;
  const ccw = ringArea(ring) < 0 ? [...ring].reverse() : ring;
  return Math.abs(ringArea(clipToConvex(ccw, hull)));
}

/** Whether a convex counter-clockwise hull touches the axis-aligned square (separating axes). */
export function hullTouchesBox(hull: MapPoint[], box: { minX: number; minY: number; maxX: number; maxY: number }): boolean {
  if (hull.length === 0) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of hull) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  if (maxX < box.minX || minX > box.maxX || maxY < box.minY || minY > box.maxY) return false;
  if (hull.length < 3) return true;
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    // Every box corner strictly outside this hull edge: separated.
    if (corners.every((c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) < 0)) return false;
  }
  return true;
}

export function hullCentre(hull: MapPoint[]): MapPoint {
  const n = Math.max(1, hull.length);
  return { x: hull.reduce((s, p) => s + p.x, 0) / n, y: hull.reduce((s, p) => s + p.y, 0) / n };
}

export interface FootprintCandidate {
  index: number;
  hull: MapPoint[];
}

export interface FootprintMatch {
  index: number;
  /** Intersection over the smaller of the two areas. */
  overlap: number;
  /** Other candidates also at or above the threshold. */
  alsoAbove: number;
}

/** The candidate whose footprint overlaps `rings` (outer ring first) the most, if any reaches `SUBJECT_MIN_OVERLAP`. */
export function matchFootprint(rings: MapPoint[][], candidates: FootprintCandidate[]): { best: FootprintMatch | null; bestOverlap: number } {
  const outer = rings[0] ?? [];
  const subjectArea = Math.abs(ringArea(outer));
  let best: FootprintMatch | null = null;
  let bestOverlap = 0;
  let above = 0;
  if (subjectArea <= 0) return { best: null, bestOverlap: 0 };
  for (const c of candidates) {
    const area = Math.abs(ringArea(c.hull));
    if (area <= 0) continue;
    const overlap = overlapArea(outer, c.hull) / Math.min(area, subjectArea);
    if (overlap >= SUBJECT_MIN_OVERLAP) above++;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      if (overlap >= SUBJECT_MIN_OVERLAP) best = { index: c.index, overlap, alsoAbove: 0 };
    }
  }
  if (best) best.alsoAbove = above - 1;
  return { best, bestOverlap };
}
