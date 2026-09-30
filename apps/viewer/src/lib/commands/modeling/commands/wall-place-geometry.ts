/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `wall.place`'s gesture and the one rule for where the next wall ends
 * (charter #6232, WP2). Its own module so the command's HUD scene can read
 * it without importing the command (which imports the scene).
 */

import { dist } from '@/lib/snap/constraints';
import type { Vec2 } from '@/lib/snap/types';

export const MIN_WALL_LENGTH = 0.01;
/** A wall ending within this of the chain's first point (metres) closes the loop. */
export const CLOSE_TOLERANCE = 0.05;

/** Unit direction at `deg` (0 = +x, CCW), exact at multiples of 90° like the solver's angle lock. */
function unitAt(deg: number): Vec2 {
  const r = ((deg % 360) + 360) % 360;
  const exact: Record<number, Vec2> = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };
  return exact[r] ?? [Math.cos((r * Math.PI) / 180), Math.sin((r * Math.PI) / 180)];
}

export interface WallPlaceGesture {
  /** Placed points, oldest first; the last one is the anchor of the next wall. */
  chain: Vec2[];
  /** The solved cursor on the workplane. */
  cursor: Vec2 | null;
  /** Typed locks for the next segment: metres, degrees (0 = +x, CCW). */
  length: number | null;
  angle: number | null;
  /**
   * The walls this chain has placed (`wall.place` only; beams, stairs and railings draw the same gesture and leave it out), oldest first: wall `i` runs from point
   * `i` to point `i + 1`, so the last one ends at the anchor. Joins name them.
   */
  walls?: number[];
}

export const anchorOf = (g: WallPlaceGesture): Vec2 | null => g.chain[g.chain.length - 1] ?? null;

/** Where the next wall ends: the cursor, constrained by the typed locks. */
export function endPoint(g: WallPlaceGesture): Vec2 | null {
  const anchor = anchorOf(g);
  if (!anchor) return null;
  const toward: Vec2 | null = g.cursor ? [g.cursor[0] - anchor[0], g.cursor[1] - anchor[1]] : null;
  const reach = toward ? Math.hypot(toward[0], toward[1]) : 0;
  let dir: Vec2 | null = g.angle !== null ? unitAt(g.angle) : toward && reach > 1e-9 ? [toward[0] / reach, toward[1] / reach] : null;
  if (g.length !== null) {
    dir ??= [1, 0];
    return [anchor[0] + dir[0] * g.length, anchor[1] + dir[1] * g.length];
  }
  if (!g.cursor) return null;
  if (g.angle === null || !dir || !toward) return g.cursor;
  const along = Math.max(0, toward[0] * dir[0] + toward[1] * dir[1]);
  return [anchor[0] + dir[0] * along, anchor[1] + dir[1] * along];
}


/**
 * The wall axis for a drawn line a→b: with Align Left or Right the drawn line
 * is that face of the wall (walking a→b), so the axis sits t/2 to the other
 * side along the line's normal; Centre draws the axis itself.
 */
export function alignedAxis(a: Vec2, b: Vec2, thickness: number, align: 'left' | 'centre' | 'right'): [Vec2, Vec2] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (align === 'centre' || !(length > 1e-9)) return [a, b];
  // Unit normal to the right of a→b, scaled by half the thickness.
  const side = align === 'left' ? thickness / 2 : -thickness / 2;
  const ox = (dy / length) * side, oy = (-dx / length) * side;
  return [[a[0] + ox, a[1] + oy], [b[0] + ox, b[1] + oy]];
}

/** The segment's length as the Length field shows it: the lock, else the live one. */
export function currentLength(g: WallPlaceGesture): number | null {
  const anchor = anchorOf(g);
  const end = endPoint(g);
  return g.length ?? (anchor && end ? dist(anchor, end) : null);
}

/** The segment's angle as the Angle field shows it (0 = +x, CCW). */
export function currentAngle(g: WallPlaceGesture): number | null {
  const anchor = anchorOf(g);
  const end = endPoint(g);
  if (g.angle !== null) return g.angle;
  if (!anchor || !end || dist(anchor, end) < 1e-9) return null;
  return ((Math.atan2(end[1] - anchor[1], end[0] - anchor[0]) * 180) / Math.PI + 360) % 360;
}

/**
 * The walls the next one is joined to: the one before it in the chain, and the
 * chain's first wall when the new wall ends on the chain's first point.
 */
export function chainPartners(g: WallPlaceGesture): { partners: number[]; closes: boolean } {
  const walls = g.walls ?? [];
  const last = walls.length === g.chain.length - 1 ? walls[walls.length - 1] : undefined;
  const end = endPoint(g);
  const closes = walls.length >= 2 && end !== null && dist(end, g.chain[0]) <= CLOSE_TOLERANCE;
  return { partners: [...(last === undefined ? [] : [last]), ...(closes ? [walls[0]] : [])], closes };
}
