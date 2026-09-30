/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `element.move`'s gesture (charter #6232, C2). Its own module so the HUD
 * layers can read it without importing the command (which imports them).
 *
 * A move's base → target is a wall's anchor → end: the same cursor, the same
 * typed locks (distance on a circle round the base, direction on a ray from
 * it), so it is read through `wall-place-geometry.ts` rather than a second
 * copy of that rule.
 */

import type { Vec2 } from '@/lib/snap/types';
import type { TransformSelection } from './element-transform-shared.js';
import type { WallPlaceGesture } from './wall-place-geometry.js';

export interface ElementMoveGesture {
  /** What moves; null when nothing is selected. */
  readonly selection: TransformSelection | null;
  /** The picked base point, session-workplane local. */
  readonly base: Vec2 | null;
  readonly cursor: Vec2 | null;
  /** Typed locks: metres, degrees (0 = +x, CCW). */
  readonly distance: number | null;
  readonly angle: number | null;
}

/** The move as a one-segment wall chain: base → target. */
export function moveAsWallGesture(g: ElementMoveGesture): WallPlaceGesture {
  return { chain: g.base ? [g.base] : [], cursor: g.cursor, length: g.distance, angle: g.angle };
}
