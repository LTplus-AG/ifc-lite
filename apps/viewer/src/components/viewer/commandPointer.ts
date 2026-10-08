/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pointer routing for a running modeling command (charter #6232, WP2). The
 * viewport's mouse handlers hand the canvas point here while the active tool
 * is `'command'`; this resolves it to a `SnapResult` and feeds the runtime.
 *
 * Resolution, on the session workplane:
 *   1. the cursor: the geometry under it (mapped onto the plane), else the
 *      cursor ray ∩ the plane;
 *   2. the shared solver (`snap-solve.ts`, also the plan's): the command's anchor, chain and typed
 *      locks, Shift (angle step) / Alt (suspend snapping), and — while
 *      snapping is on — the WP3 sources: the mesh source over the renderer's
 *      magnetic pick, and the semantic source over the session storey's
 *      wall axes (endpoints, midpoints, bodies, and lines for extensions);
 *   3. `render` = the solved point on the plane.
 * Moves are coalesced to one resolve per animation frame, using the LATEST
 * cursor position and modifiers of that frame.
 */

import type { SnapResult, SnapSource, Vec2 } from '@/lib/snap/types';
import {
  commandDoubleClick,
  commandPointerDown,
  commandPointerMove,
  commandPointerUp,
  getCommandRuntime,
  type CommandRuntimeState,
} from '@/lib/commands/modeling/runtime';
import type { ModelingCommand, Vec3, Workplane } from '@/lib/commands/modeling/types';
import { commandGhostId } from '@/lib/commands/modeling/ghost';
import {
  NO_MODIFIERS, modelSnapSources, solveCommandSnap, type PointerModifiers,
} from '@/lib/commands/modeling/snap-solve';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { createMeshSource, type MeshPick } from '@/lib/snap/sources/mesh';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

/** Ghost ids a command preview may use (`ghost.ts` allocates from `commandGhostId`). */
const GHOST_PICK_GUARD = 4;
const latest = new WeakMap<MouseHandlerContext, { x: number; y: number; mods: PointerModifiers; runtime: CommandRuntimeState }>();

/** Discard a coalesced preview before a press, release, cancellation or teardown. */
export function cancelCommandPointer(ctx: MouseHandlerContext): void {
  latest.delete(ctx);
  if (ctx.measureRaycastFrameRef.current !== null) cancelAnimationFrame(ctx.measureRaycastFrameRef.current);
  ctx.measureRaycastFrameRef.current = null;
  ctx.measureRaycastPendingRef.current = false;
}

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

function onPlane(ctx: MouseHandlerContext, plane: Workplane, x: number, y: number): Vec2 | null {
  const ray = cursorRay(ctx, x, y);
  return ray ? plane.intersectRay(ray)?.local ?? null : null;
}

/** Pick options that never hit the command's own ghost preview. */
function pickOptions(ctx: MouseHandlerContext, command: ModelingCommand) {
  const options = ctx.getPickOptions();
  const excluded = command.pickExclusions?.(getCommandRuntime().gesture) ?? [];
  if (!command.ghost && !excluded.length) return options;
  const hiddenIds = new Set(options.hiddenIds);
  const state = useViewerStore.getState();
  for (const ref of excluded) hiddenIds.add(toGlobalIdFromModels(state.models, ref.modelId, ref.expressId));
  if (command.ghost) {
    const first = commandGhostId(state);
    for (let i = 0; i < GHOST_PICK_GUARD; i++) hiddenIds.add(first + i);
  }
  return { ...options, hiddenIds };
}

/** The renderer's magnetic pick at the cursor, given the held edge lock. */
function magneticPick(ctx: MouseHandlerContext, command: ModelingCommand, x: number, y: number): MeshPick {
  const lock = ctx.edgeLockStateRef.current;
  return ctx.renderer.raycastSceneMagnetic(x, y, {
    edge: lock.edge, meshExpressId: lock.meshExpressId, lockStrength: lock.lockStrength,
  }, {
    ...pickOptions(ctx, command),
    snapOptions: { snapToVertices: true, snapToEdges: true, snapToFaces: true, screenSnapRadius: 40 },
  }) as MeshPick;
}

function resolveCommandSnap(
  ctx: MouseHandlerContext,
  runtime: CommandRuntimeState,
  x: number,
  y: number,
  mods: PointerModifiers = NO_MODIFIERS,
): SnapResult | null {
  const { command, ctx: commandCtx } = runtime;
  if (!command || !commandCtx) return null;
  const plane = commandCtx.workplane;
  if (!plane) {
    const hit = ctx.renderer.raycastScene(x, y, pickOptions(ctx, command))?.intersection;
    if (!hit) return null;
    return { local: [hit.point.x, -hit.point.z], render: [hit.point.x, hit.point.y, hit.point.z], winner: null, guides: [], locked: false };
  }
  const snapping = ctx.snapEnabledRef.current && !mods.altKey;
  const pick = snapping ? magneticPick(ctx, command, x, y) : null;
  if (!snapping) ctx.setSnapTarget(null);
  const hit = pick ? pick.intersection : ctx.renderer.raycastScene(x, y, pickOptions(ctx, command))?.intersection;
  const toLocal = (p: { x: number; y: number; z: number }) => {
    const l = plane.renderToLocal([p.x, p.y, p.z]);
    return { local: [l[0], l[1]] as Vec2, elevation: l[2] };
  };
  const cursor = plane.spec.kind === 'section' ? onPlane(ctx, plane, x, y) : hit ? toLocal(hit.point).local : onPlane(ctx, plane, x, y);
  if (!cursor) return null;
  const beside = onPlane(ctx, plane, x + 1, y);
  const here = onPlane(ctx, plane, x, y);
  const metresPerPixel = here && beside ? Math.hypot(beside[0] - here[0], beside[1] - here[1]) : 0;
  const sources: SnapSource[] = pick ? [
    createMeshSource({
      pick: () => pick,
      lock: { get: () => ctx.edgeLockStateRef.current, set: ctx.setEdgeLock, clear: ctx.clearEdgeLock },
      toLocal,
    }),
    ...(plane.spec.kind === 'section' ? [] : modelSnapSources(commandCtx.modelId)),
  ] : [];
  ctx.setSnapTarget(pick?.snapTarget ?? null);
  return solveCommandSnap(runtime, plane, { cursor, metresPerPixel, sources, mods });
}

/** True when a command is running and took the event. */
export function routeCommandPointer(
  ctx: MouseHandlerContext,
  kind: 'move' | 'down' | 'up',
  x: number,
  y: number,
  mods: PointerModifiers = NO_MODIFIERS,
): boolean {
  const runtime = getCommandRuntime();
  if (!runtime.command || !runtime.ctx) return false;
  if (kind !== 'move') {
    cancelCommandPointer(ctx);
    const snap = resolveCommandSnap(ctx, runtime, x, y, mods);
    if (snap) (kind === 'up' ? commandPointerUp : (mods.detail ?? 1) >= 2 ? commandDoubleClick : commandPointerDown)(snap);
    return true;
  }
  latest.set(ctx, { x, y, mods, runtime });
  if (ctx.measureRaycastPendingRef.current) return true;
  ctx.measureRaycastPendingRef.current = true;
  ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
    ctx.measureRaycastPendingRef.current = false;
    ctx.measureRaycastFrameRef.current = null;
    const at = latest.get(ctx);
    latest.delete(ctx);
    if (!at) return;
    const current = getCommandRuntime();
    if (current.command !== at.runtime.command || current.ctx !== at.runtime.ctx) return;
    const snap = resolveCommandSnap(ctx, current, at.x, at.y, at.mods);
    if (snap) commandPointerMove(snap);
  });
  return true;
}
