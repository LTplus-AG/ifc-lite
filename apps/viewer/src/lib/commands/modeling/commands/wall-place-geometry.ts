/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `wall.place`'s gesture and the one rule for where the next wall ends
 * (charter #6232, WP2). Its own module so the command's HUD scene can read
 * it without importing the command (which imports the scene).
 */

import { unitAt } from '@/lib/snap/constraints';
import type { Vec2 } from '@/lib/snap/types';

export const MIN_WALL_LENGTH = 0.01;

export interface WallPlaceGesture {
  /** Placed points, oldest first; the last one is the anchor of the next wall. */
  chain: Vec2[];
  /** The solved cursor on the workplane. */
  cursor: Vec2 | null;
  /** Typed locks for the next segment: metres, degrees (0 = +x, CCW). */
  length: number | null;
  angle: number | null;
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

