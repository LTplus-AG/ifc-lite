/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the compact page code (compact-store.ts, scene-compact.ts) uses of the
 * renderer's always-loaded modules, handed to it by the Scene.
 *
 * The page code is a chunk loaded on demand. Importing these modules from it
 * directly makes a bundler move them into chunks of their own, shared between
 * the eager bundle and that chunk, which costs every load. Passed in, they stay
 * where they are and the page chunk imports types only.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { pinBatchEntityIdAnchor } from './entity-color-table.js';
import type { RenderPipeline } from './pipeline.js';
import { createBatchUniform } from './scene-batch-upload.js';
import { LOD_MAX_KEPT_FRACTION, LOD_MIN_TRIANGLES, lodCellSizeForBounds, simplifyIndicesByClustering } from './lod-simplify.js';
import { MAX_COLLAPSED_AREA_FRACTION, MAX_QUANT_EXTENT, QUANT_STEP } from './quantize.js';
import { destroyGpuResources, entityLaneOf, packEntityLane } from './scene-geometry.js';
import type { SceneCompact, SceneCompactHost } from './scene-compact.js';
import type { BatchedMesh } from './types.js';

export interface CompactPageDeps {
  /** A batch's uniform slot and bind group, as every bucket batch gets. */
  createBatchUniform(device: GPUDevice, pipeline: RenderPipeline): Pick<BatchedMesh, 'uniformSlot' | 'bindGroup'>;
  destroyGpuResources(batch: BatchedMesh): void;
  pinBatchEntityIdAnchor(batch: BatchedMesh, anchor: number): void;
  /** The entity lane the bucket path stamps on `mesh`'s vertices: its id and colour salt. */
  laneOf(mesh: MeshData): number;
  /** What a bucket batch's build decides with (compact-lod.ts takes the same decisions for pages): its LOD1
   *  clustering and thresholds (lod-simplify.ts), and the lattice and extent of a quantized batch (quantize.ts). */
  bucket: {
    simplify: typeof simplifyIndicesByClustering;
    lodCellSize: typeof lodCellSizeForBounds;
    lodMinTriangles: number;
    lodMaxKeptFraction: number;
    quantStep: number;
    maxQuantExtent: number;
    maxCollapsedFraction: number;
  };
}

export const COMPACT_PAGE_DEPS: CompactPageDeps = {
  createBatchUniform,
  destroyGpuResources,
  pinBatchEntityIdAnchor,
  laneOf(mesh) {
    const { entityId, saltByte } = entityLaneOf(mesh);
    return packEntityLane(entityId, saltByte);
  },
  bucket: {
    simplify: simplifyIndicesByClustering,
    lodCellSize: lodCellSizeForBounds,
    lodMinTriangles: LOD_MIN_TRIANGLES,
    lodMaxKeptFraction: LOD_MAX_KEPT_FRACTION,
    quantStep: QUANT_STEP,
    maxQuantExtent: MAX_QUANT_EXTENT,
    maxCollapsedFraction: MAX_COLLAPSED_AREA_FRACTION,
  },
};

let pages: typeof SceneCompact | undefined;
let loading: Promise<void> | undefined;

/**
 * Fetch the compact page code (scene-compact.ts and compact-store.ts, a chunk
 * of their own). A host awaits this before a load that asks its workers for
 * compact records; every Scene, existing or created later, then draws
 * eligible compact meshes from pages. A Scene that never sees it loaded
 * decodes compact meshes onto its bucket path.
 */
export function loadCompactPages(): Promise<void> {
  // A failed fetch is not remembered: the next load tries again.
  return loading ??= import('./scene-compact.js').then(
    (module) => { pages = module.SceneCompact; },
    (error: unknown) => { loading = undefined; throw error; },
  );
}

/** A Scene's page host, once `loadCompactPages` has resolved; null before. */
export function createCompactPages(scene: SceneCompactHost): SceneCompact | null {
  return pages ? new pages(scene, COMPACT_PAGE_DEPS) : null;
}
