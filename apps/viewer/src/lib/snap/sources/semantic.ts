/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Semantic snap source: wall AXIS endpoints, midpoints and bodies of the
 * active storey, in workplane-local metres. Unlike mesh snaps these are the
 * design lines walls are drawn on, so a new wall meets an existing one on its
 * axis, not on a face corner.
 *
 * Targets live in uniform grid indexes (points, and samples along each axis
 * for the bodies), rebuilt lazily on the first collect after the version
 * (the store's `mutationVersion`) or the storey changes, never per move.
 */

import { mayLandNear } from '../constraints.js';
import { UniformGridIndex } from '../grid.js';
import type { CollectHint, SnapCandidate, SnapQuery, SnapSource, Vec2 } from '../types.js';
import { closestOnSegment } from './linework.js';

export interface WallAxis {
  expressId: number;
  a: Vec2;
  b: Vec2;
}

export interface SemanticSourceDeps {
  modelId: string;
  /** Rebuild key: the store's mutationVersion (and anything else that moves walls). */
  version(): number;
  /** The storey whose walls are offered, or null for none. */
  storeyId(): number | null;
  /** Wall axes of a storey in workplane-local metres (see `storeyWallAxes`). */
  loadAxes(storeyId: number): readonly WallAxis[];
  /** Index cell size, metres (default 1). */
  cellSize?: number;
  /** Also offer walls whose line (not body) passes near the cursor, for extension tracking. */
  extensions?: boolean;
}

export interface SemanticSource extends SnapSource {
  /** How many times the index was rebuilt (observability for the rebuild contract). */
  rebuilds(): number;
}

interface PointTarget { kind: 'endpoint' | 'midpoint'; axis: number }

export function createSemanticSource(deps: SemanticSourceDeps, id = 'semantic'): SemanticSource {
  const cell = deps.cellSize ?? 1;
  const points = new UniformGridIndex<PointTarget>(cell);
  const bodies = new UniformGridIndex<number>(cell);
  let axes: readonly WallAxis[] = [];
  let builtFor: string | null = null;
  let rebuilds = 0;

  function ensure(): void {
    const storey = deps.storeyId();
    const key = `${storey}:${deps.version()}`;
    if (key === builtFor) return;
    builtFor = key;
    rebuilds++;
    points.clear();
    bodies.clear();
    axes = storey === null ? [] : deps.loadAxes(storey);
    axes.forEach((w, i) => {
      points.insert(w.a, { kind: 'endpoint', axis: i });
      points.insert(w.b, { kind: 'endpoint', axis: i });
      points.insert([(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2], { kind: 'midpoint', axis: i });
      // Samples at most one cell apart: any body point lies within cell/2 of a sample.
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      const n = Math.max(1, Math.ceil(len / cell));
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        bodies.insert([w.a[0] + t * (w.b[0] - w.a[0]), w.a[1] + t * (w.b[1] - w.a[1])], i);
      }
    });
  }

  return {
    id,
    rebuilds: () => rebuilds,
    collect(q: SnapQuery, radius: number, out: SnapCandidate[], hint?: CollectHint): void {
      ensure();
      if (axes.length === 0) return;
      const entity = (i: number) => ({ modelId: deps.modelId, expressId: axes[i].expressId });
      if (hint && (hint.locus.kind === 'line' || hint.locus.kind === 'ray')) {
        // Under a linear lock a far end can still align along it, which a radius
        // query cannot find: scan the storey's walls with the landing test instead.
        axes.forEach((w, i) => {
          const m: Vec2 = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
          if (mayLandNear(hint, radius, w.a)) out.push({ kind: 'endpoint', local: w.a, source: 'semantic', entity: entity(i) });
          if (mayLandNear(hint, radius, w.b)) out.push({ kind: 'endpoint', local: w.b, source: 'semantic', entity: entity(i) });
          if (mayLandNear(hint, radius, m)) out.push({ kind: 'midpoint', local: m, source: 'semantic', entity: entity(i) });
          if (mayLandNear(hint, radius, w.a, w.b)) {
            out.push({
              kind: 'edge', local: closestOnSegment(q.cursor, w.a, w.b), source: 'semantic', entity: entity(i),
              guide: { kind: 'segment', a: w.a, b: w.b, role: 'edge' },
            });
          }
        });
        return;
      }
      points.query(q.cursor, radius, (t, p) => {
        out.push({ kind: t.kind, local: p, source: 'semantic', entity: entity(t.axis) });
      });
      const seen = new Set<number>();
      bodies.query(q.cursor, radius + cell / 2, (i) => {
        if (seen.has(i)) return;
        seen.add(i);
        const w = axes[i];
        out.push({
          kind: 'edge', local: closestOnSegment(q.cursor, w.a, w.b), source: 'semantic', entity: entity(i),
          guide: { kind: 'segment', a: w.a, b: w.b, role: 'edge' },
        });
      });
      if (!deps.extensions) return;
      // Walls whose LINE passes near the cursor, far as their body may be: they
      // feed extension / intersection inference (an edge candidate out of range
      // never wins by itself). One cheap pass over the storey's walls.
      const [cx, cy] = q.cursor;
      axes.forEach((w, i) => {
        if (seen.has(i)) return;
        const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
        const len = Math.hypot(dx, dy);
        if (len === 0 || Math.abs((cx - w.a[0]) * dy - (cy - w.a[1]) * dx) / len > radius) return;
        out.push({
          kind: 'edge', local: closestOnSegment(q.cursor, w.a, w.b), source: 'semantic', entity: entity(i),
          guide: { kind: 'segment', a: w.a, b: w.b, role: 'edge' },
        });
      });
    },
  };
}
