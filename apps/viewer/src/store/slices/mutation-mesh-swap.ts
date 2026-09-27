/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Replace an entity's rendered mesh in place, undoably (#6233).
 *
 * A split now keeps the larger piece as the source entity and reshapes it
 * (shorter wall, shorter beam, clipped slab), so the source's mesh must be
 * swapped for one of the new shape under the SAME globalId. That rules out
 * the delete path's "prune + queue a removal + append" in one tick: the
 * streaming drain (`useGeometryStreaming`) removes EVERY scene mesh carrying
 * a queued globalId, so a replacement appended before it runs would be wiped
 * with the old one. {@link replaceEntityMesh} therefore appends only once the
 * drain has consumed that globalId's removal.
 *
 * The swap is keyed on one of the split's positional mutations, and
 * `applyUndoToView` / `applyRedoToView` call {@link replayMeshSwap} for it,
 * the way a gizmo move's mesh translation rides on its mutation.
 */

import { hostsOtherEntities } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import type { StoreApi } from 'zustand';
import type { ViewerState } from '../index.js';
import { toGlobalIdFromModels } from '../globalId.js';
import { modelRotationBaker } from '../../lib/model-placement/rotation-bake.js';

type Get = () => ViewerState;

interface MeshSwap {
  api: StoreApi<ViewerState>;
  modelId: string;
  expressId: number;
  /** Pristine (model-frame) meshes before the swap — what undo restores. */
  before: MeshData[];
  after: MeshData[];
}

const swapsByStore = new WeakMap<Get, Map<string, MeshSwap>>();

function swaps(get: Get): Map<string, MeshSwap> {
  let entries = swapsByStore.get(get);
  if (!entries) swapsByStore.set(get, entries = new Map());
  return entries;
}

/**
 * Swap `expressId`'s mesh(es) for `next` and return the pristine meshes it
 * had, for {@link recordMeshSwap}.
 */
export function replaceEntityMesh(
  get: Get,
  api: StoreApi<ViewerState>,
  modelId: string,
  expressId: number,
  next: MeshData[],
): MeshData[] {
  const globalId = toGlobalIdFromModels(get().models, modelId, expressId);
  const meshes = get().models.get(modelId)?.geometryResult?.meshes ?? [];
  const before = meshes
    .filter((m) => m.expressId === globalId && !hostsOtherEntities(m))
    .map((m) => modelRotationBaker.inModelFrame(m));
  get().pruneGeometryMeshes(new Set([globalId]));
  get().setPendingMeshRemovals(new Set([globalId]));
  const append = () => { if (next.length > 0) get().appendGeometryBatch(modelId, next); };
  if (!api.getState().pendingMeshRemovals?.has(globalId)) {
    append();
    return before;
  }
  const unsubscribe = api.subscribe((state) => {
    if (state.pendingMeshRemovals?.has(globalId)) return;
    unsubscribe();
    append();
  });
  return before;
}

/** Make undo / redo of `mutationId` swap the entity's mesh back / forth. */
export function recordMeshSwap(get: Get, mutationId: string, swap: MeshSwap): void {
  swaps(get).set(mutationId, swap);
}

/** Called for every replayed positional mutation; a no-op unless one carries a swap. */
export function replayMeshSwap(get: Get, mutationId: string, direction: 'undo' | 'redo'): void {
  const swap = swapsByStore.get(get)?.get(mutationId);
  if (!swap) return;
  replaceEntityMesh(get, swap.api, swap.modelId, swap.expressId, direction === 'undo' ? swap.before : swap.after);
}
