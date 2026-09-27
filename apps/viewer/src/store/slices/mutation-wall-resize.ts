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
 * (`refreshWallMesh`), not on every frame. Collaborators still receive a
 * box built from the wall's parameters until the room mirror carries
 * re-meshed geometry (#6232 PR1.4).
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { MeshData } from '@ifc-lite/geometry';
import { toNativeLength } from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { toGlobalIdFromModels } from '../globalId.js';
import { resolveWallEditChain } from '@/lib/placement-edit.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { buildElementMesh } from './addElementMeshes.js';
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
  // The chain reads in metres when given the model's scale (#6233).
  const chain = resolveWallEditChain(ctx.dataStore, ctx.view, ctx.editor, expressId, getModelLengthUnitScale(ctx.dataStore));
  if (!chain) return null;
  const start: Vec3 = [...chain.startCoordinates];
  const length = chain.wallLength;
  const [dx, dy, dz] = chain.refDirection;
  const end: Vec3 = [start[0] + dx * length, start[1] + dy * length, start[2] + dz * length];
  return { chain, start, end, thickness: chain.thickness, height: chain.height };
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

function buildWallMesh(get: Get, modelId: string, expressId: number, globalId: number): MeshData | null {
  const state = get();
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  const view = state.mutationViews.get(modelId);
  const editor = state.storeEditors.get(modelId);
  if (!dataStore || !view || !editor) return null;
  const wall = readWallMetres({ dataStore, view, editor }, expressId);
  if (!wall || !(wall.height > 0)) return null;
  const hierarchy = dataStore.spatialHierarchy;
  const storeyId = hierarchy?.elementToStorey.get(expressId);
  const storeyElevation = (storeyId !== undefined ? hierarchy?.storeyElevations?.get(storeyId) : undefined) ?? 0;
  return buildElementMesh({
    type: 'wall',
    globalId,
    storeyElevation,
    payload: { type: 'wall', params: { Thickness: wall.thickness, Height: wall.height }, start: wall.start, end: wall.end },
  });
}

/**
 * Re-mesh the wall (and what it hosts) from its current IFC data. `mirror`
 * also sends collaborators a box built from the wall's parameters (a local
 * resize does; its undo / redo stays local, like every positional undo).
 */
export function refreshWallMeshIn(get: Get, modelId: string, expressId: number, mirror: boolean): void {
  void requestRemesh(get, modelId, [expressId], 'hostsChanged');
  if (!mirror) return;
  const mesh = buildWallMesh(get, modelId, expressId, toGlobalIdFromModels(get().models, modelId, expressId));
  if (mesh) get().mirrorEntityGeometry(modelId, expressId, mesh);
}
