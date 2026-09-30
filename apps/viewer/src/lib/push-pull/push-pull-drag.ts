/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Following a push / pull drag (charter #6232, C4).
 *
 * A face handle's press starts `element.pushPull` (or, when it already runs
 * because the tool was launched from the rail, arms the face) and this module
 * follows the pointer on the window, like the wall-end drag does: the handle
 * unmounts as the tool switches, so it cannot hold pointer capture.
 *
 * The distance is read in screen space, as the move gizmo does: the face's
 * normal is projected to the screen once (pixels per metre along it), and the
 * pointer's travel is that vector's share, so it works for a vertical face
 * the workplane cursor cannot reach. It is snapped (`push-pull-snap.ts`) and
 * written into the gesture; nothing is written to the model until the commit.
 *
 * Release after a drag commits. A press released without a drag leaves the
 * face armed: the pointer keeps steering it until a click, Enter or a typed
 * size (which stops the steering) commits, Escape cancels.
 */

import { useViewerStore } from '@/store';
import { commitCommand, getCommandRuntime, updateCommandGesture } from '@/lib/commands/modeling/runtime';
import type { PushPullGesture } from './push-pull-gesture';
import type { Vec3 } from '@/lib/commands/modeling/types';
import { levelHeights, snapSize } from './push-pull-snap';
import type { PushPullFace, PushPullTarget } from './push-pull-target';

/** The command this drag steers. */
export const PUSH_PULL_COMMAND_ID = 'element.pushPull';

/** Pointer travel (px) that makes a press a drag rather than a click. */
const DRAG_PX = 4;
/** A face whose normal projects to fewer pixels per metre than this cannot be dragged (it points at the camera). */
const MIN_PX_PER_METRE = 4;

export interface ScreenAxis { readonly x: number; readonly y: number }

/** Pixels per metre of travel along `face`'s normal, on screen; null when the axis is edge-on to the view. */
export function faceScreenAxis(
  target: PushPullTarget,
  face: PushPullFace,
  project: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null,
): ScreenAxis | null {
  const at = (p: Vec3) => { const r = target.plane.localToRender(p); return project({ x: r[0], y: r[1], z: r[2] }); };
  const a = at(face.origin);
  const b = at([face.origin[0] + face.normal[0], face.origin[1] + face.normal[1], face.origin[2] + face.normal[2]]);
  if (!a || !b) return null;
  const axis = { x: b.x - a.x, y: b.y - a.y };
  return Math.hypot(axis.x, axis.y) >= MIN_PX_PER_METRE ? axis : null;
}

/** The size a pointer `dx`,`dy` pixels from the press asks of `face`. */
export function draggedSize(face: PushPullFace, axis: ScreenAxis, dx: number, dy: number): number {
  const travel = (dx * axis.x + dy * axis.y) / (axis.x * axis.x + axis.y * axis.y);
  return face.size + travel * face.gain;
}

const running = (): boolean => getCommandRuntime().command?.id === PUSH_PULL_COMMAND_ID;

/** A face handle was pressed at `press` (client pixels): grab it and follow the pointer. */
export function beginPushPullDrag(faceId: PushPullFace['id'], press: { x: number; y: number }): void {
  const store = useViewerStore.getState();
  if (!running()) store.startCommand(PUSH_PULL_COMMAND_ID);
  if (!running()) return;
  const gesture = getCommandRuntime().gesture as PushPullGesture;
  const face = gesture.target?.faces.find((f) => f.id === faceId);
  const project = useViewerStore.getState().cameraCallbacks.projectToScreen;
  if (!gesture.target || !face) return;
  updateCommandGesture((g) => ({ ...(g as PushPullGesture), faceId, size: null, typed: false, snapped: null }));
  const axis = project ? faceScreenAxis(gesture.target, face, project) : null;
  if (!axis) return; // edge-on: type the size instead
  const levels = levelHeights(useViewerStore.getState(), gesture.target);
  let dragged = false;

  const steer = (e: PointerEvent): boolean => {
    if (!running()) return false;
    const now = getCommandRuntime().gesture as PushPullGesture;
    if (now.typed) return false; // a typed size stops the pointer steering
    const dx = e.clientX - press.x, dy = e.clientY - press.y;
    dragged = dragged || Math.hypot(dx, dy) >= DRAG_PX;
    if (!dragged) return true;
    const snap = snapSize(face, draggedSize(face, axis, dx, dy), {
      enabled: useViewerStore.getState().snapEnabled && !e.altKey,
      fine: e.shiftKey,
      levels,
    });
    updateCommandGesture((g) => ({ ...(g as PushPullGesture), size: snap.size, snapped: snap.kind }));
    return true;
  };
  const move = (e: PointerEvent) => { if (!steer(e)) window.removeEventListener('pointermove', move); };
  const up = (e: PointerEvent) => {
    window.removeEventListener('pointerup', up);
    if (!running()) return;
    if (dragged && steer(e)) commitCommand();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
