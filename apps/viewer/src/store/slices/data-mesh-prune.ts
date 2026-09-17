/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import { hostsOtherEntities } from '@ifc-lite/renderer';
import { meshGeometryCounts } from '@/lib/released-mesh-provenance';
import type { FederatedModel, PreAlignmentSnapshot } from '../types.js';

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
 * Renderer parity: `Scene.removeMeshesForEntity` (packages/renderer/src/scene.ts)
 * keeps a mesh only when `hostsOtherEntities` says its `entityIds` name OTHER
 * entities, and tombstones an instanced entity. This uses the same predicate, so
 * an authored element's mesh (`entityIds` holding only its own id) is pruned,
 * a genuinely colour-merged one is kept, and the id also leaves the
 * instanced-only metadata maps (hashes, AABBs, volumes).
 *
 * Bounded mode:`releaseGeometryMemory` empties a mesh's buffers but keeps the
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

/** `map` without `ids`, copied only when one of them is actually a key. */
function withoutIds<V>(map: Map<number, V> | undefined, ids: Set<number>): Map<number, V> | undefined {
  if (!map) return map;
  let next: Map<number, V> | undefined;
  for (const id of ids) {
    if (!map.has(id)) continue;
    next ??= new Map(map);
    next.delete(id);
  }
  return next ?? map;
}

/** Whether the drain drops `mesh`; the one rule the prune and its snapshot filter share. */
function removesMesh(mesh: GeometryResult['meshes'][number], ids: Set<number>): boolean {
  return ids.has(mesh.expressId) && !hostsOtherEntities(mesh);
}

/**
 * `preAlignment` restores its per-mesh arrays BY INDEX (`restorePreAlignment`
 * in hooks/ingest/federationRealign.ts), so removing a mesh must remove its
 * snapshot slot too, or every later mesh is restored from its predecessor's
 * slot on the next anchor switch. Slots past the snapshot's length belong to
 * meshes appended after the capture and have nothing to drop.
 */
function prunePreAlignment(
  snapshot: PreAlignmentSnapshot, meshes: GeometryResult['meshes'], ids: Set<number>,
): PreAlignmentSnapshot {
  const keep = (_: unknown, i: number) => i >= meshes.length || !removesMesh(meshes[i], ids);
  return {
    ...snapshot,
    positions: snapshot.positions.filter(keep),
    normals: snapshot.normals.filter(keep),
    origins: snapshot.origins.filter(keep),
    geometryAabbs: snapshot.geometryAabbs.filter(keep),
    instancedGeometryAabbs: withoutIds(snapshot.instancedGeometryAabbs, ids),
  };
}

/** A pruned copy of `geometry`, or `geometry` itself when nothing matched. */
function pruneGeometry(geometry: GeometryResult, ids: Set<number>): GeometryResult {
  const meshes = geometry.meshes;
  const kept: typeof meshes = [];
  let removedTriangles = 0;
  let removedVertices = 0;
  for (let i = 0; i < meshes.length; i++) {
    const mesh = meshes[i];
    if (removesMesh(mesh, ids)) {
      const counts = meshGeometryCounts(mesh);
      removedTriangles += counts.triangles;
      removedVertices += counts.vertices;
    } else {
      kept.push(mesh);
    }
  }
  const hashes = withoutIds(geometry.instancedGeometryHashes, ids);
  const aabbs = withoutIds(geometry.instancedGeometryAabbs, ids);
  const volumes = withoutIds(geometry.instancedGeometryVolumes, ids);
  const meshesChanged = kept.length !== meshes.length;
  if (!meshesChanged && hashes === geometry.instancedGeometryHashes
    && aabbs === geometry.instancedGeometryAabbs && volumes === geometry.instancedGeometryVolumes) {
    return geometry;
  }
  const next: GeometryResult = {
    ...geometry,
    meshes: meshesChanged ? kept : meshes,
    totalTriangles: geometry.totalTriangles - removedTriangles,
    totalVertices: geometry.totalVertices - removedVertices,
  };
  if (hashes) next.instancedGeometryHashes = hashes;
  if (aabbs) next.instancedGeometryAabbs = aabbs;
  if (volumes) next.instancedGeometryVolumes = volumes;
  return next;
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
    patch.models.set(modelId, {
      ...model,
      geometryResult: next,
      ...(model.preAlignment
        ? { preAlignment: prunePreAlignment(model.preAlignment, model.geometryResult.meshes, ids) }
        : {}),
    });
  }
  // Nothing in `ids` matched anywhere: leave the tick alone too.
  if (!patch.geometryResult && !patch.models) return {};
  patch.geometryUpdateTick = state.geometryUpdateTick + 1;
  return patch;
}
