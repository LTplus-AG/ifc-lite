/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place`'s gesture (charter #6232 M4). Its own module so the bar, the
 * scene and the plan layer read it without importing the command.
 *
 * Pick: hover a region bounded by walls, click to make it a room.
 * Draw: a click per corner of a free room (Enter, a double-click or a click
 * back on the first corner closes it; Backspace drops the last).
 * The bar's Auto and Update actions commit through the same command with
 * `action` set, so each is one transaction and one undo step.
 */

import type { Vec2 } from '@/lib/snap/types';
import type { RoomBoundary, RoomCandidate } from '@/lib/rooms/storey-rooms';

export type RoomMode = 'pick' | 'draw';
export type RoomAction = 'place' | 'auto' | 'update';

export interface RoomPlaceGesture {
  readonly mode: RoomMode;
  /** Which wall face derived rooms follow. */
  readonly boundary: RoomBoundary;
  /** Draw: the corners placed so far. */
  readonly points: readonly Vec2[];
  readonly cursor: Vec2 | null;
  /** Pick: the room under the cursor. */
  readonly hover: RoomCandidate | null;
  /** What the next commit does. */
  readonly action: RoomAction;
}

export const initRoomGesture = (mode: RoomMode = 'pick', boundary: RoomBoundary = 'inner'): RoomPlaceGesture => ({
  mode, boundary, points: [], cursor: null, hover: null, action: 'place',
});

/** A click this close to the first corner closes the drawn room. */
const CLOSE_TOLERANCE = 1e-6;

export function closesRoom(g: RoomPlaceGesture, p: Vec2): boolean {
  const first = g.points[0];
  return g.points.length >= 3 && first !== undefined && Math.hypot(p[0] - first[0], p[1] - first[1]) < CLOSE_TOLERANCE;
}

/** Draw: the corners so far plus the cursor, once that makes an area. */
export function drawnOutline(g: RoomPlaceGesture): Vec2[] | null {
  const outline = [...g.points, ...(g.cursor ? [g.cursor] : [])];
  return outline.length >= 3 ? outline : null;
}
