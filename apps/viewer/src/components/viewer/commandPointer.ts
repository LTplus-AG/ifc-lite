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
 *   2. the WP3 solver (`solveSnap`): the command's anchor, chain and typed
 *      locks, Shift (angle step) / Alt (suspend snapping), and — while
 *      snapping is on — the WP3 sources: the mesh source over the renderer's
 *      magnetic pick, and the semantic source over the session storey's
 *      wall axes (endpoints, midpoints, bodies);
 *   3. `render` = the solved point on the plane.
 * Moves are coalesced to one resolve per animation frame, using the LATEST
 * cursor position and modifiers of that frame.
 */

import { MODELING_SNAP_PROFILE } from '@/lib/snap/rank';
import { solveSnap } from '@/lib/snap/solve';
import type { SnapProfile, SnapResult, SnapSource, Vec2 } from '@/lib/snap/types';
import {
  commandDoubleClick,
  commandPointerDown,
  commandPointerMove,
  getCommandRuntime,
  type CommandRuntimeState,
} from '@/lib/commands/modeling/runtime';
import type { ModelingCommand, Vec3, Workplane } from '@/lib/commands/modeling/types';
import { commandGhostId } from '@/lib/commands/modeling/ghost';
import { useViewerStore } from '@/store';
import { createMeshSource, type MeshPick } from '@/lib/snap/sources/mesh';
import { createSemanticSource, type SemanticSource } from '@/lib/snap/sources/semantic';
import { storeyWallAxes } from '@/lib/snap/sources/semantic-walls';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

/** `detail` is the click count: the second click of a double-click has 2. */
export interface PointerModifiers { shiftKey: boolean; altKey: boolean; detail?: number }

/** Ghost ids a command preview may use (`ghost.ts` allocates from `commandGhostId`). */
const GHOST_PICK_GUARD = 4;
const NO_MODIFIERS: PointerModifiers = { shiftKey: false, altKey: false };
let latest: { x: number; y: number; mods: PointerModifiers } | null = null;

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

function profileOf(command: ModelingCommand): SnapProfile {
  // Space Sketch's profile arrives with WP3 PR3.2; every command today snaps as 'modeling'.
  return typeof command.snap === 'string' ? MODELING_SNAP_PROFILE : command.snap;
}

/** Pick options that never hit the command's own ghost preview. */
function pickOptions(ctx: MouseHandlerContext, command: ModelingCommand) {
  const options = ctx.getPickOptions();
  if (!command.ghost) return options;
  const hiddenIds = new Set(options.hiddenIds);
  const first = commandGhostId(useViewerStore.getState());
  for (let i = 0; i < GHOST_PICK_GUARD; i++) hiddenIds.add(first + i);
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

/** One semantic (wall-axis) source per session model; it rebuilds itself on edits and storey changes. */
let semantic: { modelId: string; source: SemanticSource } | null = null;

function semanticSource(modelId: string): SemanticSource {
  if (semantic?.modelId === modelId) return semantic.source;
  const source = createSemanticSource({
    modelId,
    version: () => useViewerStore.getState().mutationVersion,
    storeyId: () => useViewerStore.getState().session?.storeyId ?? null,
    loadAxes: (storeyId) => {
      const s = useViewerStore.getState();
      const store = s.models.get(modelId)?.ifcDataStore;
      const view = s.mutationViews.get(modelId);
      return store && view ? storeyWallAxes(store, view, storeyId) : [];
    },
  });
  semantic = { modelId, source };
  return source;
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
  const cursor = hit ? toLocal(hit.point).local : onPlane(ctx, plane, x, y);
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
    semanticSource(commandCtx.modelId),
  ] : [];
  ctx.setSnapTarget(pick?.snapTarget ?? null);
  const input = command.snapQuery?.(runtime.gesture) ?? { anchor: null, chain: [], locks: {} };
  const solved = solveSnap(
    { cursor, metresPerPixel, ...input, modifiers: { shift: mods.shiftKey, alt: mods.altKey } },
    sources,
    profileOf(command),
    runtime.snap ?? undefined,
  );
  return {
    ...solved,
    render: plane.localToRender([solved.local[0], solved.local[1], 0]),
    modifiers: { shift: mods.shiftKey, alt: mods.altKey },
  };
}

/** True when a command is running and took the event. */
export function routeCommandPointer(
  ctx: MouseHandlerContext,
  kind: 'move' | 'down',
  x: number,
  y: number,
  mods: PointerModifiers = NO_MODIFIERS,
): boolean {
  const runtime = getCommandRuntime();
  if (!runtime.command || !runtime.ctx) return false;
  if (kind === 'down') {
    const snap = resolveCommandSnap(ctx, runtime, x, y, mods);
    if (snap) ((mods.detail ?? 1) >= 2 ? commandDoubleClick : commandPointerDown)(snap);
    return true;
  }
  latest = { x, y, mods };
  if (ctx.measureRaycastPendingRef.current) return true;
  ctx.measureRaycastPendingRef.current = true;
  ctx.measureRaycastFrameRef.current = requestAnimationFrame(() => {
    ctx.measureRaycastPendingRef.current = false;
    ctx.measureRaycastFrameRef.current = null;
    const at = latest;
    if (!at) return;
    const snap = resolveCommandSnap(ctx, getCommandRuntime(), at.x, at.y, at.mods);
    if (snap) commandPointerMove(snap);
  });
  return true;
}
