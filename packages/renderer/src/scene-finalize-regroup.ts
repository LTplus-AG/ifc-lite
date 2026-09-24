/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';

/** The slice of a bucket the finalize re-group reads and writes. */
export interface RegroupBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
  vertexBytes: number;
  frameOrigin?: [number, number, number];
}

/** The scene state a streaming finalize re-groups. Maps are mutated in place. */
export interface RegroupHost<Bucket extends RegroupBucket> {
  buckets: Map<string, Bucket>;
  meshDataBucket: Map<MeshData, Bucket>;
  activeBucketKey: Map<string, string>;
  coldBuckets: ReadonlySet<string>;
  pendingBatchKeys: Set<string>;
  /** Buckets that received streamed meshes since the last finalize. */
  streamedBucketKeys: Set<string>;
  bucketBaseKey(meshData: MeshData): string;
  /** Routes a mesh to a bucket key, creating the bucket when needed. */
  resolveActiveBucket(baseKey: string, meshData: MeshData): string;
  /** Creates a bucket for a key the router left unpublished. */
  createBucket(key: string): Bucket;
}

export interface FinalizeRegroup {
  /**
   * Batches of the dissolved buckets. They stay live, and keep drawing from
   * the old flat array, until the replacement batches are swapped in; only
   * then may the caller free them.
   */
  retired: BatchedMesh[];
  /** Undo every map mutation, for a rebuild that failed before its swap. */
  rollback(): void;
}

/**
 * Re-group ONLY the meshes streamed since the last finalize (#5358).
 *
 * Finalize used to dissolve and rebuild every bucket in the scene, so each
 * federated add re-merged and re-uploaded the whole federation (O(N^2) over N
 * models) and held two GPU copies of all of it until the swap. The reason for
 * re-grouping at all is local to the streamed meshes: their colours can be
 * mutated in place while streaming (deferred style colours), so the key they
 * were bucketed under can be stale. Every other bucket is already correct and
 * keeps its batch.
 *
 * The streamed buckets are dissolved and their meshes re-routed by CURRENT
 * colour. A mesh may land in a bucket that already existed (same model, same
 * colour); that bucket is rebuilt with it, and nothing else is. Every key that
 * needs a (re)build is added to `pendingBatchKeys`. Cold shells are sealed and
 * are never dissolved.
 */
export function regroupStreamedBuckets<Bucket extends RegroupBucket>(host: RegroupHost<Bucket>): FinalizeRegroup {
  const activeSnapshot = new Map(host.activeBucketKey);
  const pendingSnapshot = new Set(host.pendingBatchKeys);
  const streamedSnapshot = new Set(host.streamedBucketKeys);
  const dissolved: Array<[string, Bucket]> = [];
  const retired: BatchedMesh[] = [];
  const moved: MeshData[] = [];

  for (const key of host.streamedBucketKeys) {
    const bucket = host.buckets.get(key);
    if (!bucket) continue;
    if (host.coldBuckets.has(key) && bucket.meshData.length === 0) continue;
    host.buckets.delete(key);
    host.pendingBatchKeys.delete(key);
    dissolved.push([key, bucket]);
    if (bucket.batchedMesh) retired.push(bucket.batchedMesh);
    for (const md of bucket.meshData) moved.push(md);
  }
  host.streamedBucketKeys.clear();

  // What the re-group adds to buckets that survive, so a rollback can take it
  // back out. Buckets that did not exist before are simply deleted.
  // Byte counters are snapshotted up front because the router bumps them
  // while it routes, before this loop can see which bucket it chose.
  const preexisting = new Map<string, number>();
  for (const [key, bucket] of host.buckets) preexisting.set(key, bucket.vertexBytes);
  const appended = new Map<Bucket, { meshCount: number; vertexBytes: number }>();
  const created = new Set<string>();

  const rollback = (): void => {
    for (const key of created) host.buckets.delete(key);
    for (const [bucket, before] of appended) {
      bucket.meshData.length = before.meshCount;
      bucket.vertexBytes = before.vertexBytes;
    }
    for (const [key, bucket] of dissolved) {
      host.buckets.set(key, bucket);
      for (const md of bucket.meshData) host.meshDataBucket.set(md, bucket);
    }
    host.activeBucketKey.clear();
    for (const [base, key] of activeSnapshot) host.activeBucketKey.set(base, key);
    host.pendingBatchKeys.clear();
    for (const key of pendingSnapshot) host.pendingBatchKeys.add(key);
    host.streamedBucketKeys.clear();
    for (const key of streamedSnapshot) host.streamedBucketKeys.add(key);
  };

  try {
    for (const meshData of moved) {
      const key = host.resolveActiveBucket(host.bucketBaseKey(meshData), meshData);
      let bucket = host.buckets.get(key);
      const bytesBefore = preexisting.get(key);
      if (bytesBefore !== undefined) {
        if (bucket && !appended.has(bucket)) {
          appended.set(bucket, { meshCount: bucket.meshData.length, vertexBytes: bytesBefore });
        }
      } else {
        created.add(key);
      }
      if (!bucket) {
        bucket = host.createBucket(key);
        host.buckets.set(key, bucket);
      }
      bucket.meshData.push(meshData);
      host.meshDataBucket.set(meshData, bucket);
      host.pendingBatchKeys.add(key);
    }
  } catch (error) {
    rollback();
    throw error;
  }

  return { retired, rollback };
}
