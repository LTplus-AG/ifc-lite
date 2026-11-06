/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { RenderPipeline } from './pipeline.js';
import { classifyBatchVisibility, DEFAULT_MIN_CAST_ALPHA } from './shadow-occluders.js';
import type { BatchedMesh, RenderOptions } from './types.js';

export interface ShadowBatchScene {
  getBatchedMeshes(): BatchedMesh[];
  requestBatchResidency(batch: BatchedMesh): void;
  requestBatchPieces(batch: BatchedMesh): void;
  recordBatchDrawn(batch: BatchedMesh): void;
  recordBatchSubsetDrawn(batch: BatchedMesh, onScreen?: boolean): void;
  restoreSubsetParentNow(batch: BatchedMesh, device: GPUDevice, pipeline: RenderPipeline): BatchedMesh | null;
  getOrCreatePartialBatch(key: string, colorKey: string, ids: Set<number>, device: GPUDevice, pipeline: RenderPipeline, epoch: number): BatchedMesh | null | undefined;
}
/** A whole batch casts from its own buffers. Returns the batch to cast: the
 *  rebuild when an evicted parent whose subset was on screen is drawn whole
 *  again (#9050), rebuilt here because this pass runs before the colour pass. */
function noteResidency(scene: ShadowBatchScene, batch: BatchedMesh, device: GPUDevice, pipeline: RenderPipeline | null): BatchedMesh {
  if (batch.color[3] < DEFAULT_MIN_CAST_ALPHA) return batch;
  if (batch.gpuResident !== false) { scene.recordBatchDrawn(batch); return batch; }
  const rebuilt = pipeline ? scene.restoreSubsetParentNow(batch, device, pipeline) : null;
  if (!rebuilt) { scene.requestBatchResidency(batch); return batch; }
  scene.recordBatchDrawn(rebuilt);
  return rebuilt;
}
export function shadowOccluderBatches(scene: ShadowBatchScene, options: RenderOptions, device: GPUDevice, filtered: boolean, pipeline: RenderPipeline | null, epoch: number): BatchedMesh[] {
  const all = scene.getBatchedMeshes();
  if (!filtered) return all.map((batch) => noteResidency(scene, batch, device, pipeline));
  const result: BatchedMesh[] = [];
  for (const batch of all) {
    const visible = classifyBatchVisibility(batch.expressIds, options.hiddenIds, options.isolatedIds);
    if (visible.kind === 'none') continue;
    if (visible.kind === 'all') { result.push(noteResidency(scene, batch, device, pipeline)); continue; }
    if (batch.color[3] < DEFAULT_MIN_CAST_ALPHA || !pipeline) continue;
    if (batch.gpuResident === false) scene.requestBatchPieces(batch); // a subset reads pieces, not parent buffers (#9050)
    const subset = scene.getOrCreatePartialBatch(`${batch.colorKey}:${batch.id}`, batch.colorKey, visible.visibleIds, device, pipeline, epoch);
    // #9034/#9050: a subset cut from the parent's CPU pieces keeps those pieces warm, resident or not.
    if (subset && subset.indexCount > 0) { scene.recordBatchSubsetDrawn(batch, false); result.push(subset); }
  }
  return result;
}
