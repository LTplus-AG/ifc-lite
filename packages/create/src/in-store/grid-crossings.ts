/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where grid axes cross: the one list a snap offers and a copy lands on, so a
 * point the cursor can snap to is a point a copy can bind to (#6232, #9199).
 */

import type { Vec2 } from './auto-space-detect.js';
import type { GridAxisSegment } from './extract-grids.js';

/** Only reads its ends, so a caller's readonly points will do. */
export type GridCrossingAxis = Pick<GridAxisSegment, 'gridId' | 'axisId' | 'AxisTag' | 'family'> & {
  a: readonly [number, number];
  b: readonly [number, number];
};

export interface GridCrossing {
  gridId: number;
  IntersectingAxes: readonly [number, number];
  /** Tags of the two crossing axes, first family first ('2', 'B'). */
  tags: readonly [string, string];
  at: Vec2;
}

const EPS = 1e-9;

/**
 * Where axes of DIFFERENT families of the same grid cross, within both
 * segments (a few millimetres of slack for axes drawn end to end). Axes of one
 * family are parallel by construction and never counted.
 */
export function gridAxisIntersections(axes: readonly GridCrossingAxis[], slack = 1e-6): GridCrossing[] {
  const out: GridCrossing[] = [];
  for (let i = 0; i < axes.length; i++) {
    for (let j = i + 1; j < axes.length; j++) {
      const p = axes[i], q = axes[j];
      if (p.gridId !== q.gridId || p.family === q.family) continue;
      const rx = p.b[0] - p.a[0], ry = p.b[1] - p.a[1];
      const sx = q.b[0] - q.a[0], sy = q.b[1] - q.a[1];
      const denom = rx * sy - ry * sx;
      if (Math.abs(denom) < EPS * Math.hypot(rx, ry) * Math.hypot(sx, sy)) continue;
      const qpx = q.a[0] - p.a[0], qpy = q.a[1] - p.a[1];
      const t = (qpx * sy - qpy * sx) / denom;
      const u = (qpx * ry - qpy * rx) / denom;
      const lo = -slack, hi = 1 + slack;
      if (t < lo || t > hi || u < lo || u > hi) continue;
      out.push({ gridId: p.gridId, IntersectingAxes: [p.axisId, q.axisId], tags: [p.AxisTag, q.AxisTag], at: [p.a[0] + t * rx, p.a[1] + t * ry] });
    }
  }
  return out;
}
