/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { AppearanceBatchCohorts } from './appearance-batch-cohorts.js';
import type { AppearanceOwner } from './appearance-preview.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { BatchedMesh } from './types.js';
import { BATCH_CONSTANTS } from './constants.js';

export interface AppearanceBucket {
  key: string;
  meshData: MeshData[];
  batchedMesh: BatchedMesh | null;
  vertexBytes: number;
}
export interface AppearanceBucketAccess {
  buckets: Map<string, AppearanceBucket>;
  reverse(): Map<MeshData, AppearanceBucket>;
  create(parts: MeshData[], key: string): BatchedMesh;
  release(batch: BatchedMesh): void;
  changed(key: string): void;
  refresh(): void;
}
export interface FlatAppearanceResource {
  bucket: AppearanceBucket;
  partIndices: number[];
}

/** Partition shared batches before a draft owns GPU resources. Detached originals
 * then contain exactly one owner, so another draft can cancel in any order. */
export class AppearanceBuckets {
  private sequence = 0;
  private readonly cohorts: AppearanceBatchCohorts;
  constructor(
    private readonly access: AppearanceBucketAccess,
    parts: (id: number) => readonly MeshData[] | undefined,
  ) {
    this.cohorts = new AppearanceBatchCohorts(parts);
  }
  private create(
    parts: MeshData[],
    partIndices: number[],
  ): FlatAppearanceResource {
    const key = `appearance#${++this.sequence}`;
    const batchedMesh = this.access.create(parts, key);
    return {
      bucket: {
        key,
        meshData: parts,
        batchedMesh,
        vertexBytes: parts.reduce(
          (sum, part) =>
            sum +
            (part.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX,
          0,
        ),
      },
      partIndices,
    };
  }
  capture(parts: readonly MeshData[]): FlatAppearanceResource[] {
    const grouped = new Map<AppearanceBucket, number[]>();
    parts.forEach((part, index) => {
      const bucket = this.access.reverse().get(part);
      if (bucket) {
        if (!bucket.batchedMesh || bucket.batchedMesh.gpuResident === false)
          throw new Error('Appearance requires resident finalized geometry');
        const indices = grouped.get(bucket) ?? [];
        indices.push(index);
        grouped.set(bucket, indices);
      }
    });
    const replacements: {
      old: AppearanceBucket;
      owned: FlatAppearanceResource;
      rest?: FlatAppearanceResource;
    }[] = [];
    const staged: FlatAppearanceResource[] = [];
    try {
      for (const [old, indices] of grouped) {
        this.cohorts.register(old);
        const selected = new Set(indices.map((index) => parts[index]));
        const owned = this.create(
          indices.map((index) => parts[index]),
          indices,
        );
        staged.push(owned);
        const restParts = old.meshData.filter((part) => !selected.has(part));
        const rest = restParts.length ? this.create(restParts, []) : undefined;
        if (rest) staged.push(rest);
        replacements.push({ old, owned, rest });
      }
    } catch (error) {
      for (const resource of staged) this.release(resource);
      throw error;
    }
    for (const { old, owned, rest } of replacements) {
      this.cohorts.inherit(old, owned.bucket);
      if (rest) this.cohorts.inherit(old, rest.bucket);
    }
    // All allocations succeeded. Publish complete partitions, then dispose old batches.
    for (const { old, owned, rest } of replacements) {
      this.cohorts.detach(old);
      this.access.buckets.delete(old.key);
      this.access.changed(old.key);
      for (const resource of [owned, ...(rest ? [rest] : [])])
        this.attach(resource, resource.bucket.meshData);
    }
    this.access.refresh();
    for (const { old } of replacements)
      if (old.batchedMesh) this.dispose(old.batchedMesh);
    return replacements.map((entry) => entry.owned);
  }
  stage(
    parts: readonly MeshData[],
    indices: number[],
  ): FlatAppearanceResource[] {
    const groups = new Map<string, number[]>();
    for (const index of indices) {
      const cohort = this.cohorts.group(parts[index], index);
      const key = `${parts[index].color.join(',')}#${cohort?.id ?? 'new'}`;
      const group = groups.get(key) ?? [];
      group.push(index);
      groups.set(key, group);
    }
    const resources: FlatAppearanceResource[] = [];
    try {
      for (const group of groups.values()) {
        const resource = this.create(
          group.map((index) => parts[index]),
          group,
        );
        resources.push(resource);
        this.cohorts.assign(
          resource.bucket,
          this.cohorts.group(parts[group[0]], group[0]),
        );
      }
      return resources;
    } catch (error) {
      for (const resource of resources) this.release(resource);
      throw error;
    }
  }
  detach(owner: number): void {
    for (const [key, bucket] of this.access.buckets) {
      if (!bucket.meshData.some((part) => part.expressId === owner)) continue;
      if (bucket.meshData.some((part) => part.expressId !== owner))
        throw new Error('Appearance owner was not isolated');
      this.cohorts.detach(bucket);
      this.access.buckets.delete(key);
      for (const part of bucket.meshData) this.access.reverse().delete(part);
      this.access.changed(key);
    }
  }
  attach(resource: FlatAppearanceResource, parts: MeshData[]): void {
    resource.bucket.meshData = parts;
    this.cohorts.attach(resource.bucket);
    this.access.buckets.set(resource.bucket.key, resource.bucket);
    for (const part of parts) this.access.reverse().set(part, resource.bucket);
    this.access.changed(resource.bucket.key);
  }
  refresh(): void {
    this.access.refresh();
  }
  begin(owner: AppearanceOwner): void {
    this.cohorts.begin(owner);
  }
  finish(owner: AppearanceOwner): void {
    this.cohorts.finish(owner, (old, parts) => {
      // Allocation failure leaves every split batch live and pickable.
      const replacement = this.create(parts, []);
      for (const bucket of old) {
        this.access.buckets.delete(bucket.key);
        this.access.changed(bucket.key);
      }
      this.attach(replacement, parts);
      this.access.refresh();
      for (const bucket of old)
        if (bucket.batchedMesh) this.dispose(bucket.batchedMesh);
      return replacement.bucket;
    });
  }
  forget(expressId?: number): void {
    this.cohorts.forget(expressId);
  }
  private dispose(batch: BatchedMesh): void {
    try {
      this.access.release(batch);
    } catch (error) {
      console.warn('[Appearance] flat resource disposal failed', error);
    }
  }
  release(resource: FlatAppearanceResource): void {
    if (resource.bucket.batchedMesh) this.dispose(resource.bucket.batchedMesh);
  }
}
