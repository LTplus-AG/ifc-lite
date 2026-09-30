/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IDS lookups are memoized for speed, not stored as validation state. A large
 * model × attribute-name population must not exhaust a JS Map (#4057).
 * Evicted values can be recomputed from the same accessor without changing
 * validation results. FIFO avoids changing insertion order on every hit. */
export const ACCESSOR_CACHE_LIMIT = 100_000;

export class BoundedCache<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly order: K[] = [];
  private oldest = 0;

  constructor(private readonly limit = ACCESSOR_CACHE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Cache limit must be a positive integer');
  }

  get size(): number { return this.entries.size; }
  get(key: K): V | undefined { return this.entries.get(key); }
  has(key: K): boolean { return this.entries.has(key); }
  keys(): MapIterator<K> { return this.entries.keys(); }

  set(key: K, value: V): this {
    if (!this.entries.has(key)) {
      if (this.order.length < this.limit) {
        this.order.push(key);
      } else {
        // A ring makes eviction constant work even after millions of lookups;
        // restarting a Map iterator would repeatedly scan deleted entries.
        this.entries.delete(this.order[this.oldest]);
        this.order[this.oldest] = key;
        this.oldest = (this.oldest + 1) % this.limit;
      }
    }
    this.entries.set(key, value);
    return this;
  }
}
