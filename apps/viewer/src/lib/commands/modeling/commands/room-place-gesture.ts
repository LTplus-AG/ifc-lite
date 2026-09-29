/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place`'s gesture (charter #6232 M4). Its own module so the bar, the
 * scene and the plan layer read it without importing the command.
 *
 * Pick: hover a region bounded by walls, click to make it a room.
 * Draw: a free room outlined with the slab gesture — a rectangle from two
 * corners, or a polygon (Enter, a double-click or a click back on the first
 * corner closes it; Backspace drops the last).
 * The bar's Auto and Update actions commit through the same command with
 * `action` set, so each is one transaction and one undo step.
 */

import type { Vec2 } from '@/lib/snap/types';
import type { ViewerState } from '@/store';
import type { SlabDrawMode } from '@/store/slices/authoringDefaultsSlice';
import type { RoomBoundary, RoomCandidate } from '@/lib/rooms/storey-rooms';
import { initSlabGesture, previewOutline, rectangleExtent, type SlabPlaceGesture } from './slab-place-geometry.js';

export type RoomMode = 'pick' | 'draw';
export type RoomAction = 'place' | 'auto' | 'update';

export interface RoomPlaceGesture {
  readonly mode: RoomMode;
  /** Which wall face derived rooms follow. */
  readonly boundary: RoomBoundary;
  /** Draw: the outline, drawn with the slab gesture (a rectangle, or a polygon). */
  readonly draw: SlabPlaceGesture;
  /** Pick: the cursor, and the room under it. */
  readonly cursor: Vec2 | null;
  readonly hover: RoomCandidate | null;
  /** What the next commit does. */
  readonly action: RoomAction;
}

export const initRoomGesture = (
  mode: RoomMode = 'pick',
  boundary: RoomBoundary = 'inner',
  drawMode: SlabDrawMode = 'rectangle',
): RoomPlaceGesture => ({
  mode, boundary, draw: initSlabGesture(drawMode), cursor: null, hover: null, action: 'place',
});

/** Draw: the outline the preview shows (the rectangle, or the polygon so far plus the cursor). */
export function drawnOutline(g: RoomPlaceGesture): Vec2[] | null {
  return previewOutline(g.draw);
}

type SpaceParams = Parameters<ViewerState['addSpace']>[2];

/**
 * The `addSpace` params for a drawn outline at storey-local height `z`,
 * `height` tall (lane A2's `space.place` core, which the Room tool's Draw
 * mode supersedes).
 */
export function spaceParams(g: SlabPlaceGesture, z: number, height: number): SpaceParams {
  if (g.mode === 'polygon') {
    return { Profile: 'polygon', OuterCurve: g.points.map((p) => [p[0], p[1]]), Position: [0, 0, z], Height: height };
  }
  const rect = rectangleExtent(g);
  if (!rect) throw new Error('The rectangle has no area');
  return { Position: [rect.min[0], rect.min[1], z], Width: rect.width, Depth: rect.depth, Height: height };
}
