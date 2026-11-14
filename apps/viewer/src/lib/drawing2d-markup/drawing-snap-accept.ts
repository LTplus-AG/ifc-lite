/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `findSnap` with a candidate filter: only snap points `accept` takes are
 * offered, so the best accepted candidate of each mode competes, not just the
 * best overall. The dimension tool uses it in sheet mode, where a key point
 * clipped out of the viewport must not shadow a visible one nearby
 * (#10076 review). Same candidates, limits and priority as the vendored
 * `findSnap` (`drafting-core/snaps.ts`, byte-pinned, so the filter cannot go
 * there); `drawing-snap-accept.test.ts` checks that with everything accepted
 * the two agree.
 */

import type { DraftShape, Pt, SnapHit, SnapMode } from '../drafting-core/types';
import { nearestOnShape, onArcSweep, shapeKeyPoints, shapePrims } from '../drafting-core/curves';
import { intersectShapes } from '../drafting-core/intersect';
import { add, angleOf, dist, dot, polar, scale, sub, EPS } from '../drafting-core/vec';

export interface AcceptingSnapOptions {
  tolerance: number;
  modes: ReadonlySet<SnapMode>;
  from?: Pt | null;
  accept: (p: Pt) => boolean;
}

const PRIORITY: readonly SnapMode[] = ['endpoint', 'intersection', 'midpoint', 'center', 'quadrant', 'perpendicular', 'nearest'];

/** Feet of the perpendicular from `from` onto the shape's primitives (as `snaps.ts` computes them). */
function perpendicularFeet(shape: DraftShape, from: Pt): Pt[] {
  const out: Pt[] = [];
  for (const prim of shapePrims(shape)) {
    if (prim.kind === 'seg') {
      const d = sub(prim.b, prim.a);
      const l2 = dot(d, d);
      if (l2 < EPS) continue;
      const t = dot(sub(from, prim.a), d) / l2;
      if (t >= -EPS && t <= 1 + EPS) out.push(add(prim.a, scale(d, t)));
    } else {
      const v = sub(from, prim.c);
      if (Math.hypot(v.x, v.y) < EPS) continue;
      const a = angleOf(v);
      for (const ang of [a, a + Math.PI]) {
        if (onArcSweep(prim, ang)) out.push(polar(prim.c, prim.r, ang));
      }
    }
  }
  return out;
}

export function findAcceptedSnap(cursor: Pt, shapes: readonly DraftShape[], opts: AcceptingSnapOptions): SnapHit | null {
  const { tolerance: tol, modes, accept } = opts;
  const best = new Map<SnapMode, { point: Pt; d: number }>();
  const offer = (mode: SnapMode, point: Pt, limit = tol): void => {
    if (!modes.has(mode)) return;
    const d = dist(point, cursor);
    if (d > limit || !accept(point)) return;
    const cur = best.get(mode);
    if (!cur || d < cur.d) best.set(mode, { point, d });
  };

  const nearCurve: DraftShape[] = [];
  for (const shape of shapes) {
    const near = nearestOnShape(shape, cursor);
    const onCurve = near.dist <= tol;
    if (shape.type === 'circle' || shape.type === 'arc') {
      if (onCurve || dist(shape.c, cursor) <= tol) offer('center', shape.c, Infinity);
    }
    if (!onCurve) continue;
    nearCurve.push(shape);
    const kp = shapeKeyPoints(shape);
    for (const p of kp.endpoints) offer('endpoint', p);
    for (const p of kp.midpoints) offer('midpoint', p);
    for (const p of kp.quadrants) offer('quadrant', p);
    if (opts.from && modes.has('perpendicular')) {
      for (const p of perpendicularFeet(shape, opts.from)) offer('perpendicular', p);
    }
    offer('nearest', near.point);
  }

  if (modes.has('intersection')) {
    for (let i = 0; i < nearCurve.length; i++) {
      for (let j = i + 1; j < nearCurve.length; j++) {
        for (const p of intersectShapes(nearCurve[i], nearCurve[j])) offer('intersection', p);
      }
    }
  }

  for (const mode of PRIORITY) {
    const hit = best.get(mode);
    if (hit) return { mode, point: hit.point };
  }
  return null;
}
