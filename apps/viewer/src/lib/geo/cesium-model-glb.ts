/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import { getGlobalRenderer } from '../../hooks/useBCF.js';
import { withInstancedMeshes } from '../../utils/instancedExport.js';
import { buildMergedGLB } from './cesium-glb.js';

/**
 * Cheap identity for the mesh set {@link buildCesiumModelGLB} would build from.
 * O(1): the store's in-place-mutation counter, the flat mesh count, and the
 * scene's instanced-entity census.
 *
 * The overlay caches the built GLB and must not rebuild it on every camera or
 * placement change, but a count alone is not enough of a key. Two changes slip
 * past counts:
 *
 *  - A geometry batch whose occurrences are ALL instanced adds no flat meshes,
 *    so `meshes.length` reports "unchanged" for a batch that changed the model.
 *    The instanced-entity census catches that one.
 *  - An in-place edit (a gizmo move rewrites positions in the SAME arrays)
 *    changes no count at all. `geometryContentVersion` is the store's existing
 *    signal for exactly that, which is why callers pass it in.
 */
export function cesiumModelGLBKey(
  geometryResult: GeometryResult,
  geometryContentVersion: number,
): string {
  const instancedEntities = getGlobalRenderer()?.getScene()?.getInstancedEntityCount() ?? 0;
  return `${geometryContentVersion}:${geometryResult.meshes.length}:${instancedEntities}`;
}

/**
 * Build the GLB the Cesium world view loads, from the COMPLETE model.
 *
 * `geometryResult.meshes` is only part of the geometry: GPU-instanced
 * occurrences (repeated opaque shapes — facade panels, mullions, windows)
 * render from compact shards and are deliberately absent from that flat list,
 * as `utils/instancedExport.ts` documents. `buildMergedGLB` used to be handed
 * the flat list directly, so the world view dropped every repeated occurrence:
 * on the model from issue #2558 that was 9,950 of 18,555 meshes and 396K of
 * 655K triangles — the whole curtain-wall facade, leaving bare floor slabs on
 * the map while the WebGPU viewport looked correct.
 *
 * Builder and cache key live together so the bytes and the key describing them
 * cannot drift apart.
 *
 * `isPrimary` is `true` because — unlike the per-model exporters that share
 * `withInstancedMeshes` — the world view renders the whole merged federation.
 * Its mesh list already spans every loaded model, the scene only holds
 * templates for models still present (a hidden or removed model's are torn down
 * by `removeInstancedTemplatesForModel`, #2258), and shard entity ids are
 * re-homed onto their owning model's id space at upload (#1912). So every
 * occurrence the scene can hand back belongs in this GLB.
 */
export function buildCesiumModelGLB(
  geometryResult: GeometryResult,
  geometryContentVersion: number,
): {
  glb: Uint8Array;
  key: string;
} {
  const key = cesiumModelGLBKey(geometryResult, geometryContentVersion);
  const complete = withInstancedMeshes(geometryResult, true);
  return { glb: buildMergedGLB(complete.meshes), key };
}
