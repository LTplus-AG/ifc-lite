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
  recordBatchSubsetDrawn(batch: BatchedMesh): void;
  getOrCreatePartialBatch(key: string, colorKey: string, ids: Set<number>, device: GPUDevice, pipeline: RenderPipeline, epoch: number): BatchedMesh | null | undefined;
}
function noteResidency(scene: ShadowBatchScene, batch: BatchedMesh): void {
  if (batch.color[3] < DEFAULT_MIN_CAST_ALPHA) return;
  if (batch.gpuResident === false) scene.requestBatchResidency(batch); else scene.recordBatchDrawn(batch);
}
export function shadowOccluderBatches(scene: ShadowBatchScene, options: RenderOptions, device: GPUDevice, filtered: boolean, pipeline: RenderPipeline | null, epoch: number): BatchedMesh[] {
  const all = scene.getBatchedMeshes();
  if (!filtered) { for (const batch of all) noteResidency(scene, batch); return all; }
  const result: BatchedMesh[] = [];
  for (const batch of all) {
    const visible = classifyBatchVisibility(batch.expressIds, options.hiddenIds, options.isolatedIds);
    if (visible.kind === 'none') continue;
    if (visible.kind === 'all') { noteResidency(scene, batch); result.push(batch); continue; }
    if (batch.color[3] < DEFAULT_MIN_CAST_ALPHA || !pipeline) continue;
    if (batch.gpuResident === false) scene.requestBatchPieces(batch); // a subset reads pieces, not parent buffers (#9050)
    const subset = scene.getOrCreatePartialBatch(`${batch.colorKey}:${batch.id}`, batch.colorKey, visible.visibleIds, device, pipeline, epoch);
    // #9034/#9050: a subset cut from the parent's CPU pieces keeps those pieces warm, resident or not.
    if (subset && subset.indexCount > 0) { scene.recordBatchSubsetDrawn(batch); result.push(subset); }
  }
  return result;
}
