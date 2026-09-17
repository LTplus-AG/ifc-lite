/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `appendGeometryBatch`'s patch computation, beside `dataSlice` rather than
 * inside it — mirrors `modelSlice.upsert.ts`'s split, both to keep
 * `dataSlice.ts` under its module-size budget and because the routing logic
 * here is dense enough to read better on its own (see #4922).
 */
import type { GeometryResult, CoordinateInfo } from '@ifc-lite/geometry';
import type { FederatedModel } from '../types.js';
import { DATA_DEFAULTS } from '../constants.js';

const getDefaultCoordinateInfo = (): CoordinateInfo => ({
  // Create fresh copies to avoid shared object references
  originShift: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  originalBounds: {
    min: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
    max: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  },
  shiftedBounds: {
    min: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
    max: { x: DATA_DEFAULTS.ORIGIN_SHIFT.x, y: DATA_DEFAULTS.ORIGIN_SHIFT.y, z: DATA_DEFAULTS.ORIGIN_SHIFT.z },
  },
  hasLargeCoordinates: DATA_DEFAULTS.HAS_LARGE_COORDINATES,
});

interface AppendGeometryBatchState {
  activeModelId: string | null;
  models: Map<string, FederatedModel>;
  geometryResult: GeometryResult | null;
  geometryUpdateTick: number;
}

/**
 * Compute the state patch for appending `meshes` onto the model identified
 * by `modelId` — the model that OWNS them, e.g. a wall/slab split's two
 * halves, a cloned element, or a streamed-in batch.
 *
 * `modelId` is required and never inferred: this action used to fall back to
 * `activeModelId` implicitly, which is exactly how #4922 shipped — picking
 * in 3D doesn't call `setActiveModel`, so an authoring action on a
 * non-active federated model filed its new meshes under the wrong model's
 * `geometryResult`. Every caller must know which model it is appending to:
 * the streaming loader passes the model it is loading (which IS the model
 * `upsertModel` just made active), and mutationSlice's split/clone/addWall
 * paths pass the edited element's own `modelId`, active or not.
 *
 * The top-level `geometryResult` mirror is updated only when `modelId`
 * equals `activeModelId` — appending to a non-active model leaves the
 * mirror (and its totals) untouched, so a federated consumer reading the
 * active slot never sees another model's geometry appear in it.
 */
export function appendGeometryBatchPatch(
  state: AppendGeometryBatchState,
  modelId: string,
  meshes: GeometryResult['meshes'],
  coordinateInfo?: CoordinateInfo,
): Partial<AppendGeometryBatchState> {
  // Incremental totals: O(batch_size) instead of O(total_accumulated) .reduce()
  let batchTriangles = 0;
  let batchVertices = 0;
  for (let i = 0; i < meshes.length; i++) {
    batchTriangles += meshes[i].indices.length / 3;
    batchVertices += meshes[i].positions.length / 3;
  }

  const isActiveModel = modelId === state.activeModelId;
  const model = state.models.get(modelId);

  // The geometry this batch appends onto: the model's own record when one
  // exists, or (defensively — mirrors the pre-#4922 race guard for a batch
  // arriving before `upsertModel` has landed) the top-level mirror ONLY
  // when modelId is the active model. Anything else (an unknown modelId
  // that is also not active) has nowhere safe to land — see the final
  // branch below. This must key off `modelId`, not `state.activeModelId`,
  // because that is precisely the bug: the old code always appended onto
  // `state.geometryResult` (the active-model mirror) regardless of which
  // model the meshes belonged to.
  const existingResult = model
    ? model.geometryResult
    : (isActiveModel ? state.geometryResult : undefined);

  if (existingResult === undefined) {
    // Unknown, non-active modelId: refuse rather than silently filing the
    // batch under the active model (that would reinstate #4922).
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[appendGeometryBatch] modelId "${modelId}" is neither a known model nor the active model — dropping ${meshes.length} mesh(es).`,
      );
    }
    return { geometryUpdateTick: state.geometryUpdateTick + 1 };
  }

  let geometryResult: GeometryResult;
  if (!existingResult) {
    geometryResult = {
      meshes: meshes.slice(),
      totalTriangles: batchTriangles,
      totalVertices: batchVertices,
      coordinateInfo: coordinateInfo || getDefaultCoordinateInfo(),
    };
  } else {
    // Mutate the existing array in-place (O(batch) per append) instead of
    // .concat() (O(total) per append) to avoid O(N²) for large files.
    // The new geometryResult object reference below is sufficient for
    // Zustand/React change detection — array identity doesn't need to change.
    const existingMeshes = existingResult.meshes;
    for (let i = 0; i < meshes.length; i++) {
      existingMeshes.push(meshes[i]);
    }
    geometryResult = {
      ...existingResult,
      meshes: existingMeshes,
      totalTriangles: existingResult.totalTriangles + batchTriangles,
      totalVertices: existingResult.totalVertices + batchVertices,
      coordinateInfo: coordinateInfo || existingResult.coordinateInfo,
    };
  }

  const models = model
    ? (() => {
        const next = new Map(state.models);
        next.set(modelId, { ...model, geometryResult });
        return next;
      })()
    : undefined;

  return {
    geometryUpdateTick: state.geometryUpdateTick + 1,
    ...(models ? { models } : {}),
    ...(isActiveModel ? { geometryResult } : {}),
  };
}
