/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's snap sources (charter #6232, M2 §1.5). The plan feeds the SAME
 * solver as the 3D viewport (`snap-solve.ts`) with the same semantic
 * wall-axis source; where 3D adds the mesh source over the renderer's pick,
 * the plan adds what it draws:
 *   - `plancut`: the cut outlines and visible projection lines, as WP3
 *     linework (corners, midpoints, edges);
 *   - `grid`: the drawn 1 m grid's nodes, while the grid is shown.
 * `PlanPointer` adds `plancut` to the running command's own profile, so the
 * ranking (endpoint before midpoint before edge before grid) is the one
 * every command already snaps by.
 */

import { createLineworkSource, type Linework } from '@/lib/snap/sources/linework';
import type { SnapSource, Vec2 } from '@/lib/snap/types';
import type { PlanCutPolygon, PlanCutLine } from './usePlanCut';

export const PLAN_CUT_SOURCE_ID = 'plancut';

/** Every edge of the cut outlines (outer rings and holes) plus the visible projection lines. */
export function planCutLinework(polygons: readonly PlanCutPolygon[], lines: readonly PlanCutLine[]): Linework {
  const segments: (readonly [Vec2, Vec2])[] = [];
  const ring = (pts: readonly Vec2[]) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (a[0] !== b[0] || a[1] !== b[1]) segments.push([a, b]);
    }
  };
  for (const polygon of polygons) {
    ring(polygon.outer);
    for (const hole of polygon.holes) ring(hole);
  }
  for (const line of lines) if (!line.hidden) segments.push([line.a, line.b]);
  return { segments, midpoints: true };
}

export function createPlanCutSource(linework: () => Linework): SnapSource {
  return createLineworkSource(linework, PLAN_CUT_SOURCE_ID);
}
