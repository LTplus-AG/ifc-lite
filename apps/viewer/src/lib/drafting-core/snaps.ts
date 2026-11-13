/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Object snaps: a uniform-grid spatial index over shape primitives and the
 * snap resolver that picks the best key point near the cursor.
 */

import type { DraftShape, Pt, SnapHit, SnapMode } from './types';
import { nearestOnShape, onArcSweep, primBounds, shapeKeyPoints, shapePrims, type Bounds } from './curves';
import { intersectShapes } from './intersect';
import { add, angleOf, dist, dot, polar, scale, sub, EPS } from './vec';

/** Max cells a single primitive may occupy before it goes to the always-returned list. */
const MAX_CELLS_PER_PRIM = 1024;

/**
 * Uniform grid over primitive bounds. Each shape index is stored in every
 * cell its primitives overlap (plus the cell of a circle/arc centre so a
 * centre snap is found even when the cursor is far from the curve).
 */
export class SnapIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly oversized: number[] = [];
  private readonly minX: number;
  private readonly minY: number;
  private readonly cell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly marks: Uint32Array;
  private stamp = 0;

  constructor(shapes: readonly DraftShape[], cellSize?: number) {
    const boxes: Bounds[][] = shapes.map((s) => shapePrims(s).map(primBounds));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let primCount = 0;
    for (const list of boxes) {
      for (const b of list) {
        minX = Math.min(minX, b.min.x);
        minY = Math.min(minY, b.min.y);
        maxX = Math.max(maxX, b.max.x);
        maxY = Math.max(maxY, b.max.y);
        primCount++;
      }
    }
    if (!Number.isFinite(minX)) {
      minX = minY = 0;
      maxX = maxY = 1;
    }
    const extent = Math.max(maxX - minX, maxY - minY, EPS);
    const auto = extent / Math.max(1, Math.ceil(Math.sqrt(primCount)));
    this.cell = cellSize && cellSize > 0 ? cellSize : Math.max(auto, extent / 4096, 1e-6);
    this.minX = minX;
    this.minY = minY;
    this.nx = Math.max(1, Math.floor((maxX - minX) / this.cell) + 1);
    this.ny = Math.max(1, Math.floor((maxY - minY) / this.cell) + 1);
    this.marks = new Uint32Array(shapes.length);

    shapes.forEach((shape, i) => {
      for (const b of boxes[i]) this.insert(i, b);
      if (shape.type === 'circle' || shape.type === 'arc') this.insert(i, { min: shape.c, max: shape.c });
    });
  }

  private ix(x: number): number {
    return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.minX) / this.cell)));
  }

  private iy(y: number): number {
    return Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.minY) / this.cell)));
  }

  private insert(i: number, b: Bounds): void {
    const x0 = this.ix(b.min.x);
    const x1 = this.ix(b.max.x);
    const y0 = this.iy(b.min.y);
    const y1 = this.iy(b.max.y);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_PRIM) {
      if (this.oversized[this.oversized.length - 1] !== i) this.oversized.push(i);
      return;
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const key = y * this.nx + x;
        const list = this.cells.get(key);
        if (!list) this.cells.set(key, [i]);
        else if (list[list.length - 1] !== i) list.push(i);
      }
    }
  }

  /** Indices of shapes whose primitives (or centre) may overlap the box. */
  query(min: Pt, max: Pt): number[] {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.marks.fill(0);
      this.stamp = 1;
    }
    const out: number[] = [];
    const take = (i: number): void => {
      if (this.marks[i] !== this.stamp) {
        this.marks[i] = this.stamp;
        out.push(i);
      }
    };
    for (const i of this.oversized) take(i);
    const x0 = this.ix(min.x);
    const x1 = this.ix(max.x);
    const y0 = this.iy(min.y);
    const y1 = this.iy(max.y);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const list = this.cells.get(y * this.nx + x);
        if (list) for (const i of list) take(i);
      }
    }
    return out.sort((a, b) => a - b);
  }
}

export interface SnapOptions {
  tolerance: number;
  modes: ReadonlySet<SnapMode>;
  from?: Pt | null;
}

const PRIORITY: readonly SnapMode[] = [
  'endpoint',
  'intersection',
  'midpoint',
  'center',
  'quadrant',
  'perpendicular',
  'nearest',
];

/** Feet of the perpendicular from `from` onto the shape's primitives. */
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

export function findSnap(
  cursor: Pt,
  shapes: readonly DraftShape[],
  index: SnapIndex | null,
  opts: SnapOptions,
): SnapHit | null {
  const tol = opts.tolerance;
  const { modes } = opts;
  const ids = index
    ? index.query({ x: cursor.x - tol, y: cursor.y - tol }, { x: cursor.x + tol, y: cursor.y + tol })
    : shapes.map((_, i) => i);

  const best = new Map<SnapMode, { point: Pt; d: number }>();
  const offer = (mode: SnapMode, point: Pt, limit = tol): void => {
    if (!modes.has(mode)) return;
    const d = dist(point, cursor);
    if (d > limit) return;
    const cur = best.get(mode);
    if (!cur || d < cur.d) best.set(mode, { point, d });
  };

  const nearCurve: DraftShape[] = [];
  for (const i of ids) {
    const shape = shapes[i];
    if (!shape) continue;
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
