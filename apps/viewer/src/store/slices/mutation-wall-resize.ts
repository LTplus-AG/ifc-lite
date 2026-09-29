/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall endpoint resize (#6233): the metre-space read, the batched write, and
 * the mesh rebuild that follows a resize and its undo / redo.
 *
 * Units: the viewer authors in metres (raycasts, handles, meshes), while the
 * wall's STEP entities hold the file's native length unit. Every value that
 * crosses this module's boundary is metres; `toNativeLength` /
 * `fromNativeLength` convert at the STEP edge.
 *
 * A wall with joins, cut ends, an offset body or an `Axis` representation is
 * re-shaped by `reshapeWallsIn` (`@ifc-lite/create`): its body and axis are
 * rewritten and every join that touches it is recomputed, so the corners stay
 * clean. A plain rectangle wall with none of those takes the cheap four-slot
 * write below.
 *
 * Mesh: the wall is re-meshed by the wasm mesher from its edited IFC data
 * (`requestRemesh`, #6232), with its openings and the windows and doors in
 * them, which are placed relative to it. Each batch is remembered for undo /
 * redo (`remesh-registry.ts`). A drag re-meshes once, at release
 * (`refreshWallMesh`), not on every frame. Collaborators receive the same
 * re-meshed geometry after the resize and after its undo / redo.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { readWallJoinRels, readWallJoinTarget, toNativeLength, type WallJoinRead } from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { resolveWallEditChain, type WallEditChain } from '@/lib/placement-edit.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { rememberRemesh } from '@/lib/remesh/remesh-registry.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';
import { newMutationBatchId } from './mutation-batch-tags.js';
import type { ModellingStore } from './mutation-modelling-records.js';
import { reshapeWallsIn } from './mutation-wall-joins.js';

type Get = () => ViewerState;
type Vec3 = [number, number, number];

export interface WallEditContext {
  dataStore: IfcDataStore;
  view: MutablePropertyView;
  editor: StoreEditor;
}

/** `walls`: every wall whose geometry was written (the resized one, and the ones re-cut or moved with it). */
export type WallResizeOutcome = { ok: true; newLength: number; walls: number[] } | { ok: false; reason: string };

export interface WallResizeOptions {
  /** A dragged end takes the walls joined end to end with it along (`wall.moveEndpoint`). Default: they stay. */
  moveJoinedEnds?: boolean;
}

const NOT_A_RECTANGLE_WALL =
  'Wall does not have a simple IfcRectangleProfileDef → IfcExtrudedAreaSolid representation';

export interface WallMetres {
  start: Vec3;
  end: Vec3;
  thickness: number;
  height: number;
  /** The four coupled entities of a plain rectangle wall; null for a joined, cut or polygon body. */
  chain: WallEditChain | null;
  /** The wall as `@ifc-lite/create` reads it, cuts and axis included. */
  read: WallJoinRead | null;
}

/**
 * A wall's axis ends, thickness and height in metres, or null when it is not a
 * wall this module can read. The ends are the AXIS ends: a joined wall's body
 * reaches past or stops short of them.
 */
export function readWallMetres(ctx: WallEditContext, expressId: number): WallMetres | null {
  // The chain reads in metres when given the model's scale (#6233).
  const scale = getModelLengthUnitScale(ctx.dataStore);
  const chain = resolveWallEditChain(ctx.dataStore, ctx.view, ctx.editor, expressId, scale);
  const read = readWallJoinTarget(ctx.dataStore, ctx.view, expressId, scale);
  if (read) {
    const z = read.location[2] * scale;
    return { start: [...read.wall.start, z], end: [...read.wall.end, z], thickness: read.wall.thickness, height: read.height, chain, read };
  }
  if (!chain) return null;
  const start: Vec3 = [...chain.startCoordinates];
  const length = chain.wallLength;
  const [dx, dy, dz] = chain.refDirection;
  const end: Vec3 = [start[0] + dx * length, start[1] + dy * length, start[2] + dz * length];
  return { start, end, thickness: chain.thickness, height: chain.height, chain, read: null };
}

/**
 * Write a resize as one undo step. `batchId` joins an ongoing batch (every
 * frame of one endpoint drag); without it the resize is its own step. The
 * joins of a resized wall are recomputed. The walls joined to it stay where
 * they are, unless `moveJoinedEnds` (a dragged corner) brings them along.
 */
export function resizeWallMetres(
  store: ModellingStore,
  ctx: WallEditContext,
  modelId: string,
  expressId: number,
  newStart: Vec3,
  newEnd: Vec3,
  batchId?: string,
  options: WallResizeOptions = {},
): WallResizeOutcome {
  const get = store.getState;
  const wall = readWallMetres(ctx, expressId);
  if (!wall) return { ok: false, reason: NOT_A_RECTANGLE_WALL };
  const dx = newEnd[0] - newStart[0];
  const dy = newEnd[1] - newStart[1];
  const dz = newEnd[2] - newStart[2];
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { ok: false, reason: 'Wall length must be greater than zero' };
  if (Math.abs(dz) > Math.max(1e-6 * length, 1e-9)) {
    return { ok: false, reason: 'Start and end must lie on the same storey plane' };
  }

  const { chain, read } = wall;
  const joined = read !== null && readWallJoinRels(ctx.dataStore, ctx.view, new Set([expressId])).length > 0;
  if (chain && (read === null || (read.plain && read.axisRepId === null && !joined))) {
    const unit = { lengthUnitScale: getModelLengthUnitScale(ctx.dataStore) };
    const n = (value: number) => toNativeLength(unit, value);
    const nativeLength = n(length);
    const tag = get().setPositionalAttributesBatch(modelId, [
      { entityId: chain.startPointId, index: 0, value: [n(newStart[0]), n(newStart[1]), n(newStart[2])] },
      { entityId: chain.refDirectionId, index: 0, value: [dx / length, dy / length, 0] },
      { entityId: chain.profileId, index: 3, value: nativeLength },
      { entityId: chain.profileOriginPointId, index: 0, value: [nativeLength / 2, 0] },
    ], batchId);
    // Moving the start moves the wall's placement, so its openings and fillings follow.
    if (tag) rememberRemesh(get, tag, modelId, [expressId], 'hostsChanged');
    return { ok: true, newLength: length, walls: [expressId] };
  }

  const batch = batchId ?? newMutationBatchId();
  const outcome = reshapeWallsIn(store, modelId, [{ wallId: expressId, start: [newStart[0], newStart[1]], end: [newEnd[0], newEnd[1]] }], { moveJoinedEnds: options.moveJoinedEnds }, batch);
  if (!outcome.ok) return outcome;
  rememberRemesh(get, batch, modelId, outcome.walls, 'hostsChanged');
  // The caller re-meshes the resized wall; the walls re-cut beside it are ours.
  const cut = outcome.walls.filter((id) => id !== expressId);
  if (batchId === undefined && cut.length > 0) void requestRemesh(get, modelId, cut, 'hostsChanged');
  return { ok: true, newLength: length, walls: outcome.walls };
}

/** Re-mesh the wall (and what it hosts) from its current IFC data, for the view and the room. */
export function refreshWallMeshIn(get: Get, modelId: string, expressId: number): void {
  void requestRemesh(get, modelId, [expressId], 'hostsChanged');
}
