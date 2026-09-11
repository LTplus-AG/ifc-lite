/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { AppearanceOwner } from './appearance-preview.js';
import type { AppearanceBucket } from './scene-appearance-buckets.js';
import { BATCH_CONSTANTS } from './constants.js';

interface Cohort {
  id: number;
  live: Set<AppearanceBucket>;
  slots: Set<string>;
  active: Set<string>;
  vertexLimit: number;
  indexLimit: number;
}
const ownerKey = (owner: AppearanceOwner) =>
  `${owner.modelIndex}:${owner.expressId}:`;
const meshOwner = (part: MeshData) => ({
  expressId: part.expressId,
  modelIndex: part.modelIndex ?? 0,
});
const vertexBytes = (part: MeshData) =>
  (part.positions.length / 3) * BATCH_CONSTANTS.BYTES_PER_VERTEX;

/** Metadata only: original GPU resources and source arrays are never retained.
 * Only buckets descended from the same original batch can be rejoined. */
export class AppearanceBatchCohorts {
  private sequence = 0;
  private slots = new Map<string, Cohort>();
  private buckets = new WeakMap<AppearanceBucket, Cohort>();
  private cohorts = new Set<Cohort>();
  constructor(
    private readonly parts: (id: number) => readonly MeshData[] | undefined,
  ) {}

  private slot(part: MeshData): string {
    const index = this.parts(part.expressId)?.indexOf(part) ?? -1;
    if (index < 0)
      throw new Error('Appearance batch lost its source part identity');
    return ownerKey(meshOwner(part)) + index;
  }
  register(bucket: AppearanceBucket): void {
    if (this.buckets.has(bucket)) return;
    const slots = bucket.meshData.map((part) => this.slot(part));
    const cohort: Cohort = {
      id: ++this.sequence,
      live: new Set([bucket]),
      slots: new Set(slots),
      active: new Set(),
      vertexLimit: bucket.meshData.reduce((n, p) => n + vertexBytes(p), 0),
      indexLimit: bucket.meshData.reduce((n, p) => n + p.indices.byteLength, 0),
    };
    for (const slot of slots) this.slots.set(slot, cohort);
    this.buckets.set(bucket, cohort);
    this.cohorts.add(cohort);
  }
  inherit(from: AppearanceBucket, to: AppearanceBucket): void {
    const cohort = this.buckets.get(from);
    if (cohort) this.buckets.set(to, cohort);
  }
  group(part: MeshData, index: number): Cohort | undefined {
    return this.slots.get(ownerKey(meshOwner(part)) + index);
  }
  assign(bucket: AppearanceBucket, cohort: Cohort | undefined): void {
    if (cohort) this.buckets.set(bucket, cohort);
  }
  attach(bucket: AppearanceBucket): void {
    this.buckets.get(bucket)?.live.add(bucket);
  }
  detach(bucket: AppearanceBucket): void {
    this.buckets.get(bucket)?.live.delete(bucket);
  }
  begin(owner: AppearanceOwner): void {
    const prefix = ownerKey(owner);
    for (const [slot, cohort] of this.slots)
      if (slot.startsWith(prefix)) cohort.active.add(prefix);
  }
  finish(
    owner: AppearanceOwner,
    rebuild: (old: AppearanceBucket[], parts: MeshData[]) => AppearanceBucket,
  ): void {
    const prefix = ownerKey(owner);
    const affected = new Set<Cohort>();
    for (const [slot, cohort] of this.slots)
      if (slot.startsWith(prefix)) {
        cohort.active.delete(prefix);
        affected.add(cohort);
      }
    for (const cohort of affected) {
      if (cohort.active.size || cohort.live.size < 2) continue;
      // Restore within original allocation bounds; changed colors remain distinct.
      const colors = new Map<string, AppearanceBucket[]>();
      for (const bucket of cohort.live) {
        const key = bucket.meshData[0].color.join(',');
        const group = colors.get(key) ?? [];
        group.push(bucket);
        colors.set(key, group);
      }
      for (const group of colors.values()) {
        const parts = group.flatMap((bucket) => bucket.meshData);
        if (
          group.length < 2 ||
          parts.reduce((n, p) => n + vertexBytes(p), 0) > cohort.vertexLimit ||
          parts.reduce((n, p) => n + p.indices.byteLength, 0) >
            cohort.indexLimit
        )
          continue;
        const replacement = rebuild(group, parts);
        for (const old of group) cohort.live.delete(old);
        this.buckets.set(replacement, cohort);
        cohort.live.add(replacement);
      }
    }
  }
  forget(expressId?: number): void {
    if (expressId === undefined) {
      this.slots.clear();
      this.cohorts.clear();
      this.buckets = new WeakMap();
      return;
    }
    for (const [slot, cohort] of this.slots) {
      if (Number(slot.split(':')[1]) !== expressId) continue;
      this.slots.delete(slot);
      cohort.slots.delete(slot);
      cohort.active.delete(slot.slice(0, slot.lastIndexOf(':') + 1));
    }
    for (const cohort of this.cohorts) {
      for (const bucket of cohort.live) {
        if (bucket.meshData.some((part) => part.expressId === expressId)) {
          this.buckets.delete(bucket);
          cohort.live.delete(bucket);
        }
      }
      if (!cohort.slots.size) this.cohorts.delete(cohort);
    }
  }
}
