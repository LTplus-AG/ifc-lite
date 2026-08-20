/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-instanced occurrences are rendered from compact shards and are deliberately
 * absent from `geometryResult.meshes` (the flat consumer set), so one-shot
 * full-geometry exporters (glTF / IFC5) would otherwise drop them. This helper
 * materializes the instanced occurrences from the live renderer scene and appends
 * them to a copy of the geometryResult at export time only (transient — not retained).
 *
 * Instancing used to apply to the PRIMARY model only (shard entity ids lived in the
 * primary model's id space, idOffset 0) — true when this helper was written (#1238,
 * 2026-06-21), which is why it used to take a bare `isPrimary` boolean and no-op for
 * every federated model.
 *
 * That stopped being true on 2026-08-06 (#2255, "deliver GPU instancing to federated
 * models"): `useIfcLoader` now enables instancing for every load, primary and
 * federated, and `useGeometryStreaming` re-homes a federated shard's occurrence ids
 * onto that model's GLOBAL id space by `idOffset` before upload — the SAME shift
 * `finalizeModel` applies to that model's flat meshes. `Scene.getAllInstancedMeshData()`
 * already returns every loaded model's occurrences, unfiltered, already in the global
 * id space and the same world-space frame flat meshes use — so a federated model's
 * instanced entities are present and correctly keyed, they just never reached callers
 * that gated on `isPrimary` (#2865/#2878 follow-up).
 *
 * `getAllInstancedMeshData()` itself is not scoped to one model, though — a caller
 * building a SINGLE model's export (or a single model's clash element set) must not
 * splice in every OTHER loaded model's instanced occurrences too, or a federation of
 * N models would count each instanced entity N times over. `modelRange` is that scope:
 * pass this model's `{ idOffset, maxExpressId }` (both already on `FederatedModel`,
 * the same bracket `FederationRegistry.isInModel` uses) to restrict the appended set to
 * ids `idOffset+1 .. idOffset+maxExpressId`. Pass `null` only when the caller's
 * `geometryResult` already spans every loaded model (e.g. the merged Cesium world
 * view) or when there is provably only one model loaded, so there is nothing else to
 * wrongly include.
 */
import { getGlobalRenderer } from '../hooks/useBCF.js';
import type { GeometryResult } from '@ifc-lite/geometry';

/** This model's global-id bracket, for scoping `getAllInstancedMeshData()`'s
 *  unfiltered (all-models) output down to just this model's occurrences. */
export interface InstancedModelRange {
  /** `FederatedModel.idOffset` — global ids for this model start at `idOffset + 1`. */
  idOffset: number;
  /** `FederatedModel.maxExpressId` — the highest LOCAL id in this model, so the
   *  global-id upper bound is `idOffset + maxExpressId`. */
  maxExpressId: number;
}

export function withInstancedMeshes(
  geometryResult: GeometryResult,
  modelRange: InstancedModelRange | null,
): GeometryResult {
  const scene = getGlobalRenderer()?.getScene();
  const all = scene?.getAllInstancedMeshData() ?? [];
  const instanced = modelRange
    ? all.filter(
        (m) => m.expressId > modelRange.idOffset && m.expressId <= modelRange.idOffset + modelRange.maxExpressId,
      )
    : all;
  if (instanced.length === 0) return geometryResult;

  let totalTriangles = geometryResult.totalTriangles;
  let totalVertices = geometryResult.totalVertices;
  for (const m of instanced) {
    totalTriangles += m.indices.length / 3;
    totalVertices += m.positions.length / 3;
  }
  return {
    ...geometryResult,
    meshes: [...geometryResult.meshes, ...instanced],
    totalTriangles,
    totalVertices,
  };
}

/** Resolves a single panel's `InstancedModelRange` (see the module doc above)
 *  from its own `modelId` plus the currently loaded models, AND whether an
 *  instanced-geometry export may proceed at all.
 *
 * `null` is the correct, unfiltered range ONLY when the model id resolved to
 * nothing because this is provably the sole loaded model. An unresolved
 * `modelId` while `models.size > 1` (e.g. no entity selected in a
 * federation, or a stale id after a model was removed) must NOT fall through
 * to `null` — `withInstancedMeshes(geometryResult, null)` then splices every
 * OTHER loaded model's instanced occurrences into this model's export. Such
 * a leak was `GeoreferencingPanel`'s KMZ export before this helper existed
 * (PR #2878 review): `canExport: false` tells the caller to withhold the
 * export instead of falling through to that unfiltered case. */
export function resolveInstancedExportGate(
  modelId: string | undefined,
  models: ReadonlyMap<string, { idOffset?: number; maxExpressId?: number }>,
): { instancedModelRange: InstancedModelRange | null; canExport: boolean } {
  const model = modelId ? models.get(modelId) : undefined;
  const instancedModelRange: InstancedModelRange | null = model
    ? { idOffset: model.idOffset ?? 0, maxExpressId: model.maxExpressId ?? 0 }
    : null;
  const canExport = models.size <= 1 || instancedModelRange !== null;
  return { instancedModelRange, canExport };
}
