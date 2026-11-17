// SPDX-License-Identifier: MPL-2.0
import type { NewEntity } from './types.js';
import { withoutEntityExposure } from './entity-read-barrier.js';

/** Exact scalar reference grammar, including the unresolved bucket. */
export function referenceSlot(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  return typeof value === 'string' && /^#[1-9][0-9]*$/.test(value) ? Number(value.slice(1)) : null;
}

/** Lazily requested projections, maintained by their owning entity map. */
export class ReferenceSlotIndex {
  private readonly projections = new Map<string, { type: string; slot: number; values: Map<number | null, Set<number>>; keys: Map<number, number | null> }>();
  update(row: NewEntity): void {
    this.delete(row.expressId);
    for (const index of this.projections.values()) if (row.type.toUpperCase() === index.type) {
      const key = referenceSlot(withoutEntityExposure(() => row.attributes)[index.slot]);
      index.keys.set(row.expressId, key);
      let bucket = index.values.get(key);
      if (!bucket) index.values.set(key, bucket = new Set());
      bucket.add(row.expressId);
    }
  }
  delete(id: number): void {
    for (const index of this.projections.values()) if (index.keys.has(id)) {
      const key = index.keys.get(id)!;
      const bucket = index.values.get(key)!;
      bucket.delete(id);
      if (!bucket.size) index.values.delete(key);
      index.keys.delete(id);
    }
  }
  clear(): void { for (const p of this.projections.values()) { p.keys.clear(); p.values.clear(); } }
  ids(type: string, slot: number, target: number | null, rows: () => Iterable<NewEntity>): Iterable<number> {
    type = type.toUpperCase();
    const key = `${type}:${slot}`;
    let index = this.projections.get(key);
    if (!index) {
      index = { type, slot, values: new Map(), keys: new Map() };
      this.projections.set(key, index);
      for (const row of rows()) this.update(row);
    }
    return index.values.get(target) ?? [];
  }
}
