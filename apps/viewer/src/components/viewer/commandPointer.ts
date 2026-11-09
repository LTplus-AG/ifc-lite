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
 *      cursor ray ∩ the plane. A gesture that aims at a region of the plane
 *      (`aimsAtRegion`) always takes the ray ∩ the plane, and does not snap.
 *      So does any pointer with snapping suspended (Alt or the toggle), past
 *      whatever stands in front (#9201), unless the command picks an element
 *      from the point (`aimsAtElement`); see `pointerAim`;
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
  commandPointerMissed,
  commandPointerMove,
  commandPointerUp,
  commandPressDrag,
  commandPressGrabs,
  getCommandRuntime,
  type CommandRuntimeState,
} from '@/lib/commands/modeling/runtime';
import type { ModelingCommand, Vec3, Workplane } from '@/lib/commands/modeling/types';
import { commandGhostId } from '@/lib/commands/modeling/ghost';
import {
  NO_MODIFIERS, modelSnapSources, pointerAim, solveCommandSnap, type PointerModifiers,
} from '@/lib/commands/modeling/snap-solve';
import { rememberCommandPointer } from '@/lib/commands/modeling/pointer-replay';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { createMeshSource, type MeshPick } from '@/lib/snap/sources/mesh';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';
import { cancelMeasureRaycast } from './measureHandlers.js';

/** Ghost ids a command preview may use (`ghost.ts` allocates from `commandGhostId`). */
const GHOST_PICK_GUARD = 4;
const latest = new WeakMap<MouseHandlerContext, { x: number; y: number; mods: PointerModifiers; runtime: CommandRuntimeState }>();

/**
 * Discard a coalesced preview before a press, release, cancellation or teardown.
 * Only the shared frame cancel: Point mode's trailing hover (`cancelQueuedHover`)
 * belongs to Measure and is not the command tool's to drop.
 */
export function cancelCommandPointer(ctx: MouseHandlerContext): void {
  latest.delete(ctx);
  cancelMeasureRaycast(ctx);
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
  const aim = pointerAim(command, runtime.gesture, plane, ctx.snapEnabledRef.current, mods.altKey);
  const pick = aim === 'snap' ? magneticPick(ctx, command, x, y) : null;
  if (!pick) ctx.setSnapTarget(null);
  const section = plane.spec.kind === 'section';
  const hit = pick ? pick.intersection : aim === 'surface' && !section ? ctx.renderer.raycastScene(x, y, pickOptions(ctx, command))?.intersection : null;
  const toLocal = (p: { x: number; y: number; z: number }) => {
    const l = plane.renderToLocal([p.x, p.y, p.z]);
    return { local: [l[0], l[1]] as Vec2, elevation: l[2] };
  };
  const cursor = section || !hit ? onPlane(ctx, plane, x, y) : toLocal(hit.point).local;
  if (!cursor) return null;
  const beside = onPlane(ctx, plane, x + 1, y);
  const here = onPlane(ctx, plane, x, y);
  const metresPerPixel = here && beside ? Math.hypot(beside[0] - here[0], beside[1] - here[1]) : 0;
  const sources: SnapSource[] = pick ? [
    createMeshSource({
      pick: () => pick,
      lock: { get: () => ctx.edgeLockStateRef.current, set: ctx.setEdgeLock, clear: ctx.clearEdgeLock },
      toLocal,
      entityOf: (id) => useViewerStore.getState().resolveGlobalIdFromModels(id),
      suppressSurfacePoints: command.id.endsWith('.place') && command.aimsAtElement?.(runtime.gesture) !== true,
    }),
  ] : [];
  if (aim === 'snap' && plane.spec.kind !== 'section') sources.push(...modelSnapSources(commandCtx.modelId));
  ctx.setSnapTarget(pick?.snapTarget ?? null);
  return solveCommandSnap(runtime, plane, { cursor, metresPerPixel, sources, mods, aim });
}

/** A press or a release lands where it is: a preview still queued for this frame is dropped first. */
function pressSnap(ctx: MouseHandlerContext, runtime: CommandRuntimeState, x: number, y: number, mods: PointerModifiers): SnapResult | null {
  cancelCommandPointer(ctx);
  return resolveCommandSnap(ctx, runtime, x, y, mods);
}

/**
 * A touch press at the point it landed (#9092): `drag` presses there when the
 * press grabs something (`commandPressDrag`), else only asks whether it would
 * (`commandPressGrabs`). True when it grabs.
 */
export function routeCommandPressDrag(ctx: MouseHandlerContext, x: number, y: number, mods: PointerModifiers, drag: boolean): boolean {
  const runtime = getCommandRuntime();
  if (!runtime.command?.pressDrags || !runtime.ctx) return false;
  const snap = pressSnap(ctx, runtime, x, y, mods);
  return snap !== null && (drag ? commandPressDrag : commandPressGrabs)(snap);
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
  rememberCommandPointer((keys) => { routeCommandPointer(ctx, 'move', x, y, keys); }, mods);
  if (kind !== 'move') {
    const snap = pressSnap(ctx, runtime, x, y, mods);
    if (snap) (kind === 'up' ? commandPointerUp : (mods.detail ?? 1) >= 2 ? commandDoubleClick : commandPointerDown)(snap);
    else commandPointerMissed();
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
    else commandPointerMissed();
  });
  return true;
}
