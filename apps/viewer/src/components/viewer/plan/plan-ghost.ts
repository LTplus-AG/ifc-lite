/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The plan's fallback command ghost (charter #6232, M2 §1.5): a command
 * without its own plan layer (`ModelingCommand.hud.Plan`) still shows where
 * its preview sits, as the footprint of the ghost meshes it hands the 3D
 * overlay: each mesh's vertices mapped onto the workplane, wrapped in their
 * convex hull. One source of truth for the preview, two projections.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec2 } from '@/lib/snap/types';
import type { Workplane } from '@/lib/commands/modeling/types';

const cross = (o: Vec2, a: Vec2, b: Vec2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (Andrew's monotone chain), counter-clockwise, collinear points dropped. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const half = (list: Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half(pts.reverse())];
}

/** Each ghost mesh's footprint on `plane`, workplane-local (degenerate ones dropped). */
export function ghostFootprints(meshes: readonly MeshData[], plane: Workplane): Vec2[][] {
  const out: Vec2[][] = [];
  for (const mesh of meshes) {
    const pts: Vec2[] = [];
    const p = mesh.positions;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const l = plane.renderToLocal([p[i], p[i + 1], p[i + 2]]);
      pts.push([l[0], l[1]]);
    }
    const hull = convexHull(pts);
    if (hull.length >= 3) out.push(hull);
  }
  return out;
}
