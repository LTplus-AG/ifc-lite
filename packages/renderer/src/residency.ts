/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU residency policy (issue #1682, phase 3a of the chunked-residency plan).
 *
 * With spatial chunk bucketing (phase 2) a batch is a spatially compact,
 * independently destroyable GPU unit. This module decides WHICH resident
 * batches to evict when the scene exceeds a GPU byte budget. Eviction
 * destroys the batch's GPU buffers but keeps the batch object as a metadata
 * shell (bounds/expressIds/counts) and keeps the bucket's CPU `meshData`, so
 * the batch can be rebuilt on demand when the camera wants it again.
 *
 * Policy (two rules, mirroring the eviction hysteresis in Cesium-class
 * streamers):
 *   1. Never evict a batch drawn this frame — the budget is a target, not a
 *      hard cap; a scene whose visible set alone exceeds the budget renders
 *      correctly and stays over budget (callers may log/telemeter that).
 *   2. Among the rest, evict least-recently-drawn first, and only batches
 *      idle for at least `minAgeFrames` rendered frames — a batch that just
 *      left the frustum during an orbit is likely to come right back, and
 *      re-uploading it every half-gesture would thrash.
 *
 * Pure function over plain shells so the policy is unit-testable without a
 * GPU; the Scene owns the actual destroy/rebuild.
 */

import type { PartialBatchRequests } from './partial-batch-requests.js';
import type { RenderPipeline } from './pipeline.js';
import type { BatchedMesh } from './types.js';

/** Residency view of one bucket-owned batch. */
export interface ResidencyShell {
  /** Bucket key (identifies the bucket to rebuild from). */
  key: string;
  /** GPU bytes this batch holds (vertex + index + uniform). */
  bytes: number;
  /** Scene frame counter value when this batch was last drawn (-1 = never). */
  lastDrawnFrame: number;
}

/** Batches idle for fewer rendered frames than this are never evicted. */
export const MIN_EVICTION_AGE_FRAMES = 30;

/**
 * Cold-storage source for phase 3b (evict-to-disk): returns the meshes of
 * every cache chunk intersecting the given world AABB. The Scene filters the
 * result down to one bucket's members (by expressId + bucket base key), so
 * over-fetching neighbours is fine — providers should cache recently decoded
 * chunks since adjacent buckets restore together during a gesture.
 */
export interface ColdGeometryProvider {
  loadMeshesInBounds(
    min: [number, number, number],
    max: [number, number, number],
  ): Promise<import('@ifc-lite/geometry').MeshData[]>;
}

/** CPU bytes held by bucket meshData (positions + normals + indices): the host budget's measure. */
export function residentCpuBytes(buckets: Iterable<{ meshData: readonly import('@ifc-lite/geometry').MeshData[] }>): number {
  let total = 0;
  for (const bucket of buckets) {
    for (const md of bucket.meshData) {
      total += md.positions.byteLength + md.normals.byteLength + md.indices.byteLength;
    }
  }
  return total;
}

/**
 * Select batches to evict so `residentBytes` drops to `budgetBytes` or below.
 * `shells` must contain only ELIGIBLE batches (resident, bucket-owned, CPU
 * geometry retained, not drawn this frame). Returns the keys to evict, LRU
 * first; empty when already within budget or nothing is old enough.
 */
export function selectEvictions(
  shells: readonly ResidencyShell[],
  residentBytes: number,
  budgetBytes: number,
  currentFrame: number,
  minAgeFrames: number = MIN_EVICTION_AGE_FRAMES,
): string[] {
  let excess = residentBytes - budgetBytes;
  if (excess <= 0) return [];

  const candidates = shells
    .filter((s) => currentFrame - s.lastDrawnFrame >= minAgeFrames)
    .sort((a, b) => a.lastDrawnFrame - b.lastDrawnFrame);

  const evict: string[] = [];
  for (const shell of candidates) {
    if (excess <= 0) break;
    evict.push(shell.key);
    excess -= shell.bytes;
  }
  return evict;
}

/**
 * When each bucket batch was last used, split by what the use reads (#9050).
 * A full or LOD1 draw reads the batch's OWN GPU buffers and its CPU pieces
 * stay as the rebuild source; a partial sub-batch reads only the CPU pieces
 * (it owns separate buffers cut from them). So the GPU tier ages a batch by
 * own-buffer draws alone, while the host tier ages it by any use: a parent
 * drawn only through a subset may lose its GPU buffers but never the pieces
 * its on-screen subset draws from.
 */
export class BatchUseFrames {
  private readonly ownBuffers = new Map<number, number>();
  private readonly pieces = new Map<number, number>();
  private readonly subsetOnScreen = new Map<number, number>();

  /** Drawn from its own GPU buffers (also uses its pieces). */
  set(batchId: number, frame: number): void {
    this.ownBuffers.set(batchId, frame);
    this.pieces.set(batchId, frame);
  }

  /** Drawn only as a partial sub-batch cut from its CPU pieces: by the colour
   *  pass (`onScreen`) or only as a shadow caster, which may be off screen. */
  setSubset(batchId: number, frame: number, onScreen: boolean): void {
    this.pieces.set(batchId, frame);
    if (onScreen) this.subsetOnScreen.set(batchId, frame);
  }

  /** Last frame the colour pass drew a subset of it. */
  getSubsetOnScreen(batchId: number): number | undefined {
    return this.subsetOnScreen.get(batchId);
  }

  /** Last own-buffer draw: the GPU tier's age. */
  get(batchId: number): number | undefined {
    return this.ownBuffers.get(batchId);
  }

  /** Last use of any kind: the host (cold) tier's age. */
  getAnyUse(batchId: number): number | undefined {
    return this.pieces.get(batchId);
  }

  /** The batch's GPU buffers were evicted; its pieces' use still counts. */
  evicted(batchId: number): void {
    this.ownBuffers.delete(batchId);
  }

  /** The batch object is gone (replaced, retired or repartitioned). */
  delete(batchId: number): void {
    this.ownBuffers.delete(batchId);
    this.pieces.delete(batchId);
    this.subsetOnScreen.delete(batchId);
  }

  clear(): void {
    this.ownBuffers.clear();
    this.pieces.clear();
    this.subsetOnScreen.clear();
  }
}

/** What a whole-batch draw needs from the Scene (#9050). */
export interface WholeBatchResidency {
  recordBatchDrawn(batch: BatchedMesh): void;
  requestBatchResidency(batch: BatchedMesh): void;
  restoreSubsetParentNow(batch: BatchedMesh, device: GPUDevice, pipeline: RenderPipeline): BatchedMesh | null;
}

/**
 * The batch a whole-batch draw reads its own GPU buffers from, recorded as
 * drawn. A resident batch is itself. An evicted parent whose subset was on
 * screen last frame is rebuilt now, or those elements vanish while the queue
 * catches up (#9050). Any other evicted batch gets the time-sliced restore
 * queued and returns null, so the frame skips it. The colour and shadow passes
 * share this.
 */
export function batchForWholeDraw(scene: WholeBatchResidency, batch: BatchedMesh, device: GPUDevice, pipeline: RenderPipeline | null): BatchedMesh | null {
  let drawn: BatchedMesh | null = batch;
  if (batch.gpuResident === false) {
    drawn = pipeline ? scene.restoreSubsetParentNow(batch, device, pipeline) : null;
    if (!drawn) { scene.requestBatchResidency(batch); return null; }
  }
  scene.recordBatchDrawn(drawn);
  return drawn;
}

/** What drawing a fully visible batch as sub-batches needs from the Scene (#9136). */
export interface WholeSplitResidency {
  /** Restore a cold batch's CPU pieces, not its GPU buffers. True while they are not in memory. */
  requestBatchPieces(batch: BatchedMesh): boolean;
}

/**
 * Request a fully visible batch as sub-batches when one uniform can't draw it
 * (X-Ray alpha #4129, mixed promotion #677). Returns `'whole'` when the caller
 * draws it whole, `'split'` when its sub-batches were requested, and
 * `'pieces'` when it waits for its CPU pieces to come back from disk, so it is
 * missing this frame (#9227). Run this BEFORE `batchForWholeDraw` (#9136): the
 * sub-batches never read the parent's own GPU buffers, so it takes the partial
 * path's residency handling, as hide and isolate do (#9050). An evicted parent
 * is not rebuilt, and a cold one gets only its pieces back. Splitting after the
 * whole-draw step would rebuild the parent each frame after the budget evicts it.
 */
export function pushWholeSplit(requests: PartialBatchRequests, scene: WholeSplitResidency, batch: BatchedMesh, isTransparent: boolean): 'whole' | 'split' | 'pieces' {
  if (requests.pushWholeSplit(batch, isTransparent)) {
    return batch.gpuResident === false && scene.requestBatchPieces(batch) ? 'pieces' : 'split';
  }
  // A cold batch can't be partitioned until its pieces are back: fetch only them, then split.
  return batch.gpuResident === false && requests.wantsWholeSplit(batch, isTransparent) && scene.requestBatchPieces(batch) ? 'pieces' : 'whole';
}
