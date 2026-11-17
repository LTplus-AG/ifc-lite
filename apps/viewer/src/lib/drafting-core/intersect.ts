/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Intersections between drafting primitives and shapes.
 *
 * All bounded queries clip to the real extent of each primitive: segment
 * parameters must lie in [0,1] and arc angles inside the CCW sweep, with a
 * coincidence tolerance of 1e-6 m so touching endpoints still count.
 *
 * Collinear overlapping segments: there is no single crossing point, so we
 * return the endpoints of the shared overlap (the points where one segment
 * starts/stops lying on the other). Trim then treats those as cut points,
 * which is what a user expects when two lines partially coincide.
 * Concentric arcs/circles never intersect (coincident ones included).
 */

import type { DraftShape, Pt } from './types';
import { onArcSweep, shapePrims, type ArcPrim, type Prim } from './curves';
import { add, angleOf, cross, dist, dot, len, scale, sub, COINCIDENT, EPS } from './vec';

/** Append `p` unless a coincident point is already present. */
export function pushUnique(out: Pt[], p: Pt, tol = COINCIDENT): void {
  for (const q of out) if (dist(p, q) <= tol) return;
  out.push(p);
}

/**
 * Parameters `t` where the infinite line `o + t·d` meets the circle (c, r).
 * Tangency yields a single parameter.
 */
export function lineCircleParams(o: Pt, d: Pt, c: Pt, r: number): number[] {
  const dd = dot(d, d);
  if (dd < EPS * EPS) return [];
  const tFoot = dot(sub(c, o), d) / dd;
  const foot = add(o, scale(d, tFoot));
  const h = dist(foot, c);
  if (h > r + COINCIDENT) return [];
  if (Math.abs(h - r) <= COINCIDENT) return [tFoot];
  const half = Math.sqrt(Math.max(0, r * r - h * h)) / Math.sqrt(dd);
  return [tFoot - half, tFoot + half];
}

function angTol(r: number): number {
  return r > EPS ? COINCIDENT / r : EPS;
}

function segSeg(a: Pt, b: Pt, c: Pt, d: Pt): Pt[] {
  const d1 = sub(b, a);
  const d2 = sub(d, c);
  const l1 = len(d1);
  const l2 = len(d2);
  if (l1 < EPS || l2 < EPS) return [];
  const den = cross(d1, d2);
  const ac = sub(c, a);
  if (Math.abs(den) <= EPS * l1 * l2) {
    // Parallel. Collinear only when c lies on line a-b.
    if (Math.abs(cross(d1, ac)) / l1 > COINCIDENT) return [];
    const out: Pt[] = [];
    const onSeg = (p: Pt, s0: Pt, dir: Pt, l: number): boolean => {
      const t = dot(sub(p, s0), dir) / (l * l);
      const tol = COINCIDENT / l;
      return t >= -tol && t <= 1 + tol;
    };
    for (const p of [a, b]) if (onSeg(p, c, d2, l2)) pushUnique(out, p);
    for (const p of [c, d]) if (onSeg(p, a, d1, l1)) pushUnique(out, p);
    return out;
  }
  const t = cross(ac, d2) / den;
  const u = cross(ac, d1) / den;
  const tt = COINCIDENT / l1;
  const tu = COINCIDENT / l2;
  if (t < -tt || t > 1 + tt || u < -tu || u > 1 + tu) return [];
  return [add(a, scale(d1, Math.max(0, Math.min(1, t))))];
}

function segArc(a: Pt, b: Pt, arc: ArcPrim): Pt[] {
  const d = sub(b, a);
  const l = len(d);
  if (l < EPS) return [];
  const tol = COINCIDENT / l;
  const out: Pt[] = [];
  for (const t of lineCircleParams(a, d, arc.c, arc.r)) {
    if (t < -tol || t > 1 + tol) continue;
    const p = add(a, scale(d, t));
    if (onArcSweep(arc, angleOf(sub(p, arc.c)), angTol(arc.r))) pushUnique(out, p);
  }
  return out;
}

/** Intersections of the two full circles underlying arc primitives. */
export function circleCircle(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const d = dist(c1, c2);
  if (d < EPS) return [];
  if (d > r1 + r2 + COINCIDENT || d < Math.abs(r1 - r2) - COINCIDENT) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = scale(sub(c2, c1), 1 / d);
  const base = add(c1, scale(u, a));
  if (h <= COINCIDENT) return [base];
  return [
    { x: base.x - u.y * h, y: base.y + u.x * h },
    { x: base.x + u.y * h, y: base.y - u.x * h },
  ];
}

function arcArc(p: ArcPrim, q: ArcPrim): Pt[] {
  const out: Pt[] = [];
  for (const x of circleCircle(p.c, p.r, q.c, q.r)) {
    if (!onArcSweep(p, angleOf(sub(x, p.c)), angTol(p.r))) continue;
    if (!onArcSweep(q, angleOf(sub(x, q.c)), angTol(q.r))) continue;
    pushUnique(out, x);
  }
  return out;
}

export function intersectPrims(p: Prim, q: Prim): Pt[] {
  if (p.kind === 'seg' && q.kind === 'seg') return segSeg(p.a, p.b, q.a, q.b);
  if (p.kind === 'seg' && q.kind === 'arc') return segArc(p.a, p.b, q);
  if (p.kind === 'arc' && q.kind === 'seg') return segArc(q.a, q.b, p);
  if (p.kind === 'arc' && q.kind === 'arc') return arcArc(p, q);
  return [];
}

export function intersectShapes(s1: DraftShape, s2: DraftShape): Pt[] {
  const out: Pt[] = [];
  const p1 = shapePrims(s1);
  const p2 = shapePrims(s2);
  for (const a of p1) for (const b of p2) for (const x of intersectPrims(a, b)) pushUnique(out, x);
  return out;
}

/**
 * Hits of the ray `origin + t·dir` (t ≥ 0) with the bounded target shape,
 * sorted by `t`. `t` is measured in units of `dir`. Segments parallel to the
 * ray are ignored (no unique crossing).
 */
export function intersectRayWithShape(origin: Pt, dir: Pt, shape: DraftShape): { point: Pt; t: number }[] {
  const dl = len(dir);
  if (dl < EPS) return [];
  const tRay = COINCIDENT / dl;
  const hits: { point: Pt; t: number }[] = [];
  const push = (t: number): void => {
    if (t < -tRay) return;
    const point = add(origin, scale(dir, Math.max(0, t)));
    for (const h of hits) if (dist(h.point, point) <= COINCIDENT) return;
    hits.push({ point, t: Math.max(0, t) });
  };
  for (const prim of shapePrims(shape)) {
    if (prim.kind === 'seg') {
      const d2 = sub(prim.b, prim.a);
      const l2 = len(d2);
      if (l2 < EPS) continue;
      const den = cross(dir, d2);
      if (Math.abs(den) <= EPS * dl * l2) continue;
      const ac = sub(prim.a, origin);
      const t = cross(ac, d2) / den;
      const u = cross(ac, dir) / den;
      const tu = COINCIDENT / l2;
      if (u >= -tu && u <= 1 + tu) push(t);
    } else {
      for (const t of lineCircleParams(origin, dir, prim.c, prim.r)) {
        const p = add(origin, scale(dir, t));
        if (onArcSweep(prim, angleOf(sub(p, prim.c)), angTol(prim.r))) push(t);
      }
    }
  }
  hits.sort((x, y) => x.t - y.t);
  return hits;
}

