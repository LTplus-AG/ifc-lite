/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Wall endpoint resize (#6233): the metre-space read, the batched write, and
 * the local mesh rebuild that follows a resize and its undo / redo.
 *
 * Units: the viewer authors in metres (raycasts, handles, meshes), while the
 * wall's STEP entities hold the file's native length unit. Every value that
 * crosses this module's boundary is metres; `toNativeLength` /
 * `fromNativeLength` convert at the STEP edge.
 *
 * Mesh: the wall's mesh is rebuilt from its current wall-edit chain with
 * `buildElementMesh`, the builder `addWall` uses. Swapping a mesh under the
 * SAME global id takes two steps: the old mesh leaves through the renderer's
 * `pendingMeshRemovals` drain, and the new one is appended only once that
 * drain has run, because the drain removes and prunes by entity id and would
 * take a mesh appended earlier with it. Each swap re-uploads the scene, so a
 * drag rebuilds once, at release (`refreshWallMesh`), not on every frame.
 */

import type { StoreApi } from 'zustand';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { MeshData } from '@ifc-lite/geometry';
import { hostsOtherEntities } from '@ifc-lite/renderer';
import { fromNativeLength, toNativeLength } from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { toGlobalIdFromModels } from '../globalId.js';
import { resolveWallEditChain } from '@/lib/placement-edit.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { buildElementMesh } from './addElementMeshes.js';
import { appendAuthoredMesh } from './authoredTreeEntry.js';

type Get = () => ViewerState;
type Subscribe = StoreApi<ViewerState>['subscribe'];
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

/** Batch id → the wall it resized, per store, so undo / redo can rebuild its mesh. */
const resizeBatches = new WeakMap<Get, Map<string, { modelId: string; expressId: number }>>();

function batchesFor(get: Get): Map<string, { modelId: string; expressId: number }> {
  let batches = resizeBatches.get(get);
  if (!batches) resizeBatches.set(get, batches = new Map());
  return batches;
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
  if (tag) batchesFor(get).set(tag, { modelId, expressId });
  return { ok: true, newLength: length };
}

/** The wall a replayed batch resized, if it was a resize. */
export function wallResizedByBatch(get: Get, batchId: string | undefined) {
  return batchId === undefined ? undefined : resizeBatches.get(get)?.get(batchId);
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

/** Global ids whose swap is waiting on the removal drain → whether to mirror the result. */
const inFlight = new WeakMap<Get, Map<number, boolean>>();

/**
 * Rebuild the wall's local mesh from its current IFC data. `mirror` also
 * sends the new mesh to collaborators (a local resize does; its undo / redo
 * stays local, like every positional undo). A rebuild requested while one is
 * already waiting on the drain joins it: the mesh is built from the data as
 * it stands when the drain lets it through.
 */
export function refreshWallMeshIn(get: Get, subscribe: Subscribe, modelId: string, expressId: number, mirror: boolean): void {
  const globalId = toGlobalIdFromModels(get().models, modelId, expressId);
  let waiting = inFlight.get(get);
  if (!waiting) inFlight.set(get, waiting = new Map());
  if (waiting.has(globalId)) {
    if (mirror) waiting.set(globalId, true);
    return;
  }
  const append = (mirrorResult: boolean) => {
    const mesh = buildWallMesh(get, modelId, expressId, globalId);
    if (!mesh) return;
    appendAuthoredMesh(get(), modelId, mesh);
    if (mirrorResult) get().mirrorEntityGeometry(modelId, expressId, mesh);
  };
  const model = get().models.get(modelId);
  const own = ((model ? model.geometryResult : get().geometryResult)?.meshes ?? []).filter((m) => m.expressId === globalId);
  if (own.length === 0) {
    append(mirror);
    return;
  }
  if (!own.some((m) => !hostsOtherEntities(m))) {
    // Colour-merged with other entities: the old mesh can't be taken out, so
    // a fresh one would render on top of it. Only collaborators get it.
    if (mirror) {
      const mesh = buildWallMesh(get, modelId, expressId, globalId);
      if (mesh) get().mirrorEntityGeometry(modelId, expressId, mesh);
    }
    return;
  }
  // No replacement to build (e.g. an unset extrusion depth): keep the old mesh
  // rather than prune it and leave the wall invisible.
  if (!buildWallMesh(get, modelId, expressId, globalId)) return;
  // The old mesh leaves the way a delete takes it (store prune + renderer drain).
  get().pruneGeometryMeshes(new Set([globalId]));
  get().setPendingMeshRemovals(new Set([globalId]));
  waiting.set(globalId, mirror);
  const unsubscribe = subscribe((state) => {
    if (state.pendingMeshRemovals?.has(globalId)) return;
    unsubscribe();
    const mirrorResult = waiting.get(globalId) ?? mirror;
    waiting.delete(globalId);
    append(mirrorResult);
  });
}
