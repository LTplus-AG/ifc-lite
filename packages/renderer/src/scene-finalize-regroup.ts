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

  // Every bucket the re-group routes into, so a rollback can take exactly the
  // moved meshes (and their bytes) back out. Byte counters are snapshotted up
  // front because the router bumps them while it routes.
  const preexisting = new Map<string, number>();
  for (const [key, bucket] of host.buckets) preexisting.set(key, bucket.vertexBytes);
  const touched = new Map<string, { bucket: Bucket; bytesBefore: number; bytesAfter: number; created: boolean }>();
  const addedPending = new Set<string>();
  const activeChanges = new Map<string, { before?: string; after: string }>();

  // The async finalize can fail a whole chunk later, after more meshes have
  // streamed in. The rollback therefore undoes only what the re-group itself
  // did: it strips the moved meshes rather than truncating, keeps keys and
  // active split keys set since, and unions (never replaces) the key sets.
  const rollback = (): void => {
    const movedSet = new Set(moved);
    const restoredKeys = new Map(dissolved);
    for (const [key, entry] of touched) {
      const { bucket } = entry;
      const kept = bucket.meshData.filter((md) => !movedSet.has(md));
      bucket.meshData.splice(0, bucket.meshData.length, ...kept);
      bucket.vertexBytes = entry.bytesBefore + Math.max(0, bucket.vertexBytes - entry.bytesAfter);
      if (!entry.created || host.buckets.get(key) !== bucket) continue;
      const original = restoredKeys.get(key);
      if (kept.length === 0 || original) host.buckets.delete(key);
      if (original && kept.length > 0) {
        // Meshes streamed into the re-created key since: fold them back into
        // the bucket that owned the key before the re-group.
        for (const md of kept) {
          original.meshData.push(md);
          host.meshDataBucket.set(md, original);
        }
        original.vertexBytes += bucket.vertexBytes - entry.bytesBefore;
      }
    }
    for (const [key, bucket] of dissolved) {
      host.buckets.set(key, bucket);
      for (const md of bucket.meshData) host.meshDataBucket.set(md, bucket);
    }
    for (const [base, change] of activeChanges) {
      if (host.activeBucketKey.get(base) !== change.after) continue;
      if (change.before === undefined) host.activeBucketKey.delete(base);
      else host.activeBucketKey.set(base, change.before);
    }
    for (const key of addedPending) host.pendingBatchKeys.delete(key);
    for (const key of pendingSnapshot) host.pendingBatchKeys.add(key);
    for (const key of streamedSnapshot) host.streamedBucketKeys.add(key);
  };

  try {
    for (const meshData of moved) {
      const key = host.resolveActiveBucket(host.bucketBaseKey(meshData), meshData);
      let bucket = host.buckets.get(key);
      if (!bucket) {
        bucket = host.createBucket(key);
        host.buckets.set(key, bucket);
      }
      if (!touched.has(key)) {
        touched.set(key, { bucket, bytesBefore: preexisting.get(key) ?? 0, bytesAfter: 0, created: !preexisting.has(key) });
      }
      bucket.meshData.push(meshData);
      host.meshDataBucket.set(meshData, bucket);
      if (!host.pendingBatchKeys.has(key)) addedPending.add(key);
      host.pendingBatchKeys.add(key);
    }
  } catch (error) {
    recordRegroupEffects();
    rollback();
    throw error;
  }
  recordRegroupEffects();
  return { retired, rollback };

  // What the routing left behind, so a later rollback can tell it apart from
  // anything that streams in afterwards.
  function recordRegroupEffects(): void {
    for (const entry of touched.values()) entry.bytesAfter = entry.bucket.vertexBytes;
    for (const [base, key] of host.activeBucketKey) {
      const before = activeSnapshot.get(base);
      if (before !== key) activeChanges.set(base, { before, after: key });
    }
  }
}
