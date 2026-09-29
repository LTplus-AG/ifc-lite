/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `wall.moveEndpoint` (charter #6232, WP2): drag one end of the selected
 * wall. While the pointer is down only a ghost follows the (snapped) cursor;
 * release writes ONE `resizeWall` — one transaction, one undo step — and the
 * command ends. Escape during the drag cancels with nothing written.
 *
 * Started from the endpoint handles in the select tool
 * (`WallEndpointOverlay` → `beginWallEndpointDrag`). The handle unmounts as
 * the tool switches, so the drag is followed through the command pointer
 * (canvas moves) and a window `pointerup`, not pointer capture.
 */

import { useViewerStore } from '@/store';
import { authoringDim } from '@/store/slices/authoringDefaultsSlice';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { dist } from '@/lib/snap/constraints';
import type { Vec2 } from '@/lib/snap/types';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import { resizeWallMetres } from '@/store/slices/mutation-wall-resize';
import { commandGhostId, wallGhostMesh } from '../ghost.js';
import { commitCommand, getCommandRuntime, updateCommandGesture } from '../runtime.js';
import { buildStoreyWorkplane, elementStoreyId, isWorkplane } from '../workplane.js';
import type { CommandContext, ModelingCommand, Vec3, Workplane } from '../types.js';

export type WallEnd = 'start' | 'end';

export interface WallEndpointGesture {
  target: { modelId: string; expressId: number } | null;
  /** The wall's storey workplane; its ends are storey-local. */
  plane: Workplane | null;
  start: Vec3;
  end: Vec3;
  thickness: number;
  height: number;
  which: WallEnd | null;
  /** Where the dragged end is now, storey-local plan. */
  moving: Vec2 | null;
}

const EMPTY: WallEndpointGesture = {
  target: null, plane: null, start: [0, 0, 0], end: [0, 0, 0], thickness: 0, height: 0, which: null, moving: null,
};

function init(ctx: CommandContext): WallEndpointGesture {
  const s = ctx.get();
  if (s.selectedEntityId === null) return EMPTY;
  const { modelId, expressId } = resolveEntityRef(s.selectedEntityId);
  const wall = s.models.has(modelId) ? s.readWallEndpoints(modelId, expressId) : null;
  const storeyId = elementStoreyId(s, modelId, expressId);
  if (!wall || storeyId === null) return EMPTY;
  const plane = buildStoreyWorkplane(s, modelId, storeyId, 0);
  return {
    ...EMPTY,
    target: { modelId, expressId },
    plane: isWorkplane(plane) ? plane : null,
    start: wall.start,
    end: wall.end,
    thickness: wall.thickness,
    height: Number.isFinite(wall.height) ? wall.height : authoringDim(s.authoringDefaults, 'wall', 'Height'),
  };
}

type Point3 = [number, number, number];

function ends(g: WallEndpointGesture): { start: Point3; end: Point3 } | null {
  if (!g.which || !g.moving) return null;
  const moved: Point3 = [g.moving[0], g.moving[1], g[g.which][2]];
  const copy = (p: Vec3): Point3 => [p[0], p[1], p[2]];
  return g.which === 'start' ? { start: moved, end: copy(g.end) } : { start: copy(g.start), end: moved };
}

export const WALL_MOVE_ENDPOINT: ModelingCommand<WallEndpointGesture> = {
  id: 'wall.moveEndpoint',
  labelKey: 'modelingCommand.wallEnd.label',
  hud: { hint: () => 'modelingCommand.wallEnd.hint' },
  snap: 'modeling',
  init,
  snapQuery(g) {
    const fixed = g.which === 'start' ? g.end : g.start;
    return { anchor: g.which ? [fixed[0], fixed[1]] : null, chain: [], locks: {} };
  },
  pointerMove(g, s) {
    if (!g.which || !g.plane || !s.render) return g;
    const local = g.plane.renderToLocal(s.render);
    return { ...g, moving: [local[0], local[1]] };
  },
  pointerDown: (g) => g,
  validate(g) {
    const next = ends(g);
    return next && dist([next.start[0], next.start[1]], [next.end[0], next.end[1]]) >= 0.01
      ? { ok: true } : { ok: false, reasonKey: 'modelingCommand.wall.tooShort' };
  },
  commit(g, tx) {
    const next = ends(g);
    if (!g.target || !next) throw new Error('No wall end to move');
    const { modelId, expressId } = g.target;
    const model = modelEditTarget(tx.store, modelId);
    if (!model) throw new Error(`No model loaded for id "${modelId}"`);
    // A dragged corner takes the walls joined to it along, and every join that touches a moved
    // wall is cut again. The transaction's batch id: undo / redo rebuild the meshes by it.
    const result = resizeWallMetres(tx.api, model, modelId, expressId, next.start, next.end, tx.batchId, { moveJoinedEnds: true });
    if (!result.ok) throw new Error(`Couldn't resize the wall: ${result.reason}`);
    // 'hostsChanged': the openings and fillings of every moved wall move with it.
    return { modelId, created: [], deleted: [], remesh: result.walls, remeshCause: 'hostsChanged', select: [expressId] };
  },
  afterCommit: () => ({ exit: true }),
  cancel: () => 'exit',
  ghost(g, ctx) {
    const next = ends(g);
    if (!g.plane || !next) return [];
    const mesh = wallGhostMesh(g.plane, [next.start[0], next.start[1]], [next.end[0], next.end[1]], g.thickness, g.height, commandGhostId(ctx.get()));
    return mesh ? [mesh] : [];
  },
};

/** An endpoint handle was grabbed: run the command until the pointer is released. */
export function beginWallEndpointDrag(which: WallEnd): void {
  useViewerStore.getState().startCommand(WALL_MOVE_ENDPOINT.id);
  if (getCommandRuntime().command?.id !== WALL_MOVE_ENDPOINT.id) return;
  updateCommandGesture((g) => ({ ...(g as WallEndpointGesture), which }));
  window.addEventListener('pointerup', () => {
    const runtime = getCommandRuntime();
    if (runtime.command?.id !== WALL_MOVE_ENDPOINT.id) return; // cancelled with Escape
    // A press without a drag writes nothing.
    if ((runtime.gesture as WallEndpointGesture).moving) commitCommand();
    if (getCommandRuntime().command?.id === WALL_MOVE_ENDPOINT.id) useViewerStore.getState().endCommand('cancel');
  }, { once: true });
}
