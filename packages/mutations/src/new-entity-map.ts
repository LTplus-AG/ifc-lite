/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NewEntity } from './types.js';

/**
 * The overlay's created entities, still an ordinary `Map` by express id, plus
 * a per-class index kept in step with every write (#5413).
 *
 * Effective enumeration asks "the created entities of class X" once per query,
 * and the in-store builders query per element they add. Answering by scanning
 * every created entity made a bulk add O(n²); the index makes it O(matches).
 * Each class bucket preserves creation order, like the map itself. The one
 * divergence, re-setting an existing id under a DIFFERENT class, moves it to
 * the end of its new bucket; no writer does that.
 */
export class NewEntityMap extends Map<number, NewEntity> {
  // Lazy, and `declare`d so no runtime field is emitted: `Map`'s constructor
  // calls `set` before subclass fields initialise, and an emitted field would
  // then reset whatever `super(entries)` had indexed.
  declare private byReference?: Map<number, Set<number>>;
  declare private referencesById?: Map<number, Set<number>>;
  declare private byType?: Map<string, Map<number, NewEntity>>;

  override set(expressId: number, entity: NewEntity): this {
    this.unindexReferences(expressId);
    const previous = super.get(expressId);
    if (previous && previous.type.toUpperCase() !== entity.type.toUpperCase()) this.unindex(previous);
    super.set(expressId, entity);
    this.byType ??= new Map();
    const key = entity.type.toUpperCase();
    let bucket = this.byType.get(key);
    if (!bucket) this.byType.set(key, (bucket = new Map()));
    bucket.set(expressId, entity);
    const references = new Set<number>(), visited = new Set<unknown[]>(), pending: unknown[] = [entity.attributes];
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value) && !visited.has(value)) { visited.add(value); for (const child of value) pending.push(child); }
      else if (typeof value === 'string' && /^#[0-9]+$/.test(value)) references.add(Number(value.slice(1)));
    }
    this.referencesById ??= new Map();
    this.byReference ??= new Map();
    if (references.size) this.referencesById.set(expressId, references);
    for (const id of references) {
      let bucket = this.byReference.get(id);
      if (!bucket) this.byReference.set(id, bucket = new Set());
      bucket.add(expressId);
    }
    return this;
  }

  override delete(expressId: number): boolean {
    this.unindexReferences(expressId);
    const previous = super.get(expressId);
    if (previous) this.unindex(previous);
    return super.delete(expressId);
  }

  override clear(): void {
    this.byType?.clear();
    this.byReference?.clear();
    this.referencesById?.clear();
    super.clear();
  }

  /**
   * `structuredClone` and the cooperative clone copy any `Map` as a plain
   * `Map`, dropping the index. Snapshots restore through this.
   */
  static from(entities: ReadonlyMap<number, NewEntity>): NewEntityMap {
    return entities instanceof NewEntityMap ? entities : new NewEntityMap(entities);
  }

  /** Created entities authored as `type` (case-insensitive), in creation order. */
  ofType(type: string): IterableIterator<NewEntity> {
    return (this.byType?.get(type.toUpperCase()) ?? new Map<number, NewEntity>()).values();
  }

  /** Authored reference candidates; effective readers apply queued slot edits. */
  *referencing(id: number): IterableIterator<NewEntity> {
    for (const entityId of this.byReference?.get(id) ?? []) {
      const entity = this.get(entityId);
      if (entity) yield entity;
    }
  }

  private unindexReferences(expressId: number): void {
    for (const id of this.referencesById?.get(expressId) ?? []) {
      const bucket = this.byReference?.get(id);
      bucket?.delete(expressId);
      if (bucket?.size === 0) this.byReference?.delete(id);
    }
    this.referencesById?.delete(expressId);
  }

  private unindex(entity: NewEntity): void {
    const key = entity.type.toUpperCase();
    const bucket = this.byType?.get(key);
    bucket?.delete(entity.expressId);
    if (bucket?.size === 0) this.byType?.delete(key);
  }
}
