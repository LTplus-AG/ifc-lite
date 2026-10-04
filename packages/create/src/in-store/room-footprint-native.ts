/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The native Room footprint policy shared by all hosts (#6232 D5). */
import { polygonArea as polyArea } from './room-footprint-offset.js';
import { readFaces, flattenRoomRects, type RoomPlate, type RoomPlateFactory, type LayoutFace, type Room, type Boundary, type Pt } from './room-layout-core.js';
export interface RoomWallRect { corners: Pt[]; centreline: [Pt, Pt]; thickness: number }

/** Convex hull (Andrew's monotone chain), CCW, of a plan point cloud. */
export function roomConvexHull(pts: Pt[]): Pt[] {
  const uniq = [...new Map(pts.map((p) => [`${p[0].toFixed(5)},${p[1].toFixed(5)}`, p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (uniq.length < 3) return uniq;
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Pt[] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Convex-hull exterior perimeter (CCW) of all wall-rectangle corners. */
export function exteriorPerimeter(rects: RoomWallRect[]): Pt[] {
  return roomConvexHull(rects.flatMap((r) => r.corners as Pt[]));
}

/**
 * Emit the closed hull as a loop of thin synthetic walls (one per edge),
 * centred on the hull edge, so `buildFromRects` encloses exactly one room whose
 * outline is the hull. Returns null when the hull is degenerate (< 3 points).
 */
export function perimeterWalls(hull: Pt[], thickness = 0.2): RoomWallRect[] | null {
  if (hull.length < 3) return null;
  const half = thickness / 2;
  const out: RoomWallRect[] = [];
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
function mergeAll(h: RoomPlate): void {
  for (let guard = h.roomIds().length; guard > 0; guard--) {
    const rooms = new Set(h.roomIds());
    let merged = false;
    for (const room of h.snapshot() as Room[]) {
      for (const b of h.boundingElements(room.face) as Boundary[]) {
        const across = h.neighborAcross(b.edge);
        if (across === undefined || across === room.face || !rooms.has(across)) continue;
        try { h.mergeFaces(b.edge); merged = true; } catch (error) { console.debug('[room.footprint] enclosing wall retained', error); continue; }
        break;
      }
      if (merged) break;
    }
    if (!merged) return;
  }
}

/** The largest face of a plate built from `rects` after `edit`, freed before returning. */
function largestFace(factory: RoomPlateFactory, rects: readonly (readonly [number, number][])[], weld: number, edit: (h: RoomPlate) => void): LayoutFace | null {
  const plate = factory.fromWallRects(flattenRoomRects(rects), weld, .3);
  try {
    edit(plate);
    const faces = readFaces(plate);
    return faces.reduce<LayoutFace | null>((best, f) => (!best || polyArea(f.centre) > polyArea(best.centre) ? f : best), null);
  } finally {
    plate.free();
  }
}

/** The one face over the storey's whole outline, from its walls (storey-local); null without walls. */
export function storeyFootprintFaceInStore(factory: RoomPlateFactory, walls: readonly RoomWallRect[], weld: number): LayoutFace | null {
  if (walls.length === 0) return null;
  const merged = largestFace(factory, walls.map((w) => w.corners), weld, (h) => { mergeAll(h); h.prune(); });
  if (merged) return merged;
  const hull = perimeterWalls(exteriorPerimeter([...walls]));
  return hull ? largestFace(factory, hull.map((w) => w.corners), weld, () => {}) : null;
}
