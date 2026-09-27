/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pointer routing for a running modeling command (charter #6232, WP2). The
 * viewport's mouse handlers hand the canvas point here while the active tool
 * is `'command'`; this resolves it to a `SnapResult` and feeds the runtime.
 *
 * Resolution: the geometry under the cursor wins (its render point, mapped
 * onto the session workplane for `local`), else the cursor ray meets the
 * workplane. The snap solver (WP3) plugs in at `resolveCommandSnap`.
 * Moves are coalesced to one resolve per animation frame, using the LATEST
 * cursor position of that frame.
 */

import type { SnapResult } from '@/lib/snap/types';
import { commandPointerDown, commandPointerMove, getCommandRuntime } from '@/lib/commands/modeling/runtime';
import type { CommandContext, Vec3 } from '@/lib/commands/modeling/types';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

let latest: { x: number; y: number } | null = null;

/** The cursor ray in render space, from CSS-pixel canvas coordinates. */
function cursorRay(ctx: MouseHandlerContext, x: number, y: number): { origin: Vec3; direction: Vec3 } | null {
  const camera = ctx.renderer.getCamera();
  const canvas = ctx.renderer.getCanvas();
  if (!camera || !canvas) return null;
  // `unprojectToRay` takes drawing-buffer pixels, which differ from CSS by DPR.
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width > 0 ? (x / rect.width) * canvas.width : x;
  const sy = rect.height > 0 ? (y / rect.height) * canvas.height : y;
  const ray = camera.unprojectToRay(sx, sy, canvas.width, canvas.height);
  if (!ray) return null;
  return { origin: [ray.origin.x, ray.origin.y, ray.origin.z], direction: [ray.direction.x, ray.direction.y, ray.direction.z] };
}

export function resolveCommandSnap(ctx: MouseHandlerContext, command: CommandContext, x: number, y: number): SnapResult | null {
  const hit = ctx.renderer.raycastScene(x, y, ctx.getPickOptions())?.intersection;
  const plane = command.workplane;
  if (hit) {
    const render: Vec3 = [hit.point.x, hit.point.y, hit.point.z];
    const local = plane ? plane.renderToLocal(render) : null;
    return { local: local ? [local[0], local[1]] : [render[0], -render[2]], render, winner: null, guides: [], locked: false };
  }
  const ray = plane ? cursorRay(ctx, x, y) : null;
  const onPlane = ray && plane ? plane.intersectRay(ray) : null;
  return onPlane ? { local: onPlane.local, render: onPlane.render, winner: null, guides: [], locked: false } : null;
}

/** True when a command is running and took the event. */
export function routeCommandPointer(ctx: MouseHandlerContext, kind: 'move' | 'down', x: number, y: number): boolean {
  const { command, ctx: commandCtx } = getCommandRuntime();
  if (!command || !commandCtx) return false;
  if (kind === 'down') {
    const snap = resolveCommandSnap(ctx, commandCtx, x, y);
    if (snap) commandPointerDown(snap);
    return true;
  }
  latest = { x, y };
  if (ctx.measureRaycastPendingRef.current) return true;
  ctx.measureRaycastPendingRef.current = true;
  ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
    ctx.measureRaycastPendingRef.current = false;
    ctx.measureRaycastFrameRef.current = null;
    const runtime = getCommandRuntime();
    const at = latest;
    if (!runtime.command || !runtime.ctx || !at) return;
    const snap = resolveCommandSnap(ctx, runtime.ctx, at.x, at.y);
    if (snap) commandPointerMove(snap);
  });
  return true;
}
