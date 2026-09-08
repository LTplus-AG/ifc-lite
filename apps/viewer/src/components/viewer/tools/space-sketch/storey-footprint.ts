/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Whole footprint" helper for the Space Sketch tool: turn a storey's wall
 * rectangles into a single room covering the storey's exterior perimeter.
 *
 * The perimeter is the CONVEX HULL of every wall-rectangle corner, so it is the
 * true exterior outline only for convex footprints (L / U shaped plans get an
 * over-large hull - flagged in the button tooltip; a non-convex outer loop is a
 * follow-up). The hull edges are emitted as thin synthetic `WallRect`s so the
 * existing `SpacePlateSession.buildFromRects` path detects the single enclosed
 * region. Reusing that path means the footprint room is a normal centreline
 * plate - fully editable, and identical through the preview -> bake flow.
 */

import { convexHull, type WallRect } from '@/lib/wall-rects-from-meshes';

type Pt = [number, number];

/** Convex-hull exterior perimeter (CCW) of all wall-rectangle corners. */
export function exteriorPerimeter(rects: WallRect[]): Pt[] {
  return convexHull(rects.flatMap((r) => r.corners as Pt[]));
}

/**
 * Emit the closed hull as a loop of thin synthetic walls (one per edge),
 * centred on the hull edge, so `buildFromRects` encloses exactly one room whose
 * outline is the hull. Returns null when the hull is degenerate (< 3 points).
 */
export function perimeterWalls(hull: Pt[], thickness = 0.2): WallRect[] | null {
  if (hull.length < 3) return null;
  const half = thickness / 2;
  const out: WallRect[] = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    // Unit normal to the edge.
    const nx = -dy / len;
    const ny = dx / len;
    const ox = nx * half;
    const oy = ny * half;
    const corners: Pt[] = [
      [a[0] + ox, a[1] + oy],
      [b[0] + ox, b[1] + oy],
      [b[0] - ox, b[1] - oy],
      [a[0] - ox, a[1] - oy],
    ];
    out.push({ corners, centreline: [a, b], thickness });
  }
  return out.length >= 3 ? out : null;
}
