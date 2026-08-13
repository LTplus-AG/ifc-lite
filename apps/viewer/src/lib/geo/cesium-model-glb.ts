/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { isEntityVisible } from '@ifc-lite/renderer';
import { getGlobalRenderer } from '../../hooks/useBCF.js';
import { withInstancedMeshes } from '../../utils/instancedExport.js';
import { buildMergedGLB } from './cesium-glb.js';

/** Everything the world-view GLB is a function of. */
export interface CesiumModelGLBInput {
  geometryResult: GeometryResult;
  /** Store counter for in-place mesh mutation (a gizmo move rewrites positions
   *  in the SAME arrays, moving no count). */
  geometryContentVersion: number;
  /** Hide/isolate exactly as the renderer receives them, in federated global
   *  id space — the same space flat and instanced mesh ids use (#1912). */
  hiddenIds: ReadonlySet<number> | null | undefined;
  isolatedIds: ReadonlySet<number> | null | undefined;
  /** Version from a `VisibilityEpochTracker` fed those two sets. Content-based,
   *  so it survives both in-place mutation of a set and a fresh Set with equal
   *  content — neither of which an identity check would catch. */
  visibilityVersion: number;
}

/**
 * Cheap identity for the mesh set {@link buildCesiumModelGLB} would build from.
 * O(1): the in-place-mutation counter, the flat mesh count, the scene's
 * instanced-entity census, and the visibility epoch.
 *
 * The overlay caches the built GLB and must not rebuild it on every camera or
 * placement change, but counts alone are not enough of a key. Three changes
 * slip past them:
 *
 *  - A geometry batch whose occurrences are ALL instanced adds no flat meshes,
 *    so `meshes.length` reports "unchanged" for a batch that changed the model.
 *    The instanced-entity census catches that one.
 *  - An in-place edit (a gizmo move rewrites positions in the SAME arrays)
 *    changes no count at all. `geometryContentVersion` catches that one.
 *  - Hiding or isolating changes which meshes belong in the GLB while every
 *    count above holds still. `visibilityVersion` catches that one.
 */
export function cesiumModelGLBKey(input: CesiumModelGLBInput): string {
  const instancedEntities = getGlobalRenderer()?.getScene()?.getInstancedEntityCount() ?? 0;
  return [
    input.geometryContentVersion,
    input.geometryResult.meshes.length,
    instancedEntities,
    input.visibilityVersion,
  ].join(':');
}

/**
 * Build the GLB the Cesium world view loads: the COMPLETE model, filtered to
 * what the viewport is actually drawing.
 *
 * Two things this has to get right, both of them bugs that shipped:
 *
 *  - **Completeness (#2558).** `geometryResult.meshes` is only part of the
 *    model. GPU-instanced occurrences render from compact shards and are
 *    deliberately absent from that flat list, as `utils/instancedExport.ts`
 *    documents. Handing it straight to `buildMergedGLB` dropped every repeated
 *    occurrence — 9,950 of 18,555 meshes on the model from #2558, a tower's
 *    whole curtain-wall facade, leaving bare floor slabs on the map.
 *  - **Visibility (#2578).** The world view renders through its own glTF
 *    pipeline, so it does not inherit the renderer's per-frame hide/isolate
 *    filtering. It honoured type visibility (the flat list arrives
 *    pre-filtered) but not hide or isolate, so a hidden element stayed on the
 *    map. Both halves are now filtered with `isEntityVisible`, the same rule
 *    the flat and instanced draw paths answer with.
 *
 * `isPrimary` is `true` for `withInstancedMeshes` because — unlike the
 * per-model exporters that share it — the world view renders the whole merged
 * federation. Its mesh list already spans every loaded model, the scene only
 * holds templates for models still present (a hidden or removed model's are
 * torn down by `removeInstancedTemplatesForModel`, #2258), and shard entity ids
 * are re-homed onto their owning model's id space at upload (#1912).
 */
export function buildCesiumModelGLB(input: CesiumModelGLBInput): {
  glb: Uint8Array;
  key: string;
} {
  const key = cesiumModelGLBKey(input);
  const complete = withInstancedMeshes(input.geometryResult, true);
  const visible = filterVisibleMeshes(complete.meshes, input.hiddenIds, input.isolatedIds);
  return { glb: buildMergedGLB(visible), key };
}

/** No-op (and no copy) when neither filter is active — the common case. */
function filterVisibleMeshes(
  meshes: readonly MeshData[],
  hiddenIds: ReadonlySet<number> | null | undefined,
  isolatedIds: ReadonlySet<number> | null | undefined,
): MeshData[] {
  const hiding = hiddenIds != null && hiddenIds.size > 0;
  const isolating = isolatedIds != null;
  if (!hiding && !isolating) return meshes as MeshData[];
  return meshes.filter((m) => isEntityVisible(m.expressId, hiddenIds, isolatedIds));
}
