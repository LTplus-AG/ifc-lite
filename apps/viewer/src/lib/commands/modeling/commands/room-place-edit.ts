/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `room.place`'s Edit mode (charter #6232 M4): the room layout
 * gestures on the command framework, in the plan and in 3D alike.
 *
 *   Move / cut: a corner is grabbed on press and dropped on release after a
 *     drag (plan), or on the next click (click, move, click: 3D, where a
 *     press-drag orbits). A click on an edge starts a cut; a click on another
 *     edge or corner of the same room ends it.
 *   Remove: a click on the wall between two rooms merges them; on a corner,
 *     dissolves it (or removes one of its walls, at a junction).
 *
 * Each finished gesture sets `edit.op` and commits: `commitLayoutEdit` runs
 * the op on a copy of the storey's layout, writes the rooms it touched
 * (`syncLayoutEdit`) and, once the transaction stands, `afterLayoutCommit`
 * files the edited layout under the new undo step.
 */

import type { RoomPlate } from '../../../../../../../packages/create/src/in-store/room-layout-core.js';
import { resolve as translate } from '@/i18n/registry';
import { editError } from '@/lib/space-edit-error';
import type { SnapResult } from '@/lib/snap/types';
import { DEFAULT_WELD, editedLayout, fileLayout, type LayoutFace, type LayoutOp } from '@/lib/rooms/room-layout';
import { layoutHit } from '@/lib/rooms/room-layout-hit';
import { syncLayoutEdit } from '@/lib/rooms/room-layout-sync';
import { storeyRooms, storeyWallRects, type RoomCandidate } from '@/lib/rooms/storey-rooms';
import type { AuthoringTransaction, CommandContext, CommandSignal, CommitResult } from '../types.js';
import type { RoomEdit, RoomPlaceGesture } from './room-place-gesture.js';

/** Pick radius, screen pixels. */
const PICK_PX = 10;
/** A drag shorter than this (screen pixels) is a click. */
const DRAG_PX = 3;
/** How closely an op's positions are re-resolved on the plate (m): they are the plate's own points. */
const RESOLVE_TOL = 0.01;

export const weldOf = (g: RoomPlaceGesture): number => g.weld ?? DEFAULT_WELD;
const mpp = (s: SnapResult) => s.metresPerPixel ?? 0.02;
const withEdit = (g: RoomPlaceGesture, edit: Partial<RoomEdit>): RoomPlaceGesture => ({ ...g, edit: { ...g.edit, ...edit } });

/** The layout edit the gesture has reached, if any: the one a commit now runs. */
export function editOp({ edit }: RoomPlaceGesture): LayoutOp | null {
  if (edit.op) return edit.op;
  if (edit.drag) return edit.drag.moved ? { kind: 'drag', from: edit.drag.from, to: edit.drag.to } : null;
  if (!edit.hover) return null;
  if (edit.tool === 'remove') return { kind: 'remove', at: edit.hover.at };
  return edit.cut ? { kind: 'split', a: edit.cut, b: edit.hover.at } : null;
}

export function editPointerMove(g: RoomPlaceGesture, s: SnapResult, rooms: readonly RoomCandidate[]): RoomPlaceGesture {
  const { drag } = g.edit;
  if (drag) {
    const moved = drag.moved || Math.hypot(s.local[0] - drag.from[0], s.local[1] - drag.from[1]) > DRAG_PX * mpp(s);
    return withEdit({ ...g, cursor: s.local }, { drag: { ...drag, to: s.local, moved } });
  }
  return withEdit({ ...g, cursor: s.local }, { hover: layoutHit(rooms, s.local, PICK_PX * mpp(s)) });
}

/** A press: drop a grabbed corner, finish a cut or a removal, or grab a corner / start a cut. */
export function editPointerDown(g: RoomPlaceGesture): RoomPlaceGesture | CommandSignal {
  const { drag, cut, hover, tool } = g.edit;
  if (drag) return drag.moved ? { commit: true } : withEdit(g, { drag: null });
  if (tool === 'remove' || cut) return hover ? { commit: true } : g;
  if (hover?.kind === 'vertex') return withEdit(g, { drag: { from: hover.at, to: hover.at, moved: false } });
  if (hover?.kind === 'edge') return withEdit(g, { cut: hover.at });
  return g;
}

/** A release after a drag drops the corner; a release after a click keeps it grabbed. */
export function editPointerUp(g: RoomPlaceGesture): RoomPlaceGesture | CommandSignal {
  return g.edit.drag?.moved ? { commit: true } : g;
}

/** The edited layout a commit made, waiting for its transaction to stand. */
let pending: { modelId: string; storeyId: number; weld: number; walls: string; plate: RoomPlate; faces: LayoutFace[] } | null = null;

function dropPending(): void {
  pending?.plate.free();
  pending = null;
}

/** Run `g.edit.op` on the storey's layout and write the rooms it touched. */
export function commitLayoutEdit(g: RoomPlaceGesture, tx: AuthoringTransaction): CommitResult {
  const { modelId, storeyId, workplane } = tx;
  const op = editOp(g);
  if (storeyId === null || !workplane || !op) throw new Error(translate('roomLayout.edit.none'));
  const get = () => tx.store;
  const weld = weldOf(g);
  const before = storeyRooms(get(), modelId, storeyId, workplane, weld, 0);
  if (before.status !== 'ready') throw new Error(translate(before.status === 'loading' ? 'roomTool.loading' : 'roomTool.noWalls'));
  let edited: ReturnType<typeof editedLayout>;
  try {
    edited = editedLayout(get(), modelId, storeyId, weld, storeyWallRects(get(), modelId, storeyId, workplane), op, RESOLVE_TOL);
  } catch (error) {
    throw new Error(translate('roomLayout.edit.refused', { reason: editError(error).message }));
  }
  try {
    if (!edited.changed) throw new Error(translate(op.kind === 'prune' ? 'roomLayout.prune.none' : 'roomLayout.edit.none'));
    const sync = syncLayoutEdit(tx.api, modelId, before.rooms, edited.faces, storeyId);
    dropPending();
    pending = { modelId, storeyId, weld, walls: edited.walls, plate: edited.plate, faces: edited.faces };
    return { created: sync.created, deleted: sync.deleted, remesh: sync.remesh, select: sync.remesh };
  } catch (error) {
    edited.plate.free();
    throw error;
  }
}

/** The transaction stood: file the edited layout under the model's new undo step. */
export function afterLayoutCommit(ctx: CommandContext): void {
  const p = pending;
  if (!p) return;
  if (p.modelId !== ctx.modelId) { dropPending(); return; }
  try {
    fileLayout(ctx.get(), p.modelId, p.storeyId, p.weld, p.walls, p.plate, p.faces);
    pending = null;
  } catch (error) { dropPending(); throw error; }
}

/** Forget an edit whose transaction didn't stand. */
export function discardLayoutEdit(): void {
  dropPending();
}
