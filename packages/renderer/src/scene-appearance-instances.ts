/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { AppearanceOwner } from './appearance-preview.js';
import type { InstanceLease } from './scene-instance-suppression.js';
import { equivalentAppearanceGeometry } from './appearance-uvs.js';

export interface InstanceAppearanceRecord {
  owner: AppearanceOwner;
  originals: readonly MeshData[];
  lease: InstanceLease;
  active: boolean;
  drafts: number;
  history: number;
}
export interface InstanceAppearanceAccess {
  has(id: number): boolean;
  capacity(id: number): { parts: number; vertices: number; corners: number };
  pieces(id: number): readonly MeshData[] | undefined;
  acquire(owner: AppearanceOwner): InstanceLease;
  remove(id: number): void;
}

/** Native provenance is supplied separately. This only checks the live rendered
 * occurrence still occupies the expected frame within f32 transform rounding. */
function sameRenderedOccurrence(canonical: MeshData, rendered: MeshData): boolean {
  if (canonical.expressId !== rendered.expressId || canonical.geometryItemId !== rendered.geometryItemId
    || canonical.indices.length !== rendered.indices.length) return false;
  for (let corner = 0; corner < canonical.indices.length; corner++) {
    const a = canonical.indices[corner] * 3, b = rendered.indices[corner] * 3;
    for (let axis = 0; axis < 3; axis++) {
      const x = canonical.positions[a + axis] + (canonical.origin?.[axis] ?? 0);
      const y = rendered.positions[b + axis] + (rendered.origin?.[axis] ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y)
        || Math.abs(x - y) > 8 * 2 ** -23 * Math.max(1, Math.abs(x), Math.abs(y))) return false;
    }
  }
  return true;
}

/** One record per occurrence, shared by every command that can still undo it. */
export class AppearanceInstances {
  private records = new Map<number, InstanceAppearanceRecord>();
  constructor(private readonly access: InstanceAppearanceAccess) {}
  retainedOwners(keep: (record: InstanceAppearanceRecord) => boolean): Set<number> {
    return new Set([...this.records].filter(([, record]) => record.history > 0 && record.lease.valid && keep(record)).map(([id]) => id));
  }
  forgetExcept(retained: ReadonlySet<number>): void {
    for (const id of this.records.keys()) if (!retained.has(id)) this.forget(id);
  }
  discardedFlatOwners(retained: ReadonlySet<number>): number[] {
    return [...this.records].filter(([id, record]) => !retained.has(id) && !record.active && record.lease.valid).map(([id]) => id);
  }
  get(owner: AppearanceOwner): InstanceAppearanceRecord | undefined {
    const record = this.records.get(owner.expressId);
    if (!record) return undefined;
    if (record.owner.modelIndex !== owner.modelIndex || !record.lease.valid) throw new Error('The original occurrence is no longer available.');
    return record;
  }
  capture(owner: AppearanceOwner, originals?: readonly MeshData[]): InstanceAppearanceRecord | undefined {
    let record = this.get(owner);
    if (!record && this.access.has(owner.expressId)) {
      const capacity = this.access.capacity(owner.expressId);
      if (!originals || originals.length !== 1 || capacity.parts !== 1
        || capacity.vertices > 1_000_000 || capacity.corners > 1_500_000) {
        throw new Error('Instance appearance requires one bounded canonical native source mesh.');
      }
      const source = originals[0];
      if (source.expressId !== owner.expressId || source.modelIndex !== owner.modelIndex
        || source.appearanceSource?.kind !== 'canonical-item' || source.appearanceSource.indices !== source.indices
        || source.entityIds || source.localToWorld || source.texture || source.textureRef || source.uvs) {
        throw new Error('Invalid native occurrence source ownership or provenance.');
      }
      const lease = this.access.acquire(owner);
      try {
        const rendered = this.access.pieces(owner.expressId);
        if (rendered?.length !== 1 || !sameRenderedOccurrence(source, rendered[0])) {
          throw new Error('The rendered occurrence moved or changed since native preparation.');
        }
        record = { owner: Object.freeze({ ...owner }), originals: Object.freeze(originals.map(part => Object.freeze({ ...part }))),
          lease, active: true, drafts: 0, history: 0 };
        this.records.set(owner.expressId, record);
      } catch (error) { lease.release(); throw error; }
    } else if (originals && !record) throw new Error('The target is no longer a GPU instance.');
    if (record) record.drafts++;
    return record;
  }
  isOriginal(record: InstanceAppearanceRecord, parts: readonly MeshData[]): boolean {
    return parts.length === record.originals.length && parts.every((part, index) => {
      const original = record.originals[index];
      return part.geometryItemId === original.geometryItemId && !part.texture && !part.textureRef && !part.uvs
        && part.color.every((value, axis) => value === original.color[axis])
        && equivalentAppearanceGeometry(part, original);
    });
  }
  activate(record: InstanceAppearanceRecord, original: boolean): void {
    this.get(record.owner);
    record.lease.setSuppressed(!original);
    record.active = original;
  }
  finish(owner: AppearanceOwner, expected?: InstanceAppearanceRecord): void {
    const record = this.records.get(owner.expressId);
    if (!record || record.owner.modelIndex !== owner.modelIndex || (expected && record !== expected)) return;
    record.drafts = Math.max(0, record.drafts - 1);
    this.collect(record);
  }
  retain(owner: AppearanceOwner): () => void {
    const record = this.get(owner);
    if (!record) return () => {};
    record.history++;
    let released = false;
    return () => {
      if (released) return;
      record.history--;
      try { this.collect(record); } catch (error) { record.history++; throw error; }
      released = true;
    };
  }
  private collect(record: InstanceAppearanceRecord): void {
    if (record.drafts || record.history || this.records.get(record.owner.expressId) !== record) return;
    if (!record.lease.valid) { this.records.delete(record.owner.expressId); return; }
    if (record.active) record.lease.release();
    else this.access.remove(record.owner.expressId);
    this.records.delete(record.owner.expressId);
  }
  forget(id?: number): void {
    for (const [key, record] of this.records) {
      if (id !== undefined && id !== key) continue;
      record.lease.release();
      this.records.delete(key);
    }
  }
}
