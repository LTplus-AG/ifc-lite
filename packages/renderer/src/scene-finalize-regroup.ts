/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';
import { BATCH_CONSTANTS } from './constants.js';

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
  /** Called before a moved mesh joins a bucket that existed before the re-group. */
  beforeJoin?(bucket: Bucket): void;
  /**
   * The frame `resolveActiveBucket` would give a bucket it created now for this
   * mesh. With it, a streamed bucket that re-routing would rebuild exactly as it
   * stands is kept instead of dissolved (see `intactStreamedBuckets`).
   */
  freshFrameOrigin?(meshData: MeshData): [number, number, number] | undefined;
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
  const intact = intactStreamedBuckets(host);
  const activeSnapshot = new Map(host.activeBucketKey);
  const pendingSnapshot = new Set(host.pendingBatchKeys);
  const streamedSnapshot = new Set(host.streamedBucketKeys);
  const dissolved: Array<[string, Bucket]> = [];
  const retired: BatchedMesh[] = [];
  const moved: MeshData[] = [];
  // The re-route order: every moved mesh, and each intact bucket at the place
  // its first mesh would have re-created it, so the bucket map (and with it the
  // batch draw order) ends exactly as a full re-route leaves it.
  const order: Array<MeshData | Bucket> = [];
  const vertexBytesBefore = new Map<Bucket, number>();
  /** A kept bucket's count once re-grouped: anything above it at a rollback streamed in since. */
  const vertexBytesRegrouped = new Map<Bucket, number>();

  for (const key of host.streamedBucketKeys) {
    const bucket = host.buckets.get(key);
    if (!bucket) continue;
    if (host.coldBuckets.has(key) && bucket.meshData.length === 0) continue;
    host.buckets.delete(key);
    host.pendingBatchKeys.delete(key);
    dissolved.push([key, bucket]);
    if (intact.has(bucket)) {
      vertexBytesBefore.set(bucket, bucket.vertexBytes);
      order.push(bucket);
      continue;
    }
    if (bucket.batchedMesh) retired.push(bucket.batchedMesh);
    for (const md of bucket.meshData) { moved.push(md); order.push(md); }
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
      const bytes = vertexBytesBefore.get(bucket);
      const regrouped = vertexBytesRegrouped.get(bucket);
      if (bytes !== undefined) bucket.vertexBytes = bytes + (regrouped === undefined ? 0 : Math.max(0, bucket.vertexBytes - regrouped));
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
    for (const entry of order) {
      if (intact.has(entry as Bucket)) {
        const bucket = entry as Bucket;
        // What re-routing its meshes into a fresh bucket would have counted.
        let bytes = 0;
        for (const md of bucket.meshData) bytes += (md.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;
        bucket.vertexBytes = bytes;
        vertexBytesRegrouped.set(bucket, bytes);
        host.buckets.set(bucket.key, bucket);
        if (!host.pendingBatchKeys.has(bucket.key)) addedPending.add(bucket.key);
        host.pendingBatchKeys.add(bucket.key);
        continue;
      }
      const meshData = entry as MeshData;
      const key = host.resolveActiveBucket(host.bucketBaseKey(meshData), meshData);
      let bucket = host.buckets.get(key);
      if (!bucket) {
        bucket = host.createBucket(key);
        host.buckets.set(key, bucket);
      } else host.beforeJoin?.(bucket);
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

/**
 * Streamed buckets the re-group would rebuild exactly as they stand, so it keeps
 * them instead of dissolving and re-routing every mesh (each re-route re-reads
 * the key and re-checks f32 topology). A bucket qualifies when re-routing its
 * meshes, in their order, would land every one of them back in a bucket with
 * the same key, frame and contents:
 * - it has no built batch, is not cold, and its key was never split (the key is
 *   still the active key for its base, and is that base);
 * - every mesh still keys to it (no colour changed in place while streaming);
 * - no mesh moving out of another streamed bucket keys to it, which would
 *   interleave into its order;
 * - a bucket created now would take the frame it already has.
 * Re-routing then sees the same frames and, from a zero byte count, the same or
 * smaller running sizes, so it splits nothing streaming did not split.
 */
function intactStreamedBuckets<Bucket extends RegroupBucket>(host: RegroupHost<Bucket>): ReadonlySet<Bucket> {
  const kept = new Set<Bucket>();
  if (!host.freshFrameOrigin) return kept;
  const targets = new Set<string>();
  const candidates: Bucket[] = [];
  for (const key of host.streamedBucketKeys) {
    const bucket = host.buckets.get(key);
    if (!bucket || bucket.meshData.length === 0) continue;
    const bases = bucket.meshData.map((md) => host.bucketBaseKey(md));
    const settled = bucket.batchedMesh === null && !host.coldBuckets.has(key)
      && (host.activeBucketKey.get(key) ?? key) === key && bases.every((base) => base === key);
    if (settled) candidates.push(bucket);
    else for (const base of bases) targets.add(base);
  }
  for (const bucket of candidates) {
    if (targets.has(bucket.key)) continue;
    const fresh = host.freshFrameOrigin(bucket.meshData[0]);
    const own = bucket.frameOrigin;
    if (fresh && own && fresh[0] === own[0] && fresh[1] === own[1] && fresh[2] === own[2]) kept.add(bucket);
  }
  return kept;
}
