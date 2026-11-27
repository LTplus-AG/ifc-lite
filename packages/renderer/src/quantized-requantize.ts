/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rebuilding the bucket batches built before the quantized pipeline probe resolved
 * (`enableRendererQuantizedBatches`, quantized-lifecycle.ts).
 */

import type { RenderPipeline } from './pipeline.js';
import { builtUnquantized } from './scene-batch-upload.js';
import type { Scene } from './scene.js';
import type { BatchedMesh } from './types.js';

/** The Scene state `requantizeEarlyBatches` reads (private fields, as the Scene's other helpers read them). */
interface BucketsView {
  buckets: ReadonlyMap<string, { meshData: readonly unknown[]; batchedMesh: BatchedMesh | null }>;
  pendingBatchKeys: Set<string>;
  bumpPickGeometryRevision(): void;
}

/** How long a deferred requantize waits before it looks again for a scene with no stream or finalize. */
const RETRY_MS = 100;

/**
 * The quantized pipelines exist now, after bucket batches were built without them (a load that
 * finished before the probe resolved). Those batches would stay f32 for good, while the same model
 * loaded a moment later draws quantized. Mark exactly their buckets and rebuild them (`auto`: f32
 * still where the lattice would collapse an entity, #9068). While a stream or its finalize runs this
 * waits (`schedule`) and looks again: a time-sliced finalize has already taken its pending keys, so
 * keys marked meanwhile would stay pending. `isCurrent` false (the renderer moved on) drops it.
 * Returns the number of marked buckets after a successful rebuild, 0 if it fails, or -1 if deferred.
 */
export function requantizeEarlyBatches(
  scene: Scene, device: () => GPUDevice, pipeline: RenderPipeline, isCurrent: () => boolean = () => true,
  schedule: (retry: () => void) => void = (retry) => { setTimeout(retry, RETRY_MS); },
): number {
  if (!isCurrent()) return 0;
  if (scene.hasStreamingFragments() || scene.isFinalizeInProgress()) {
    schedule(() => { requantizeEarlyBatches(scene, device, pipeline, isCurrent, schedule); });
    return -1;
  }
  const view = scene as unknown as BucketsView;
  let marked = 0;
  for (const [key, bucket] of view.buckets) {
    const batch = bucket.batchedMesh;
    // Released or evicted geometry keeps the batch it has (nothing to rebuild from, or not resident).
    if (batch && builtUnquantized.has(batch) && bucket.meshData.length > 0 && batch.gpuResident !== false) {
      view.pendingBatchKeys.add(key);
      marked++;
    }
  }
  if (marked === 0) return 0;
  try {
    scene.rebuildPendingBatches(device(), pipeline);
  } catch (error) {
    // The keys stay pending: the next edit drain retries them, as for any failed rebuild.
    console.warn('[quantized] rebuilding batches built before the pipeline probe failed', error);
    return 0;
  }
  view.bumpPickGeometryRevision(); // hover and selection copies snap to the lattice of the batch they cover
  return marked;
}
