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
 * Mesh: the wall is re-meshed by the wasm mesher from its edited IFC data
 * (`requestRemesh`, #6232), with its openings and the windows and doors in
 * them, which are placed relative to it. Each batch is remembered for undo /
 * redo (`remesh-registry.ts`). A drag re-meshes once, at release
 * (`refreshWallMesh`), not on every frame. Collaborators receive the same
 * re-meshed geometry after the resize and after its undo / redo.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { fromNativeLength, toNativeLength } from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { resolveWallEditChain } from '@/lib/placement-edit.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { rememberRemesh } from '@/lib/remesh/remesh-registry.js';
import { requestRemesh } from '@/lib/remesh/remesh-service.js';

type Get = () => ViewerState;
type Vec3 = [number, number, number];

export interface WallEditContext {
  dataStore: IfcDataStore;
  view: MutablePropertyView;
  editor: StoreEditor;
}

export type WallResizeOutcome = { ok: true; newLength: number } | { ok: false; reason: string };

const NOT_A_RECTANGLE_WALL =
  'Wall does not have a simple IfcRectangleProfileDef → IfcExtrudedAreaSolid representation';

/** A wall's endpoints, thickness and height in metres, or null when its chain doesn't resolve. */
export function readWallMetres(ctx: WallEditContext, expressId: number) {
  const chain = resolveWallEditChain(ctx.dataStore, ctx.view, ctx.editor, expressId);
  if (!chain) return null;
  const unit = { lengthUnitScale: getModelLengthUnitScale(ctx.dataStore) };
  const m = (value: number) => fromNativeLength(unit, value);
  const start: Vec3 = [m(chain.startCoordinates[0]), m(chain.startCoordinates[1]), m(chain.startCoordinates[2])];
  const length = m(chain.wallLength);
  const [dx, dy, dz] = chain.refDirection;
  const end: Vec3 = [start[0] + dx * length, start[1] + dy * length, start[2] + dz * length];
  return { chain, start, end, thickness: m(chain.thickness), height: m(chain.height) };
}

/**
 * Write a resize as one undo step. `batchId` joins an ongoing batch (every
 * frame of one endpoint drag); without it the resize is its own step.
 */
export function resizeWallMetres(
  get: Get,
  ctx: WallEditContext,
  modelId: string,
  expressId: number,
  newStart: Vec3,
  newEnd: Vec3,
  batchId?: string,
): WallResizeOutcome {
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
  const unit = { lengthUnitScale: getModelLengthUnitScale(ctx.dataStore) };
  const n = (value: number) => toNativeLength(unit, value);
  const nativeLength = n(length);
  const { chain } = wall;
  const tag = get().setPositionalAttributesBatch(modelId, [
    { entityId: chain.startPointId, index: 0, value: [n(newStart[0]), n(newStart[1]), n(newStart[2])] },
    { entityId: chain.refDirectionId, index: 0, value: [dx / length, dy / length, 0] },
    { entityId: chain.profileId, index: 3, value: nativeLength },
    { entityId: chain.profileOriginPointId, index: 0, value: [nativeLength / 2, 0] },
  ], batchId);
  // Moving the start moves the wall's placement, so its openings and fillings follow.
  if (tag) rememberRemesh(get, tag, modelId, [expressId], 'hostsChanged');
  return { ok: true, newLength: length };
}

/** Re-mesh the wall (and what it hosts) from its current IFC data, for the view and the room. */
export function refreshWallMeshIn(get: Get, modelId: string, expressId: number): void {
  void requestRemesh(get, modelId, [expressId], 'hostsChanged');
}
