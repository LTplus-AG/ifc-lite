/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import { meshGeometryCounts } from '@/lib/released-mesh-provenance';
import type { FederatedModel } from '../types.js';

/**
 * Drop drained mesh-removal ids out of `geometryResult.meshes` and subtract
 * their triangle/vertex counts from the running totals (issue #4874).
 *
 * `useGeometryStreaming` calls this right after `scene.removeMeshesForEntities`
 * — the renderer-side hard removal — so the STORE copy stops disagreeing with
 * the scene. Several consumers read that array or those totals directly:
 * picking, bounds recomputation, `StatusBar`'s triangle readout, and
 * `lib/collab/geometry-sync.ts`'s independent re-sum.
 *
 * Matches on which meshes are actually PRESENT for `ids`, not on `ids.size`:
 * draining the same id twice (already pruned), or naming an id that never had
 * a mesh, removes and subtracts nothing rather than double-counting or driving
 * a total negative.
 *
 * Owning model: the queue carries renderer GLOBAL ids with no model id, and a
 * removal can belong to a model that is not active (3D picking selects in any
 * federated model without calling `setActiveModel`, and split/delete act on
 * that selection's `modelId`). Every model's `geometryResult.meshes` already
 * holds global ids (`applyFederationOffsetToMesh` at load, `toGlobalIdFromModels`
 * for authored meshes), and offset ranges are disjoint, so this prunes EVERY
 * geometry that holds a queued id: the active mirror and each model's own.
 *
 * Bounded mode: `releaseGeometryMemory` empties a mesh's buffers but keeps the
 * mesh and its share of the totals, so counts come from `meshGeometryCounts`,
 * which falls back to the counts retained at release.
 */
export interface PruneMeshesState {
  geometryResult: GeometryResult | null;
  models: Map<string, FederatedModel>;
  geometryUpdateTick: number;
}

export interface PruneMeshesPatch {
  geometryResult?: GeometryResult;
  models?: Map<string, FederatedModel>;
  geometryUpdateTick?: number;
}

/** A pruned copy of `geometry`, or `geometry` itself when no mesh matched. */
function pruneGeometry(geometry: GeometryResult, ids: Set<number>): GeometryResult {
  const meshes = geometry.meshes;
  const kept: typeof meshes = [];
  let removedTriangles = 0;
  let removedVertices = 0;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (ids.has(mesh.expressId)) {
      const counts = meshGeometryCounts(mesh);
      removedTriangles += counts.triangles;
      removedVertices += counts.vertices;
    } else {
      kept.push(mesh);
    }
  }
  if (kept.length === meshes.length) return geometry;
  return {
    ...geometry,
    meshes: kept,
    totalTriangles: geometry.totalTriangles - removedTriangles,
    totalVertices: geometry.totalVertices - removedVertices,
  };
}

export function pruneMeshesFromGeometry(
  state: PruneMeshesState, ids: Set<number>,
): PruneMeshesPatch {
  if (ids.size === 0) return {};

  // The active mirror and its model record usually share ONE GeometryResult
  // object; prune each object once so both references get the same result.
  const pruned = new Map<GeometryResult, GeometryResult>();
  const prune = (geometry: GeometryResult): GeometryResult => {
    let next = pruned.get(geometry);
    if (!next) {
      next = pruneGeometry(geometry, ids);
      pruned.set(geometry, next);
    }
    return next;
  };

  const patch: PruneMeshesPatch = {};
  if (state.geometryResult) {
    const next = prune(state.geometryResult);
    if (next !== state.geometryResult) patch.geometryResult = next;
  }
  for (const [modelId, model] of state.models) {
    if (!model.geometryResult) continue;
    const next = prune(model.geometryResult);
    if (next === model.geometryResult) continue;
    patch.models ??= new Map(state.models);
    patch.models.set(modelId, { ...model, geometryResult: next });
  }
  // Nothing in `ids` matched a mesh anywhere: leave the tick alone too.
  if (!patch.geometryResult && !patch.models) return {};
  patch.geometryUpdateTick = state.geometryUpdateTick + 1;
  return patch;
}
