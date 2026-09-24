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
  // Lazy: `Map`'s constructor calls `set` before subclass fields initialise.
  private byType?: Map<string, Map<number, NewEntity>>;

  override set(expressId: number, entity: NewEntity): this {
    const previous = super.get(expressId);
    if (previous && previous.type.toUpperCase() !== entity.type.toUpperCase()) this.unindex(previous);
    super.set(expressId, entity);
    this.byType ??= new Map();
    const key = entity.type.toUpperCase();
    let bucket = this.byType.get(key);
    if (!bucket) this.byType.set(key, (bucket = new Map()));
    bucket.set(expressId, entity);
    return this;
  }

  override delete(expressId: number): boolean {
    const previous = super.get(expressId);
    if (previous) this.unindex(previous);
    return super.delete(expressId);
  }

  override clear(): void {
    this.byType?.clear();
    super.clear();
  }

  /** Created entities authored as `type` (case-insensitive), in creation order. */
  ofType(type: string): IterableIterator<NewEntity> {
    return (this.byType?.get(type.toUpperCase()) ?? new Map<number, NewEntity>()).values();
  }

  private unindex(entity: NewEntity): void {
    const key = entity.type.toUpperCase();
    const bucket = this.byType?.get(key);
    bucket?.delete(entity.expressId);
    if (bucket?.size === 0) this.byType?.delete(key);
  }
}
