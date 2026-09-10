/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { AppearanceOwner } from './appearance-preview.js';

function sameNumbers(a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

/** Companion transitions change presence only, never geometry or appearance. */
export function sameCompanionParts(a: readonly MeshData[], b: readonly MeshData[]): boolean {
  return a.length === b.length && a.every((part, index) => {
    const other = b[index];
    return part.expressId === other.expressId && (part.modelIndex ?? 0) === (other.modelIndex ?? 0)
      && part.geometryItemId === other.geometryItemId && !part.entityIds && !other.entityIds
      && (['positions', 'normals', 'indices', 'localToWorld', 'shadingColor'] as const).every(key => {
        return sameNumbers(part[key], other[key]);
      })
      && sameNumbers(part.origin ?? [0, 0, 0], other.origin ?? [0, 0, 0])
      && part.color.every((value, axis) => value === other.color[axis])
      && part.texture === other.texture
      && part.textureRef === other.textureRef && part.textureBitmap === other.textureBitmap && part.uvs === other.uvs;
  });
}
function snapshot(part: MeshData): MeshData {
  return Object.freeze({ ...part, positions: part.positions.slice(), normals: part.normals.slice(), indices: part.indices.slice(),
    color: [...part.color] as MeshData['color'],
    ...(part.shadingColor ? { shadingColor: [...part.shadingColor] as NonNullable<MeshData['shadingColor']> } : {}),
    ...(part.origin ? { origin: [...part.origin] as NonNullable<MeshData['origin']> } : {}),
    ...(part.localToWorld ? { localToWorld: [...part.localToWorld] as NonNullable<MeshData['localToWorld']> } : {}) });
}
interface CompanionRecord {
  owner: AppearanceOwner;
  originals: readonly MeshData[];
  sources: readonly MeshData[];
  absent: boolean;
  hidden: boolean;
  drafts: number;
  history: number;
}

/** Tombstones prove that missing geometry was removed by this transaction.
 * They do not authorize restoring an arbitrary unloaded or replaced owner. */
export class AppearanceCompanions {
  private records = new Map<number, CompanionRecord>();
  get(owner: AppearanceOwner): CompanionRecord | undefined {
    const record = this.records.get(owner.expressId);
    if (record && record.owner.modelIndex !== owner.modelIndex) throw new Error('Companion model ownership changed.');
    return record;
  }
  capture(owner: AppearanceOwner, expected: readonly MeshData[], current: readonly MeshData[] | undefined,
    source: (part: MeshData) => MeshData, hidden = false): CompanionRecord {
    let record = this.get(owner);
    let vertices = 0, corners = 0;
    if (expected.length > 10_000) throw new Error('Companion geometry exceeds its snapshot budget.');
    for (const part of expected) {
      vertices += part.positions.length / 3; corners += part.indices.length;
      if (!Number.isSafeInteger(vertices) || vertices > 2_000_000 || corners > 1_500_000
        || part.positions.length / 3 > 1_000_000) throw new Error('Companion geometry exceeds its snapshot budget.');
    }
    if (!expected.length || expected.some(part => part.expressId !== owner.expressId
      || (part.modelIndex ?? 0) !== owner.modelIndex || !part.geometryItemId || part.entityIds
      || !part.positions.length || !part.indices.length || part.texture || part.textureRef || part.textureBitmap || part.uvs)) {
      throw new Error('Companion removal requires original untextured owner geometry.');
    }
    if (record) {
      if (!sameCompanionParts(expected, record.originals)
        || (record.absent ? !!current?.length : current?.length ? !sameCompanionParts(current, record.originals) : !record.hidden)) {
        throw new Error('Companion geometry changed since preparation.');
      }
    } else {
      if ((!current?.length && !hidden) || (current?.length && !sameCompanionParts(current, expected))) throw new Error('Companion original geometry is missing or changed.');
      const resident = current?.length ? current : expected;
      const originals = resident.map(snapshot);
      const sources = resident.map((part, index) => {
        const raw = source(part);
        return raw === part ? originals[index] : snapshot(raw);
      });
      record = { owner: Object.freeze({ ...owner }), originals: Object.freeze(originals),
        sources: Object.freeze(sources), absent: false, hidden, drafts: 0, history: 0 };
      this.records.set(owner.expressId, record);
    }
    record.hidden = hidden && !current?.length;
    record.drafts++;
    return record;
  }
  validate(owner: AppearanceOwner, current: readonly MeshData[] | undefined): void {
    const record = this.get(owner);
    if (record && (record.absent ? !!current?.length : current?.length ? !sameCompanionParts(current, record.originals) : !record.hidden)) {
      throw new Error('Companion geometry changed during the appearance transaction.');
    }
  }
  install(owner: AppearanceOwner, parts: readonly MeshData[]): void {
    const record = this.get(owner);
    if (!record) return;
    if (parts.length && !sameCompanionParts(parts, record.originals)) throw new Error('Companion restoration changed its original geometry.');
    record.absent = !parts.length;
  }
  finish(owner: AppearanceOwner, expected?: CompanionRecord): void {
    const record = this.get(owner);
    if (!record || (expected && record !== expected)) return;
    record.drafts = Math.max(0, record.drafts - 1);
    this.collect(record);
  }
  retain(owner: AppearanceOwner): () => void {
    const record = this.get(owner);
    if (!record) return () => {};
    record.history++;
    let released = false;
    return () => { if (!released) { released = true; record.history--; this.collect(record); } };
  }
  private collect(record: CompanionRecord): void {
    if (!record.drafts && !record.history && this.records.get(record.owner.expressId) === record) this.records.delete(record.owner.expressId);
  }
  retained(geometry: readonly MeshData[], models: ReadonlySet<number>): Set<number> {
    const byOwner = new Map<number, MeshData[]>();
    for (const part of geometry) { const parts = byOwner.get(part.expressId) ?? []; parts.push(part); byOwner.set(part.expressId, parts); }
    return new Set([...this.records].filter(([id, record]) => record.history > 0 && models.has(record.owner.modelIndex)
      && (record.absent ? !byOwner.get(id)?.length : sameCompanionParts(byOwner.get(id) ?? [], record.sources))).map(([id]) => id));
  }
  forget(id?: number): void { if (id === undefined) this.records.clear(); else this.records.delete(id); }
  forgetExcept(retained: ReadonlySet<number>): void { for (const id of this.records.keys()) if (!retained.has(id)) this.records.delete(id); }
}
