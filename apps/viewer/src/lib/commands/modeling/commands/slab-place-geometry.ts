/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `slab.place`'s gesture and the outline it draws (charter #6232, M2). Its
 * own module so the bar and the scene can read it without importing the
 * command.
 *
 * Rectangle: the first click is a corner, the cursor the opposite one.
 * Typed Width / Depth lock a side (the cursor still picks the quadrant);
 * Shift squares the rectangle on its longer side.
 * Polygon: every click adds a vertex; the outline closes from the last one
 * back to the first.
 */

import type { Vec2 } from '@/lib/snap/types';
import type { SlabDrawMode } from '@/store/slices/authoringDefaultsSlice';
import { rectOutline } from '../ghost-shapes.js';

export const MIN_SLAB_SIDE = 0.01;
/** A click this close to the first vertex closes the polygon. */
const CLOSE_TOLERANCE = 1e-6;

export interface SlabPlaceGesture {
  readonly mode: SlabDrawMode;
  /** Rectangle: the first corner, once clicked. Polygon: the vertices placed. */
  readonly points: readonly Vec2[];
  readonly cursor: Vec2 | null;
  /** Rectangle side locks (metres), from the typed fields. */
  readonly width: number | null;
  readonly depth: number | null;
  /** Shift held at the last pointer event. */
  readonly square: boolean;
}

export const initSlabGesture = (mode: SlabDrawMode): SlabPlaceGesture => ({
  mode, points: [], cursor: null, width: null, depth: null, square: false,
});

const sign = (v: number) => (v < 0 ? -1 : 1);

/** The rectangle's second corner: the cursor, with the typed locks and Shift applied. */
export function rectangleCorner(g: SlabPlaceGesture): Vec2 | null {
  const first = g.points[0];
  if (!first) return null;
  const dx = g.cursor ? g.cursor[0] - first[0] : 1;
  const dy = g.cursor ? g.cursor[1] - first[1] : 1;
  let w = g.width ?? (g.cursor ? Math.abs(dx) : null);
  let d = g.depth ?? (g.cursor ? Math.abs(dy) : null);
  if (w === null || d === null) return null;
  if (g.square) {
    const side = g.width ?? g.depth ?? Math.max(w, d);
    w = side;
    d = side;
  }
  return [first[0] + sign(dx) * w, first[1] + sign(dy) * d];
}

/** The rectangle as min corner + size, as `addSlab` takes it. Null until it has an area. */
export function rectangleExtent(g: SlabPlaceGesture): { min: Vec2; width: number; depth: number } | null {
  const first = g.points[0];
  const corner = rectangleCorner(g);
  if (!first || !corner) return null;
  const width = Math.abs(corner[0] - first[0]);
  const depth = Math.abs(corner[1] - first[1]);
  if (width < MIN_SLAB_SIDE || depth < MIN_SLAB_SIDE) return null;
  return { min: [Math.min(first[0], corner[0]), Math.min(first[1], corner[1])], width, depth };
}

/** The outline the preview shows: the rectangle, or the polygon so far plus the cursor. */
export function previewOutline(g: SlabPlaceGesture): Vec2[] | null {
  if (g.mode === 'rectangle') {
    const first = g.points[0];
    const corner = rectangleCorner(g);
    return first && corner ? rectOutline(first, corner) : null;
  }
  const outline = [...g.points, ...(g.cursor ? [g.cursor] : [])];
  return outline.length >= 3 ? outline : null;
}

/** Whether a polygon click at `p` lands back on the first vertex (closing it). */
export function closesPolygon(g: SlabPlaceGesture, p: Vec2): boolean {
  const first = g.points[0];
  return g.points.length >= 3 && first !== undefined && Math.hypot(p[0] - first[0], p[1] - first[1]) < CLOSE_TOLERANCE;
}
