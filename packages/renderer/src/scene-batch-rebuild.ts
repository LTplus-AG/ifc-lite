/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';
import { destroyGpuResources } from './scene-geometry.js';

export interface RebuildableBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
  frameOrigin?: [number, number, number];
}

/** Build all replacements before retiring any currently visible batch. */
export function rebuildSceneBatches<Bucket extends RebuildableBucket>(options: {
  pendingKeys: Set<string>;
  buckets: Map<string, Bucket>;
  create(meshes: MeshData[], color: [number, number, number, number], device: GPUDevice, pipeline: RenderPipeline, key: string): BatchedMesh;
  dropPartial(batch: BatchedMesh): void;
}, device: GPUDevice, pipeline: RenderPipeline): void {
  if (options.pendingKeys.size === 0) return;
  const staged: Array<{ key: string; bucket: Bucket | undefined; replacement?: BatchedMesh }> = [];
  try {
    for (const key of options.pendingKeys) {
      const bucket = options.buckets.get(key);
      if (!bucket || bucket.meshData.length === 0) {
        staged.push({ key, bucket });
        continue;
      }
      staged.push({ key, bucket,
        replacement: options.create(bucket.meshData, bucket.meshData[0].color, device, pipeline, key) });
    }
  } catch (error) {
    for (const entry of staged) if (entry.replacement) destroyGpuResources(entry.replacement);
    throw error;
  }

  for (const { key, bucket, replacement } of staged) {
    if (!bucket || !replacement) {
      if (bucket?.batchedMesh) {
        options.dropPartial(bucket.batchedMesh);
        destroyGpuResources(bucket.batchedMesh);
      }
      options.buckets.delete(key);
      continue;
    }
    if (bucket.batchedMesh) {
      options.dropPartial(bucket.batchedMesh);
      destroyGpuResources(bucket.batchedMesh);
    }
    bucket.batchedMesh = replacement;
    bucket.frameOrigin = replacement.origin;
  }
  options.pendingKeys.clear();
}

/**
 * A model (other than 0) left with no batches forgets its shared frame, so
 * geometry drawn for it later is framed where it is, not where its last batch
 * was: a second scan-to-BIM overlay run far from the first (#6894). Bucket
 * keys of model `n > 0` start with `model<n>~`.
 */
export function forgetEmptyModelFrames(buckets: ReadonlyMap<string, unknown>, frames: Map<number, unknown>): void {
  const live = new Set([...buckets.keys()].map((key) => /^model(\d+)~/.exec(key)?.[1]));
  for (const index of frames.keys()) if (index !== 0 && !live.has(String(index))) frames.delete(index);
}
