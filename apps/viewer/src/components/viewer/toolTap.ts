/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tools a click or a touch tap drives at a point without selecting:
 * Section face-pick and a running modeling command. A click reaches them
 * through `handleSelectionClick`, a tap through `routeToolTap` (#9042), so a
 * finger and an Apple Pencil get what the mouse gets.
 */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { routeCommandTap } from './commandPointer.js';
import { markTouchSelection } from './referenceSelection.js';

/**
 * Section-tool face-pick (issue #243): a click or a tap on any visible face
 * places the clip plane through it.
 *
 * Camera-aware orientation: we flip the picked normal if it faces away
 * from the camera, so the kept half-space is the one the user is looking
 * at by default (the most common expectation; if the cut goes the wrong
 * way the existing Flip button still works). This addresses the
 * CodeRabbit minor on PR #581 about face-pick not being camera-aware.
 */
export function pickSectionFaceAt(ctx: MouseHandlerContext, x: number, y: number): void {
  const { renderer } = ctx;
  const hit = renderer.raycastScene(x, y, {
    hiddenIds:   ctx.hiddenEntitiesRef.current,
    isolatedIds: ctx.isolatedEntitiesRef.current,
  });
  if (hit?.intersection) {
    const n = hit.intersection.normal;
    const p = hit.intersection.point;
    const cam = renderer.getCamera().getPosition();
    // View vector = camera → hit. If `dot(view, normal) > 0` the normal
    // points away from the camera; invert so the cut keeps the side
    // facing the user.
    const vx = cam.x - p.x, vy = cam.y - p.y, vz = cam.z - p.z;
    const dot = vx * n.x + vy * n.y + vz * n.z;
    const sign = dot < 0 ? -1 : 1;
    const bounds = ctx.modelBoundsRef?.current;
    ctx.setSectionPlaneFromFace?.(
      [sign * n.x, sign * n.y, sign * n.z],
      [p.x, p.y, p.z],
      bounds ? {
        min: [bounds.min.x, bounds.min.y, bounds.min.z],
        max: [bounds.max.x, bounds.max.y, bounds.max.z],
      } : undefined,
    );
  } else {
    // Missed geometry — disarm so the user isn't stuck in pick mode
    // after an errant background click.
    ctx.setSectionPickMode?.(false);
  }
}

/**
 * Section with face-pick armed picks the face, the command tool runs
 * `command` (a click's down, a tap's press): true when one of them took the
 * point, so it selects nothing.
 */
export function runToolAt(ctx: MouseHandlerContext, tool: string, x: number, y: number, command: () => void): boolean {
  if (tool === 'section' && ctx.sectionPickModeRef?.current) pickSectionFaceAt(ctx, x, y);
  else if (tool === 'command') command();
  else return false;
  return true;
}

/**
 * A touch tap: what a click does in those tools. `ctx` is the mouse
 * controls' (`viewportHandlerContext`).
 */
export function routeToolTap(ctx: MouseHandlerContext | null, tool: string, x: number, y: number): boolean {
  // Null: the mouse controls are not mounted on this canvas
  if (!ctx || !runToolAt(ctx, tool, x, y, () => routeCommandTap(ctx, x, y))) return false;
  // Touchend owns the tap: its compatibility click must not run the tool a second time (#4555).
  markTouchSelection(ctx.canvas, x, y);
  return true;
}
