/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared "is the orbit-pivot raycast too expensive?" census for the mouse and
 * touch orbit-start handlers.
 *
 * Anchoring the orbit pivot under the cursor/finger uses a CPU raycast whose
 * first call materializes every entity (including GPU-instanced occurrences)
 * and builds a BVH — on large models that is a visible input-to-first-frame
 * stall right at gesture start. Skipping it degrades gracefully: the pivot
 * falls back to the scene centre projected onto the pointer ray.
 *
 * The census must count GPU-instanced entities and total triangles, not just
 * flat meshes/batches: a CATIA-class model can sit well under the entity
 * threshold on flat entities alone while carrying tens of thousands of
 * instanced occurrences and millions of triangles.
 */

/** Structural slice of the renderer Scene used by the census. */
export interface PivotCensusScene {
  getMeshes(): ReadonlyArray<unknown>;
  getBatchedMeshes(): ReadonlyArray<{ expressIds: ArrayLike<number>; indexCount: number }>;
  getInstancedEntityCount(): number;
}

export const PIVOT_RAYCAST_MAX_ENTITIES = 50_000;
/** 3M indices = 1M triangles: above this the first-raycast BVH build stalls. */
export const PIVOT_RAYCAST_MAX_INDICES = 3_000_000;

/** True when the first-pivot raycast would stall the main thread at gesture start. */
export function isPivotRaycastTooExpensive(scene: PivotCensusScene): boolean {
  let totalEntities = scene.getMeshes().length + scene.getInstancedEntityCount();
  // Check before the batch loop too: a purely-instanced scene has no batched
  // meshes, so a loop-only check would never see the instanced count.
  if (totalEntities > PIVOT_RAYCAST_MAX_ENTITIES) return true;
  let totalIndices = 0;
  for (const b of scene.getBatchedMeshes()) {
    totalEntities += b.expressIds.length;
    if (totalEntities > PIVOT_RAYCAST_MAX_ENTITIES) return true;
    totalIndices += b.indexCount;
    if (totalIndices > PIVOT_RAYCAST_MAX_INDICES) return true;
  }
  return false;
}
