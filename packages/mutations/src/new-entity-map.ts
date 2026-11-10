/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { NewEntity } from './types.js';
import { observeEntityAttributes, withoutEntityExposure } from './entity-read-barrier.js';
import { restoreEntityOrder } from './restore-entity-order.js';

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
  declare private positions?: Map<number, { position: number; previous: number | null; next: number | null }>;
  declare private tailId?: number;
  declare private nextPosition?: number;
  declare private byReference?: Map<number, Set<number>>;
  declare private referencesById?: Map<number, Set<number>>;
  declare private byType?: Map<string, Map<number, NewEntity>>;
  declare private exposed?: Set<number>;
  declare private callbacks?: WeakMap<NewEntity, () => void>;
  declare private weakSelf?: WeakRef<NewEntityMap>;
  declare private exposureListeners?: Set<(id: number) => void>;

  override set(expressId: number, entity: NewEntity): this {
    this.positions ??= new Map();
    if (!this.positions.has(expressId)) {
      this.positions.set(expressId, { position: this.nextPosition = (this.nextPosition ?? 0) + 1, previous: this.tailId ?? null, next: null });
      if (this.tailId !== undefined) this.positions.get(this.tailId)!.next = expressId;
      this.tailId = expressId;
    }
    this.unindexReferences(expressId);
    const previous = super.get(expressId);
    if (previous && previous.type.toUpperCase() !== entity.type.toUpperCase()) this.unindex(previous);
    super.set(expressId, entity);
    this.byType ??= new Map();
    const key = entity.type.toUpperCase();
    let bucket = this.byType.get(key);
    if (!bucket) this.byType.set(key, (bucket = new Map()));
    bucket.set(expressId, entity);
    const references = new Set<number>(), visited = new Set<unknown[]>(), pending: unknown[] = [withoutEntityExposure(() => entity.attributes)];
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value) && !visited.has(value)) { visited.add(value); for (const child of value) pending.push(child); }
      // Native relationship readers also accept parsed numeric endpoints.
      // Keep coordinates/measures out of these buckets; relationship readers
      // verify the effective endpoint grammar after this conservative lookup.
      else if (key.startsWith('IFCREL') && typeof value === 'number' && Number.isSafeInteger(value) && value > 0) references.add(value);
      else if (typeof value === 'string') {
        const token = value.trim();
        if (/^#[0-9]+$/.test(token)) references.add(Number(token.slice(1)));
      }
    }
    this.referencesById ??= new Map();
    this.byReference ??= new Map();
    if (references.size) this.referencesById.set(expressId, references);
    for (const id of references) {
      let bucket = this.byReference.get(id);
      if (!bucket) this.byReference.set(id, bucket = new Set());
      bucket.add(expressId);
    }
    this.callbacks ??= new WeakMap();
    if (!this.callbacks.has(entity)) {
      const owner = this.weakSelf ??= new WeakRef(this);
      const exposed = () => {
        const map = owner.deref();
        if (!map?.has(expressId)) return;
        (map.exposed ??= new Set()).add(expressId);
        for (const listener of map.exposureListeners ?? []) listener(expressId);
      };
      this.callbacks.set(entity, exposed);
      observeEntityAttributes(entity, exposed);
    }
    return this;
  }

  override delete(expressId: number): boolean {
    const position = this.positions?.get(expressId);
    if (position) {
      if (position.previous !== null) this.positions!.get(position.previous)!.next = position.next;
      if (position.next !== null) this.positions!.get(position.next)!.previous = position.previous;
      else this.tailId = position.previous ?? undefined;
    }
    this.positions?.delete(expressId);
    this.exposed?.delete(expressId);
    this.unindexReferences(expressId);
    const previous = super.get(expressId);
    if (previous) this.unindex(previous);
    return super.delete(expressId);
  }

  override clear(): void {
    this.positions?.clear();
    this.tailId = undefined;
    this.byType?.clear();
    this.byReference?.clear();
    this.referencesById?.clear();
    this.exposed?.clear();
    super.clear();
  }

  /**
   * `structuredClone` and the cooperative clone copy any `Map` as a plain
   * `Map`, dropping the index. Snapshots restore through this.
   */
  static from(entities: ReadonlyMap<number, NewEntity>): NewEntityMap {
    return entities instanceof NewEntityMap ? entities : new NewEntityMap(entities);
  }

  /** Read-only access for borrowers. A transaction draft overrides these to
   * read unmodified rows from its base instead of copying them privately. */
  peek(id: number): NewEntity | undefined { return super.get(id); }
  peekValues(): IterableIterator<NewEntity> { return super.values(); }
  peekOfType(type: string): IterableIterator<NewEntity> { return this.ofType(type); }
  peekReferencing(id: number): IterableIterator<NewEntity> { return this.referencing(id); }

  /** Created entities authored as `type` (case-insensitive), in creation order. */
  ofType(type: string): IterableIterator<NewEntity> {
    return (this.byType?.get(type.toUpperCase()) ?? new Map<number, NewEntity>()).values();
  }

  /** Insertion order for sparse inverse capture; new keys sort after old keys. */
  positionOf(id: number): number { return this.positions?.get(id)?.position ?? Infinity; }
  successorOf(id: number): number | null { return this.positions?.get(id)?.next ?? null; }

  /** Undo may restore a forgotten record before survivors. Only that explicit
   * operation rebuilds ordering; ordinary authoring remains incremental. */
  restoreBefore(before: ReadonlyMap<number, number | null>): void {
    if (before.size) this.restoreOrder(restoreEntityOrder(this.keys(), before));
  }
  restoreOrder(ids: readonly number[]): void {
    const types = new Map<number, string>();
    for (const [type, bucket] of this.byType ?? []) for (const id of bucket.keys()) types.set(id, type);
    const byType = new Map<string, Map<number, NewEntity>>(), byReference = new Map<number, Set<number>>();
    const positions: NonNullable<typeof this.positions> = new Map(), rows: Array<[number, NewEntity]> = [];
    for (const [i, id] of ids.entries()) {
      const row = this.get(id), type = types.get(id);
      if (!row || type === undefined) throw new Error('Created entity order changed before undo');
      rows.push([id, row]);
      positions.set(id, { position: i + 1, previous: ids[i - 1] ?? null, next: ids[i + 1] ?? null });
      let bucket = byType.get(type);
      if (!bucket) byType.set(type, bucket = new Map());
      bucket.set(id, row);
      for (const target of this.referencesById?.get(id) ?? []) {
        let references = byReference.get(target);
        if (!references) byReference.set(target, references = new Set());
        references.add(id);
      }
    }
    // Prepare metadata before publication; never reparse unrelated attributes.
    super.clear();
    for (const [id, row] of rows) super.set(id, row);
    this.positions = positions; this.tailId = ids.at(-1); this.nextPosition = ids.length;
    this.byType = byType; this.byReference = byReference;
  }

  referencesId(entityId: number, targetId: number): boolean { return this.referencesById?.get(entityId)?.has(targetId) ?? false; }

  /** Mutable aliases require rechecking only the rows whose arrays escaped. */
  refreshReferences(): void {
    withoutEntityExposure(() => {
      for (const id of this.exposed ?? []) { const row = super.get(id); if (row) this.set(id, row); }
    });
  }

  /** Observe existing mutable aliases and arrays exposed during a transaction. */
  watchAttributeExposure(listener: (id: number) => void): () => void {
    (this.exposureListeners ??= new Set()).add(listener);
    try { for (const id of this.exposed ?? []) listener(id); }
    catch (error) { this.exposureListeners.delete(listener); throw error; }
    return () => { this.exposureListeners?.delete(listener); };
  }

  /** Authored reference candidates; effective readers apply queued slot edits. */
  *referencing(id: number): IterableIterator<NewEntity> {
    this.refreshReferences();
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
