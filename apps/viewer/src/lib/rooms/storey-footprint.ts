/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Footprint: one room over a storey's whole outline (moved from Space Sketch
 * into the Room tool, charter #6232 M4).
 *
 * The outline is the storey's room layout with every wall between two rooms
 * merged away (`mergeFaces`) and the orphans pruned: what is left is the
 * region the exterior walls enclose, L- and U-shaped plans included, whose
 * `netOutline` gives the inner and outer wall faces like any room's.
 *
 * Where the walls enclose nothing (an open plan with gaps), Space Sketch's
 * outline stands in: the CONVEX HULL of every wall-rectangle corner, emitted
 * as thin synthetic walls so the same plate build encloses exactly one room.
 */

import { SpacePlateHandle } from '@ifc-lite/wasm';
import { convexHull, type WallRect } from '@/lib/wall-rects-from-meshes';
import { polyArea } from '@/lib/space-sketch-geometry';
import type { Boundary, Room } from '@/lib/space-plate-session';
import { buildPlate, readFaces, type LayoutFace } from './room-layout';

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

/** Merge every pair of rooms that share a wall, until none do. */
function mergeAll(h: SpacePlateHandle): void {
  for (let guard = h.roomCount; guard > 0; guard--) {
    const rooms = new Set(h.roomIds());
    let merged = false;
    for (const room of h.snapshot() as Room[]) {
      for (const b of h.boundingElements(room.face) as Boundary[]) {
        const across = h.neighborAcross(b.edge);
        if (across === undefined || across === room.face || !rooms.has(across)) continue;
        try { h.mergeFaces(b.edge); merged = true; } catch { continue; }
        break;
      }
      if (merged) break;
    }
    if (!merged) return;
  }
}

/** The largest face of a plate built from `rects` after `edit`, freed before returning. */
function largestFace(rects: readonly (readonly [number, number][])[], weld: number, edit: (h: SpacePlateHandle) => void): LayoutFace | null {
  const plate = buildPlate(rects, weld);
  try {
    edit(plate);
    const faces = readFaces(plate);
    return faces.reduce<LayoutFace | null>((best, f) => (!best || polyArea(f.centre) > polyArea(best.centre) ? f : best), null);
  } finally {
    plate.free();
  }
}

/** The one face over the storey's whole outline, from its walls (storey-local); null without walls. */
export function storeyFootprintFace(walls: readonly WallRect[], weld: number): LayoutFace | null {
  if (walls.length === 0) return null;
  const merged = largestFace(walls.map((w) => w.corners), weld, (h) => { mergeAll(h); h.prune(); });
  if (merged) return merged;
  const hull = perimeterWalls(exteriorPerimeter([...walls]));
  return hull ? largestFace(hull.map((w) => w.corners), weld, () => {}) : null;
}
