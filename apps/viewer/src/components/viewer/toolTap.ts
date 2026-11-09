/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The tools a click or a touch tap drives at a point without selecting:
 * Section face-pick, a running modeling command and an Annotate pin. A click
 * reaches them through `handleSelectionClick`, a tap through `routeToolTap`
 * (#9042, #9123), so a finger and an Apple Pencil get what the mouse gets.
 */

import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { markTouchSelection } from './referenceSelection.js';
import { useViewerStore } from '@/store';
import { fromGlobalIdFromModels } from '@/store/globalId';

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
 * Annotate: drop a pin at the clicked or tapped world point. A miss opens no
 * draft: annotations are anchored to surface points by design, not floating
 * in space.
 */
function dropAnnotationPin(ctx: MouseHandlerContext, x: number, y: number): void {
  const store = useViewerStore.getState();
  // In a shared room, only commenter/editor/admin may drop pins (solo allowed).
  if (!store.canCollabComment()) return;
  const intersection = ctx.renderer.raycastScene(x, y, ctx.getPickOptions())?.intersection;
  if (!intersection) return;
  // Federated models: resolve which model the hit globalId belongs to, so the
  // annotation carries enough context to render its popover header. Falls back
  // to (null, expressId) when there's only the legacy single-model state.
  const modelLookup = fromGlobalIdFromModels(store.models, intersection.expressId);
  store.beginDraft(
    { x: intersection.point.x, y: intersection.point.y, z: intersection.point.z },
    modelLookup?.expressId ?? intersection.expressId ?? null,
    modelLookup?.modelId ?? null,
  );
}

/**
 * Section with face-pick armed picks the face, the command tool runs
 * `command` (a click's down, a tap's press), Annotate drops a pin: true when
 * one of them took the point, so it selects nothing.
 */
export function runToolAt(ctx: MouseHandlerContext, tool: string, x: number, y: number, command: () => void): boolean {
  if (tool === 'section' && ctx.sectionPickModeRef?.current) pickSectionFaceAt(ctx, x, y);
  else if (tool === 'command') command();
  else if (tool === 'annotate') dropAnnotationPin(ctx, x, y);
  else return false;
  return true;
}

/**
 * The tools `runToolAt` drives, and Measure, place something where a click
 * lands, and a click has no time limit: their tap has none short of the long
 * press (#9092, Measure #9228), where tap-to-select keeps its 300 ms.
 */
export function placesOnTap(ctx: MouseHandlerContext | null, tool: string): boolean {
  return tool === 'command' || tool === 'annotate' || tool === 'measure'
    || (tool === 'section' && ctx?.sectionPickModeRef?.current === true);
}

/**
 * A touch tap: what a click does in those tools. `ctx` is the mouse
 * controls' (`viewportHandlerContext`); `command` is the command tool's tap,
 * which `commandTouchPress.ts` owns.
 */
export function routeToolTap(ctx: MouseHandlerContext | null, tool: string, x: number, y: number, command = () => {}): boolean {
  // Null: the mouse controls are not mounted on this canvas
  if (!ctx || !runToolAt(ctx, tool, x, y, command)) return false;
  // Touchend owns the tap: its compatibility click must not run the tool a second time (#4555).
  markTouchSelection(ctx.canvas, x, y);
  return true;
}
