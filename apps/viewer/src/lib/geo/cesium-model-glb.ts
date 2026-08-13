/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryResult } from '@ifc-lite/geometry';
import { getGlobalRenderer } from '../../hooks/useBCF.js';
import { withInstancedMeshes } from '../../utils/instancedExport.js';
import { buildMergedGLB } from './cesium-glb.js';

/**
 * Cheap identity for the mesh set {@link buildCesiumModelGLB} would build from.
 * O(1): a flat mesh count plus the scene's instanced-entity census.
 *
 * The overlay caches the built GLB and must not rebuild it on every camera or
 * placement change, but the flat count alone is not enough of a key. A geometry
 * batch whose occurrences are ALL instanced adds no flat meshes, so keying on
 * `meshes.length` would report "unchanged" for a batch that changed the model.
 */
export function cesiumModelGLBKey(geometryResult: GeometryResult): string {
  const instancedEntities = getGlobalRenderer()?.getScene()?.getInstancedEntityCount() ?? 0;
  return `${geometryResult.meshes.length}:${instancedEntities}`;
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
export function buildCesiumModelGLB(geometryResult: GeometryResult): {
  glb: Uint8Array;
  key: string;
} {
  const key = cesiumModelGLBKey(geometryResult);
  const complete = withInstancedMeshes(geometryResult, true);
  return { glb: buildMergedGLB(complete.meshes), key };
}
