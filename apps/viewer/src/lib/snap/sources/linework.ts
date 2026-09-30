/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Linework snap source: explicit 2D points and segments already in the
 * workplane-local frame (room vertices and building lines, the
 * 2D plan). Candidate order is part of the contract, because the solver's
 * final tie-break is collection order: vertices, then each segment's two
 * endpoints, then optional midpoints, then the segment bodies.
 *
 * Linework sets are small (one storey's sketch), so it scans rather than
 * indexes.
 */

import { mayLandNear } from '../constraints.js';
import type { CollectHint, SnapCandidate, SnapQuery, SnapSource, Vec2 } from '../types.js';

export interface Linework {
  vertices?: readonly Vec2[];
  segments?: readonly (readonly [Vec2, Vec2])[];
  /** Also offer segment midpoints (off for room-layout snapping). */
  midpoints?: boolean;
  /**
   * Offer EVERY edge, however far, so extension / parallel / intersection
   * inference can track far lines. Required for profiles that rank inferred
   * kinds; points are still pruned (inference never reads them).
   */
  inference?: boolean;
}

/** Closest point on segment a→b to p, clamped to the segment. */
export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy || 1e-9;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * dx, a[1] + t * dy];
}

/**
 * `lines` is read on every collect, so a getter keeps the source current
 * without rebuilding it. With the solver's hint it prunes to targets that can
 * land within `radius` (under a lock that includes far targets aligning along
 * it); without one it returns everything.
 */
export function createLineworkSource(lines: Linework | (() => Linework), id = 'linework'): SnapSource {
  const read = typeof lines === 'function' ? lines : () => lines;
  return {
    id,
    collect(q: SnapQuery, radius: number, out: SnapCandidate[], hint?: CollectHint): void {
      const { vertices = [], segments = [], midpoints = false, inference = false } = read();
      // Hot path (every pointer move over every line): index loops, no closures.
      for (let i = 0; i < vertices.length; i++) {
        const v = vertices[i];
        if (!hint || mayLandNear(hint, radius, v)) out.push({ kind: 'vertex', local: v, source: 'linework' });
      }
      for (let i = 0; i < segments.length; i++) {
        const a = segments[i][0], b = segments[i][1];
        if (!hint || mayLandNear(hint, radius, a)) out.push({ kind: 'endpoint', local: a, source: 'linework' });
        if (!hint || mayLandNear(hint, radius, b)) out.push({ kind: 'endpoint', local: b, source: 'linework' });
      }
      if (midpoints) {
        for (let i = 0; i < segments.length; i++) {
          const a = segments[i][0], b = segments[i][1];
          const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (!hint || mayLandNear(hint, radius, m)) out.push({ kind: 'midpoint', local: m, source: 'linework' });
        }
      }
      for (let i = 0; i < segments.length; i++) {
        const a = segments[i][0], b = segments[i][1];
        if (hint && !inference && !mayLandNear(hint, radius, a, b)) continue;
        out.push({
          kind: 'edge', local: closestOnSegment(q.cursor, a, b), source: 'linework',
          guide: { kind: 'segment', a, b, role: 'edge' },
        });
      }
    },
  };
}
