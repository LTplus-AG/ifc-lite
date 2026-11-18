/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RenderPipeline } from './pipeline.js';
import { DEFAULT_MIN_CAST_ALPHA } from './shadow-occluders.js';
import type { BatchedMesh } from './types.js';
import { batchForWholeDraw, type WholeBatchResidency } from './residency.js';
import { canFilterOnGpu, type BatchVisibility } from './batch-visibility.js';

export interface ShadowBatchScene extends WholeBatchResidency {
  getBatchedMeshes(): BatchedMesh[];
  subsetStandIns(batch: BatchedMesh): BatchedMesh[];
}
/** A whole batch casts from its own buffers. Returns what to cast: the
 *  rebuild when an evicted parent whose subset was on screen is drawn whole
 *  again (#9050), rebuilt here because this pass runs before the colour pass.
 *  An evicted parent past the rebuild cap casts from the same stand-ins the
 *  colour pass draws, so visible geometry keeps its shadow (#9227). */
function noteResidency(scene: ShadowBatchScene, batch: BatchedMesh, device: GPUDevice, pipeline: RenderPipeline | null): BatchedMesh[] {
  if (batch.color[3] < DEFAULT_MIN_CAST_ALPHA) return [batch];
  const whole = batchForWholeDraw(scene, batch, device, pipeline);
  if (whole) return [whole];
  const standIns = scene.subsetStandIns(batch);
  return standIns.length > 0 ? standIns : [batch];
}

/**
 * The batches the sun shadow pass casts, under the colour pass's visibility
 * (#2670, #10264 S2). A fully hidden batch is dropped. A partly hidden one
 * casts its own buffers whole, and the collector marks it for the shadow
 * fragment's visibility test, so a hidden element throws no phantom shadow
 * and no sub-batch is cut from the CPU copy of the geometry. Without the GPU
 * table (see `canFilterOnGpu`) a partly hidden batch does not cast at all.
 */
export function shadowOccluderBatches(
  scene: ShadowBatchScene,
  device: GPUDevice,
  pipeline: RenderPipeline | null,
  visibility: (batch: BatchedMesh) => BatchVisibility,
  gpuVisibility: boolean,
): BatchedMesh[] {
  const result: BatchedMesh[] = [];
  for (const batch of scene.getBatchedMeshes()) {
    const vis = visibility(batch);
    if (vis === 'none' || (vis !== 'all' && !canFilterOnGpu(batch, gpuVisibility))) continue;
    result.push(...noteResidency(scene, batch, device, pipeline));
  }
  return result;
}
