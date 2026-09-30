/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Design-grid snap source (#6232): the axes of the storey's IfcGrids, file
 * and authored, and the points where they cross. Distinct from the
 * construction grid (`grid.ts`, a regular lattice at workplane elevation):
 * these are the building's own structural axes, so walls, columns and curtain
 * walls land on grid lines and grid intersections.
 *
 *   - an axis is an `edge` target carrying an `axis` guide (a click lands on
 *     the line; typed locks slide along it), so it ranks with other edges;
 *   - a crossing of two axes of different families is a `gridIntersection`,
 *     which ranks with intersections and midpoints and shows the grid glyph.
 *
 * Targets are read lazily on the first collect after the version (the store's
 * `mutationVersion`) or the storey changes, never per move. A grid is a few
 * dozen axes, so collection scans instead of indexing.
 */

import { mayLandNear } from '../constraints.js';
import type { CollectHint, SnapCandidate, SnapQuery, SnapSource, Vec2 } from '../types.js';
import { closestOnSegment } from './linework.js';

/** One grid axis in workplane-local metres. */
export interface GridAxisLine {
  /** The IfcGrid the axis belongs to. */
  gridId: number;
  AxisTag: string;
  family: 'U' | 'V' | 'W';
  a: Vec2;
  b: Vec2;
}

export interface GridIntersectionPoint {
  gridId: number;
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
export function gridAxisIntersections(axes: readonly GridAxisLine[], slack = 1e-6): GridIntersectionPoint[] {
  const out: GridIntersectionPoint[] = [];
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
      out.push({ gridId: p.gridId, tags: [p.AxisTag, q.AxisTag], at: [p.a[0] + t * rx, p.a[1] + t * ry] });
    }
  }
  return out;
}

export interface IfcGridSourceDeps {
  modelId: string;
  /** Rebuild key: the store's mutationVersion. */
  version(): number;
  /** The storey whose grids are offered, or null for none. */
  storeyId(): number | null;
  /** The axes visible on a storey, in workplane-local metres. */
  loadAxes(storeyId: number): readonly GridAxisLine[];
}

export interface IfcGridSource extends SnapSource {
  /** How many times the axes were re-read (observability for the rebuild contract). */
  rebuilds(): number;
}

export function createIfcGridSource(deps: IfcGridSourceDeps, id = 'ifc-grid'): IfcGridSource {
  let axes: readonly GridAxisLine[] = [];
  let crossings: readonly GridIntersectionPoint[] = [];
  let builtFor: string | null = null;
  let rebuilds = 0;

  function ensure(): void {
    const storey = deps.storeyId();
    const key = `${storey}:${deps.version()}`;
    if (key === builtFor) return;
    builtFor = key;
    rebuilds++;
    axes = storey === null ? [] : deps.loadAxes(storey);
    crossings = gridAxisIntersections(axes);
  }

  return {
    id,
    rebuilds: () => rebuilds,
    collect(q: SnapQuery, radius: number, out: SnapCandidate[], hint?: CollectHint): void {
      ensure();
      if (axes.length === 0) return;
      const near = (p: Vec2, b?: Vec2): boolean => (hint
        ? mayLandNear(hint, radius, p, b)
        : (b ? distanceToSegment(q.cursor, p, b) : Math.hypot(q.cursor[0] - p[0], q.cursor[1] - p[1])) <= radius);
      // Points first, like every source: the solver's last tie-break is collection order.
      for (const c of crossings) {
        if (!near(c.at)) continue;
        out.push({ kind: 'gridIntersection', local: c.at, source: 'ifc-grid', entity: { modelId: deps.modelId, expressId: c.gridId } });
      }
      for (const axis of axes) {
        if (!near(axis.a, axis.b)) continue;
        out.push({
          kind: 'edge', local: closestOnSegment(q.cursor, axis.a, axis.b), source: 'ifc-grid',
          entity: { modelId: deps.modelId, expressId: axis.gridId },
          guide: { kind: 'segment', a: axis.a, b: axis.b, role: 'axis' },
        });
      }
    },
  };
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const c = closestOnSegment(p, a, b);
  return Math.hypot(p[0] - c[0], p[1] - c[1]);
}
