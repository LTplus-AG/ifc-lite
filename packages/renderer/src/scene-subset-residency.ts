/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Residency of a batch drawn only through partial sub-batches (#9050).
 *
 * Under hide or isolate, a sub-batch draws from its own buffers, cut from the
 * parent's CPU pieces, and never reads the parent's GPU buffers. So the parent
 * may lose those buffers while its pieces stay warm (#9034). This module holds
 * the Scene-side bookkeeping for that: restores that stop at warm, evicted
 * parents whose sub-batches outlive their buffers, and the capped synchronous
 * rebuild when such a parent is drawn whole again.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';
import { MIN_EVICTION_AGE_FRAMES, type BatchUseFrames } from './residency.js';

interface SubsetBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
  frameOrigin?: [number, number, number];
}

/** The Scene internals this reads, reached through a cast like SceneRecoveryHost. */
export interface SceneSubsetResidencyHost {
  gpuBudgetBytes: number | null;
  residencyFrame: number;
  geometryReleased: boolean;
  ephemeralStreamingMode: boolean;
  buckets: Map<string, SubsetBucket>;
  batchedMeshes: BatchedMesh[];
  coldBuckets: Set<string>;
  lastDrawnFrame: BatchUseFrames;
  residencyRestoreQueue: Set<string>;
  createBatchedMesh(meshes: MeshData[], color: [number, number, number, number], device: GPUDevice, pipeline: RenderPipeline, bucketKey?: string): BatchedMesh;
  dropPartialCacheForBatch(batch: BatchedMesh): void;
}

/** The #9050 state a Scene keeps beside its residency queue, and the steps that use it. */
export class SubsetParentResidency {
  /** Queued restore keys only a subset wants: CPU pieces, no GPU rebuild. */
  readonly warmOnly = new Set<string>();
  /** Evicted batches with sub-batches cut from them. */
  readonly parents = new Set<BatchedMesh>();
  /** Per frame for restoreParentNow; the rest go to the queue. */
  rebuildBudgetMs = 32;
  private rebuildFrame = -1;
  private rebuildSpentMs = 0;

  constructor(private readonly host: SceneSubsetResidencyHost) {}

  clear(): void {
    this.warmOnly.clear();
    this.parents.clear();
  }

  /** Record that a pass drew this batch only as a partial sub-batch cut from
   *  its CPU pieces. The pieces stay warm (#9034); the batch's own GPU buffers,
   *  which nothing read, may still be evicted (#9050). `onScreen` is false for
   *  the shadow pass, whose casters may be outside the view. */
  recordSubsetDrawn(batch: BatchedMesh, onScreen: boolean): void {
    const host = this.host;
    if (host.gpuBudgetBytes === null) return;
    host.lastDrawnFrame.setSubset(batch.id, host.residencyFrame, onScreen);
    if (batch.gpuResident === false) this.parents.add(batch);
  }

  /**
   * A partial sub-batch wants the CPU pieces of an evicted batch, not its GPU
   * buffers. A warm batch already has them; a cold one is queued for a disk
   * restore that stops at warm, unless a full draw also asks for it.
   * Returns true while the pieces are on disk only (#9136).
   */
  requestPieces(batch: BatchedMesh): boolean {
    const host = this.host;
    const bucket = host.buckets.get(batch.colorKey);
    if (!bucket || bucket.batchedMesh !== batch || !host.coldBuckets.has(bucket.key)) return false;
    if (host.residencyRestoreQueue.has(bucket.key)) return true;
    host.residencyRestoreQueue.add(bucket.key);
    this.warmOnly.add(bucket.key);
    return true;
  }

  /** Queue the keys a cold restore of `key` came back as. A restore only a
   *  subset asked for stops at warm, in every chunk a repartition splits it into. */
  requeueColdRestore(key: string, restoredKeys: Iterable<string>): void {
    const warmOnly = this.warmOnly.delete(key);
    for (const restoredKey of restoredKeys) {
      this.host.residencyRestoreQueue.add(restoredKey);
      if (warmOnly) this.warmOnly.add(restoredKey);
    }
  }

  /** The budget pass evicted `batch`. A subset drawn this frame reads its own
   *  buffers, cut from the pieces the shell keeps under the same id: keep it.
   *  Otherwise free its VRAM. */
  noteEvicted(batch: BatchedMesh): void {
    const host = this.host;
    host.lastDrawnFrame.evicted(batch.id);
    if (host.lastDrawnFrame.getAnyUse(batch.id) === host.residencyFrame) this.parents.add(batch);
    else host.dropPartialCacheForBatch(batch);
  }

  /**
   * Rebuild an evicted bucket batch from its warm pieces and swap it in. The
   * replaced shell's sub-batches are keyed by its id, which no frame will ask
   * for again, so they go with it. The rebuild is seeded as just drawn so the
   * budget pass can't evict it before the frame that asked for it draws it.
   */
  rebuildEvicted(bucket: SubsetBucket, old: BatchedMesh, device: GPUDevice, pipeline: RenderPipeline): BatchedMesh {
    const host = this.host;
    const rebuilt = host.createBatchedMesh(bucket.meshData, bucket.meshData[0].color, device, pipeline, bucket.key);
    bucket.batchedMesh = rebuilt;
    bucket.frameOrigin = rebuilt.origin;
    const idx = host.batchedMeshes.indexOf(old);
    if (idx >= 0) host.batchedMeshes[idx] = rebuilt;
    else host.batchedMeshes.push(rebuilt);
    host.dropPartialCacheForBatch(old);
    this.parents.delete(old);
    host.lastDrawnFrame.delete(old.id);
    host.lastDrawnFrame.set(rebuilt.id, host.residencyFrame);
    host.residencyRestoreQueue.delete(bucket.key);
    this.warmOnly.delete(bucket.key);
    return rebuilt;
  }

  /**
   * An evicted batch whose subset was on screen last frame is now drawn whole
   * (hide or isolate cleared). Rebuild it now rather than through the
   * time-sliced queue, or the elements on screen would vanish for the frames
   * the rebuild takes. Capped per frame, so clearing isolate over a whole
   * model cannot stall one frame on every batch: past the cap the rest pop
   * back through the queue as usual. Returns the rebuilt batch to draw, or
   * null when the caller should skip it and queue the usual restore.
   */
  restoreParentNow(batch: BatchedMesh, device: GPUDevice, pipeline: RenderPipeline): BatchedMesh | null {
    const host = this.host;
    if (batch.gpuResident !== false || host.geometryReleased || host.ephemeralStreamingMode) return null;
    // Only a subset the colour pass drew: off-screen shadow casters must not
    // spend the cap that on-screen parents need.
    const lastUse = host.lastDrawnFrame.getSubsetOnScreen(batch.id);
    if (lastUse === undefined || lastUse < host.residencyFrame - 1) return null;
    const bucket = host.buckets.get(batch.colorKey);
    if (!bucket || bucket.batchedMesh !== batch || bucket.meshData.length === 0) return null;
    if (this.rebuildFrame !== host.residencyFrame) {
      this.rebuildFrame = host.residencyFrame;
      this.rebuildSpentMs = 0;
    }
    if (this.rebuildSpentMs >= this.rebuildBudgetMs) return null;
    const start = performance.now();
    const rebuilt = this.rebuildEvicted(bucket, batch, device, pipeline);
    this.rebuildSpentMs += performance.now() - start;
    return rebuilt;
  }

  /** Free the sub-batches of evicted parents once no frame has drawn a subset
   *  of them for the eviction age: no budget counts that VRAM, and nothing
   *  else frees a slot that the frame stops asking for. */
  sweep(): void {
    const host = this.host;
    for (const batch of this.parents) {
      const current = host.buckets.get(batch.colorKey)?.batchedMesh === batch && batch.gpuResident === false;
      const lastUse = host.lastDrawnFrame.getAnyUse(batch.id) ?? -1;
      if (current && host.residencyFrame - lastUse < MIN_EVICTION_AGE_FRAMES) continue;
      host.dropPartialCacheForBatch(batch);
      this.parents.delete(batch);
    }
  }
}
