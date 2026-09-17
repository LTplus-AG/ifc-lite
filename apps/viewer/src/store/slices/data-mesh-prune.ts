/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
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
 */
export interface PruneMeshesState {
  geometryResult: GeometryResult | null;
  activeModelId: string | null;
  models: Map<string, FederatedModel>;
  geometryUpdateTick: number;
}

export interface PruneMeshesPatch {
  geometryResult?: GeometryResult;
  models?: Map<string, FederatedModel>;
  geometryUpdateTick?: number;
}

export function pruneMeshesFromGeometry(
  state: PruneMeshesState, ids: Set<number>,
): PruneMeshesPatch {
  if (!state.geometryResult || ids.size === 0) return {};

  const meshes = state.geometryResult.meshes;
  const kept: typeof meshes = [];
  let removedTriangles = 0;
  let removedVertices = 0;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (ids.has(mesh.expressId)) {
      removedTriangles += mesh.indices.length / 3;
      removedVertices += mesh.positions.length / 3;
    } else {
      kept.push(mesh);
    }
  }
  // Nothing in `ids` actually matched a mesh (already pruned, or the id never
  // had one) — leave the totals untouched rather than subtracting zero and
  // still bumping the tick for no visible change.
  if (kept.length === meshes.length) return {};

  const geometryResult = {
    ...state.geometryResult,
    meshes: kept,
    totalTriangles: state.geometryResult.totalTriangles - removedTriangles,
    totalVertices: state.geometryResult.totalVertices - removedVertices,
  };
  const geometryUpdateTick = state.geometryUpdateTick + 1;
  const modelId = state.activeModelId;
  const model = modelId ? state.models.get(modelId) : undefined;
  if (!modelId || !model) return { geometryResult, geometryUpdateTick };

  const models = new Map(state.models);
  models.set(modelId, { ...model, geometryResult });
  return { geometryResult, models, geometryUpdateTick };
}
