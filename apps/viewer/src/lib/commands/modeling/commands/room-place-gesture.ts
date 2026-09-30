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
 * Edit: reshape the storey's room layout : drag a
 * corner, cut a room between two points on its outline, and in Remove merge
 * two rooms across the wall between them or dissolve a corner. Each edit is
 * `action: 'edit'` with its `op`, one transaction.
 * The bar's Auto (this storey or all), Footprint, Update and Clean up
 * actions commit through the same command with `action` set, so each is one
 * transaction and one undo step.
 */

import type { Vec2 } from '@/lib/snap/types';
import type { ViewerState } from '@/store';
import type { SlabDrawMode } from '@/store/slices/authoringDefaultsSlice';
import type { RoomBoundary, RoomCandidate } from '@/lib/rooms/storey-rooms';
import type { LayoutOp } from '@/lib/rooms/room-layout';
import type { LayoutHit } from '@/lib/rooms/room-layout-hit';
import { initSlabGesture, previewOutline, rectangleExtent, type SlabPlaceGesture } from './slab-place-geometry.js';

export type RoomMode = 'pick' | 'draw' | 'edit';
export type RoomAction = 'place' | 'auto' | 'autoAll' | 'footprint' | 'update' | 'edit';
/** Edit mode's two tools: move corners and cut rooms, or merge / remove. */
export type RoomEditTool = 'shape' | 'remove';

export interface RoomEdit {
  tool: RoomEditTool;
  /** What the cursor is over. */
  hover: LayoutHit | null;
  /** A corner being moved: grabbed at `from`, now at `to`. */
  drag: { from: Vec2; to: Vec2; moved: boolean } | null;
  /** A cut's first point, on the room outline. */
  cut: Vec2 | null;
  /** The layout edit the next `edit` commit runs. */
  op: LayoutOp | null;
}

/** The tool's settings, carried from one gesture to the next. */
export interface RoomSettings {
  boundary: RoomBoundary;
  drawMode: SlabDrawMode;
  /** Manual corner weld (m); null = the default. */
  weld: number | null;
  /** Show why regions aren't closed. */
  leaks: boolean;
  tool: RoomEditTool;
}

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
  /** Edit: the layout edit in progress. */
  readonly edit: RoomEdit;
  /** Manual corner weld (m); null = the default. */
  readonly weld: number | null;
  /** Show why regions aren't closed. */
  readonly leaks: boolean;
}

const DEFAULTS: RoomSettings = { boundary: 'inner', drawMode: 'rectangle', weld: null, leaks: false, tool: 'shape' };

export const initRoomEdit = (tool: RoomEditTool = 'shape'): RoomEdit => ({ tool, hover: null, drag: null, cut: null, op: null });

export const initRoomGesture = (mode: RoomMode = 'pick', settings: Partial<RoomSettings> = {}): RoomPlaceGesture => {
  const { boundary, drawMode, weld, leaks, tool } = { ...DEFAULTS, ...settings };
  return { mode, boundary, draw: initSlabGesture(drawMode), cursor: null, hover: null, action: 'place', edit: initRoomEdit(tool), weld, leaks };
};

/** A gesture's settings, to start the next one with. */
export const roomSettings = (g: RoomPlaceGesture): RoomSettings => ({
  boundary: g.boundary, drawMode: g.draw.mode, weld: g.weld, leaks: g.leaks, tool: g.edit.tool,
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

/**
 * The mode and settings a session last used, so Escape (which resets a
 * gesture through `init`) keeps the user in Edit with their weld and boundary
 * instead of dropping back to Pick. Per session: a new session starts fresh.
 */
const remembered = new WeakMap<object, { mode: RoomMode; settings: RoomSettings }>();

export function rememberRoomGesture(session: object, g: RoomPlaceGesture): void {
  remembered.set(session, { mode: g.mode, settings: roomSettings(g) });
}

/** The session's fresh gesture: its remembered mode and settings, else Pick with `settings`. */
export function sessionRoomGesture(session: object, settings: Partial<RoomSettings>): RoomPlaceGesture {
  const last = remembered.get(session);
  return last ? initRoomGesture(last.mode, last.settings) : initRoomGesture('pick', settings);
}
