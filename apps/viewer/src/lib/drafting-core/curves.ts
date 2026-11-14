/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decomposition of drafting shapes into primitives (segments and arcs),
 * plus bounds, nearest-point and key-point queries built on them.
 */

import type { DraftShape, Pt } from './types';
import { add, angleInArc, angleOf, dist, dot, normAngle, polar, scale, sub, sweepOf, EPS, TAU } from './vec';

export type Prim =
  | { kind: 'seg'; a: Pt; b: Pt }
  | { kind: 'arc'; c: Pt; r: number; start: number; end: number; full: boolean };

export type ArcPrim = Extract<Prim, { kind: 'arc' }>;
export type SegPrim = Extract<Prim, { kind: 'seg' }>;

export interface Bounds {
  min: Pt;
  max: Pt;
}

/** CCW sweep of an arc primitive in (0, 2π]. */
export function primSweep(p: ArcPrim): number {
  return p.full ? TAU : sweepOf(p.start, p.end);
}

/** True when `angle` lies on the arc primitive (always for a full circle). */
export function onArcSweep(p: ArcPrim, angle: number, tol = EPS): boolean {
  return p.full || angleInArc(angle, p.start, p.end, tol);
}

export function shapePrims(shape: DraftShape): Prim[] {
  switch (shape.type) {
    case 'line':
      return [{ kind: 'seg', a: shape.a, b: shape.b }];
    case 'polyline': {
      const out: Prim[] = [];
      const n = shape.pts.length;
      for (let i = 0; i + 1 < n; i++) out.push({ kind: 'seg', a: shape.pts[i], b: shape.pts[i + 1] });
      if (shape.closed && n > 2) out.push({ kind: 'seg', a: shape.pts[n - 1], b: shape.pts[0] });
      return out;
    }
    case 'circle':
      return [{ kind: 'arc', c: shape.c, r: shape.r, start: 0, end: 0, full: true }];
    case 'arc':
      return [
        { kind: 'arc', c: shape.c, r: shape.r, start: normAngle(shape.start), end: normAngle(shape.end), full: false },
      ];
  }
}

export function arcEndpoints(c: Pt, r: number, start: number, end: number): { start: Pt; end: Pt } {
  return { start: polar(c, r, start), end: polar(c, r, end) };
}

function boundsOfPts(pts: readonly Pt[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

const QUADRANT_ANGLES = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];

/** Exact bounds of a primitive (arc bounds include in-sweep quadrant extremes). */
export function primBounds(p: Prim): Bounds {
  if (p.kind === 'seg') return boundsOfPts([p.a, p.b]);
  if (p.full) {
    return { min: { x: p.c.x - p.r, y: p.c.y - p.r }, max: { x: p.c.x + p.r, y: p.c.y + p.r } };
  }
  const pts = [polar(p.c, p.r, p.start), polar(p.c, p.r, p.end)];
  for (const q of QUADRANT_ANGLES) if (angleInArc(q, p.start, p.end)) pts.push(polar(p.c, p.r, q));
  return boundsOfPts(pts);
}

export function shapeBounds(shape: DraftShape): Bounds {
  if (shape.type === 'polyline') return boundsOfPts(shape.pts);
  const prims = shapePrims(shape);
  const corners: Pt[] = [];
  for (const p of prims) {
    const b = primBounds(p);
    corners.push(b.min, b.max);
  }
  return boundsOfPts(corners);
}

/** Closest point on a segment and its parameter in [0,1]. */
export function nearestOnSeg(a: Pt, b: Pt, p: Pt): { point: Pt; t: number } {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 < EPS * EPS) return { point: a, t: 0 };
  const t = Math.max(0, Math.min(1, dot(sub(p, a), d) / l2));
  return { point: add(a, scale(d, t)), t };
}

export function nearestOnPrim(prim: Prim, p: Pt): { point: Pt; dist: number } {
  if (prim.kind === 'seg') {
    const { point } = nearestOnSeg(prim.a, prim.b, p);
    return { point, dist: dist(point, p) };
  }
  const v = sub(p, prim.c);
  const ang = Math.hypot(v.x, v.y) < EPS ? prim.start : angleOf(v);
  if (onArcSweep(prim, ang)) {
    const point = polar(prim.c, prim.r, ang);
    return { point, dist: dist(point, p) };
  }
  const s = polar(prim.c, prim.r, prim.start);
  const e = polar(prim.c, prim.r, prim.end);
  const ds = dist(s, p);
  const de = dist(e, p);
  return ds <= de ? { point: s, dist: ds } : { point: e, dist: de };
}

export function nearestOnShape(shape: DraftShape, p: Pt): { point: Pt; dist: number } {
  let best: { point: Pt; dist: number } = { point: p, dist: Infinity };
  for (const prim of shapePrims(shape)) {
    const h = nearestOnPrim(prim, p);
    if (h.dist < best.dist) best = h;
  }
  return best;
}

export interface KeyPoints {
  endpoints: Pt[];
  midpoints: Pt[];
  centers: Pt[];
  quadrants: Pt[];
}

export function shapeKeyPoints(shape: DraftShape): KeyPoints {
  const kp: KeyPoints = { endpoints: [], midpoints: [], centers: [], quadrants: [] };
  switch (shape.type) {
    case 'line':
      kp.endpoints.push(shape.a, shape.b);
      kp.midpoints.push({ x: (shape.a.x + shape.b.x) / 2, y: (shape.a.y + shape.b.y) / 2 });
      break;
    case 'polyline':
      kp.endpoints.push(...shape.pts);
      for (const prim of shapePrims(shape)) {
        if (prim.kind === 'seg') kp.midpoints.push({ x: (prim.a.x + prim.b.x) / 2, y: (prim.a.y + prim.b.y) / 2 });
      }
      break;
    case 'circle':
      kp.centers.push(shape.c);
      for (const q of QUADRANT_ANGLES) kp.quadrants.push(polar(shape.c, shape.r, q));
      break;
    case 'arc': {
      const ends = arcEndpoints(shape.c, shape.r, shape.start, shape.end);
      kp.endpoints.push(ends.start, ends.end);
      kp.midpoints.push(polar(shape.c, shape.r, shape.start + sweepOf(shape.start, shape.end) / 2));
      kp.centers.push(shape.c);
      for (const q of QUADRANT_ANGLES) {
        if (angleInArc(q, shape.start, shape.end)) kp.quadrants.push(polar(shape.c, shape.r, q));
      }
      break;
    }
  }
  return kp;
}
