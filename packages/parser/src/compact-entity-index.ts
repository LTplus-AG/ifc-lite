/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CompactEntityIndex - Memory-efficient entity index using typed arrays
 *
 * Replaces Map<number, EntityRef> with sorted typed arrays for O(log n) lookup.
 * For 8.4M entities, this saves ~400MB of Map overhead:
 *   - Map: ~56 bytes/entry overhead (key + value + hash table) = ~470MB
 *   - Typed arrays: ~16 bytes/entry (4 Uint32Arrays) = ~134MB
 *
 * Provides the same Map-like interface via get()/has() for drop-in compatibility.
 */

import type { EntityRef } from './types.js';

/**
 * Compact read-only entity index backed by sorted typed arrays.
 * Implements the same interface as Map<number, EntityRef> for lookups.
 */
export class CompactEntityIndex {
  /** Sorted array of expressIds for binary search */
  private readonly expressIds: Uint32Array;
  /** Parallel array: byte offset in source buffer */
  private readonly byteOffsets: Uint32Array;
  /** Parallel array: byte length of entity in source buffer */
  private readonly byteLengths: Uint32Array;
  /** Parallel array: index into typeStrings for the entity type */
  private readonly typeIndices: Uint16Array;
  /** Deduped type strings (typically < 800 unique types) */
  private readonly typeStrings: string[];
  /** Type string → index lookup */
  private readonly typeStringMap: Map<string, number>;
  /** Total number of entries */
  readonly size: number;

  /** LRU cache for recently accessed EntityRefs */
  private lruCache: Map<number, EntityRef>;
  private readonly lruMaxSize: number;

  constructor(
    expressIds: Uint32Array,
    byteOffsets: Uint32Array,
    byteLengths: Uint32Array,
    typeIndices: Uint16Array,
    typeStrings: string[],
    lruMaxSize: number = 1024
  ) {
    this.expressIds = expressIds;
    this.byteOffsets = byteOffsets;
    this.byteLengths = byteLengths;
    this.typeIndices = typeIndices;
    this.typeStrings = typeStrings;
    this.size = expressIds.length;
    this.lruMaxSize = lruMaxSize;
    this.lruCache = new Map();

    // Build type string → index map
    this.typeStringMap = new Map();
    for (let i = 0; i < typeStrings.length; i++) {
      this.typeStringMap.set(typeStrings[i], i);
    }
  }

  /**
   * Binary search for an expressId in the sorted array.
   * Returns the array index or -1 if not found.
   */
  private binarySearch(expressId: number): number {
    const ids = this.expressIds;
    let lo = 0;
    let hi = ids.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const midVal = ids[mid];
      if (midVal === expressId) return mid;
      if (midVal < expressId) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  /**
   * Get EntityRef by expressId (Map-compatible interface).
   * Uses LRU cache to avoid repeated object allocation for hot entities.
   */
  get(expressId: number): EntityRef | undefined {
    // Check LRU cache first
    const cached = this.lruCache.get(expressId);
    if (cached !== undefined) {
      // Refresh recency: delete + re-insert moves to end of insertion order
      this.lruCache.delete(expressId);
      this.lruCache.set(expressId, cached);
      return cached;
    }

    const idx = this.binarySearch(expressId);
    if (idx < 0) return undefined;

    // Construct EntityRef from typed arrays
    const ref: EntityRef = {
      expressId,
      type: this.typeStrings[this.typeIndices[idx]],
      byteOffset: this.byteOffsets[idx],
      byteLength: this.byteLengths[idx],
      lineNumber: 0, // Not stored compactly; rarely needed
    };

    // Add to LRU cache
    this.lruCache.set(expressId, ref);
    if (this.lruCache.size > this.lruMaxSize) {
      // Delete oldest entry (first key in insertion order)
      const firstKey = this.lruCache.keys().next().value;
      if (firstKey !== undefined) {
        this.lruCache.delete(firstKey);
      }
    }

    return ref;
  }

  /**
   * Check if an expressId exists (Map-compatible interface).
   */
  has(expressId: number): boolean {
    return this.binarySearch(expressId) >= 0;
  }

  /**
   * Get the type string for an expressId without full EntityRef allocation.
   */
  getType(expressId: number): string | undefined {
    const idx = this.binarySearch(expressId);
    if (idx < 0) return undefined;
    return this.typeStrings[this.typeIndices[idx]];
  }

  /**
   * Get byte offset and length for an expressId without full EntityRef allocation.
   */
  getByteRange(expressId: number): { byteOffset: number; byteLength: number } | undefined {
    const idx = this.binarySearch(expressId);
    if (idx < 0) return undefined;
    return {
      byteOffset: this.byteOffsets[idx],
      byteLength: this.byteLengths[idx],
    };
  }

  /**
   * Iterate over all entries (Map-compatible interface).
   * Yields [expressId, EntityRef] pairs.
   */
  *[Symbol.iterator](): IterableIterator<[number, EntityRef]> {
    for (let i = 0; i < this.size; i++) {
      const expressId = this.expressIds[i];
      const ref: EntityRef = {
        expressId,
        type: this.typeStrings[this.typeIndices[i]],
        byteOffset: this.byteOffsets[i],
        byteLength: this.byteLengths[i],
        lineNumber: 0,
      };
      yield [expressId, ref];
    }
  }

  /**
   * Iterate over all expressIds (Map.keys()-compatible).
   */
  *keys(): IterableIterator<number> {
    for (let i = 0; i < this.size; i++) {
      yield this.expressIds[i];
    }
  }

  /**
   * Iterate over all EntityRefs (Map.values()-compatible).
   */
  *values(): IterableIterator<EntityRef> {
    for (let i = 0; i < this.size; i++) {
      yield {
        expressId: this.expressIds[i],
        type: this.typeStrings[this.typeIndices[i]],
        byteOffset: this.byteOffsets[i],
        byteLength: this.byteLengths[i],
        lineNumber: 0,
      };
    }
  }

  /**
   * Iterate over all entries (Map.entries()-compatible).
   */
  entries(): IterableIterator<[number, EntityRef]> {
    return this[Symbol.iterator]();
  }

  /**
   * forEach (Map-compatible interface).
   */
  forEach(callback: (value: EntityRef, key: number) => void): void {
    for (let i = 0; i < this.size; i++) {
      const expressId = this.expressIds[i];
      const ref: EntityRef = {
        expressId,
        type: this.typeStrings[this.typeIndices[i]],
        byteOffset: this.byteOffsets[i],
        byteLength: this.byteLengths[i],
        lineNumber: 0,
      };
      callback(ref, expressId);
    }
  }

  /**
   * Clear the LRU cache (e.g., on model unload).
   */
  clearCache(): void {
    this.lruCache.clear();
  }

  /**
   * Estimate memory usage in bytes.
   */
  estimateMemoryBytes(): number {
    return (
      this.expressIds.byteLength +
      this.byteOffsets.byteLength +
      this.byteLengths.byteLength +
      this.typeIndices.byteLength +
      this.typeStrings.reduce((sum, s) => sum + s.length * 2, 0)
    );
  }
}

function yieldToEventLoop(): Promise<void> {
  const maybeScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof maybeScheduler?.yield === 'function') {
    return maybeScheduler.yield();
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
}

/**
 * Incrementally build a CompactEntityIndex without a temporary array of objects.
 *
 * For 4.4M entities the intermediate EntityRef[] costs ~350MB (80 bytes/object).
 * This builder fills typed arrays directly during the scan, eliminating that spike.
 *
 * Usage:
 *   const builder = new CompactEntityIndexBuilder(estimatedCount);
 *   for (const ref of tokenizer.scanEntitiesFast()) {
 *     builder.add(ref.expressId, ref.type, ref.offset, ref.length);
 *   }
 *   const index = builder.build();
 */
export class CompactEntityIndexBuilder {
  private expressIds: Uint32Array;
  private byteOffsets: Uint32Array;
  private byteLengths: Uint32Array;
  private typeIndices: Uint16Array;
  private typeStringMap: Map<string, number> = new Map();
  private typeStrings: string[] = [];
  private count = 0;
  private capacity: number;

  constructor(estimatedCount: number) {
    this.capacity = estimatedCount;
    this.expressIds = new Uint32Array(estimatedCount);
    this.byteOffsets = new Uint32Array(estimatedCount);
    this.byteLengths = new Uint32Array(estimatedCount);
    this.typeIndices = new Uint16Array(estimatedCount);
  }

  add(expressId: number, type: string, byteOffset: number, byteLength: number): void {
    if (this.count >= this.capacity) {
      this.grow();
    }
    const i = this.count++;

    this.expressIds[i] = expressId;
    this.byteOffsets[i] = byteOffset;
    this.byteLengths[i] = byteLength;

    let typeIdx = this.typeStringMap.get(type);
    if (typeIdx === undefined) {
      typeIdx = this.typeStrings.length;
      this.typeStrings.push(type);
      this.typeStringMap.set(type, typeIdx);
    }
    this.typeIndices[i] = typeIdx;
  }

  private grow(): void {
    const newCap = Math.max(this.capacity * 2, 1024);
    const copyU32 = (old: Uint32Array) => {
      const a = new Uint32Array(newCap);
      a.set(old);
      return a;
    };
    const copyU16 = (old: Uint16Array) => {
      const a = new Uint16Array(newCap);
      a.set(old);
      return a;
    };
    this.expressIds = copyU32(this.expressIds);
    this.byteOffsets = copyU32(this.byteOffsets);
    this.byteLengths = copyU32(this.byteLengths);
    this.typeIndices = copyU16(this.typeIndices);
    this.capacity = newCap;
  }

  build(lruMaxSize?: number): CompactEntityIndex {
    const n = this.count;

    // Check if already sorted (true for 99%+ of IFC files)
    let isSorted = true;
    for (let i = 1; i < n; i++) {
      if (this.expressIds[i] < this.expressIds[i - 1]) {
        isSorted = false;
        break;
      }
    }

    if (!isSorted) {
      // Build index array, sort it, then reorder all parallel arrays
      const indices = new Uint32Array(n);
      for (let i = 0; i < n; i++) indices[i] = i;
      indices.sort((a, b) => this.expressIds[a] - this.expressIds[b]);

      const sortedIds = new Uint32Array(n);
      const sortedOffsets = new Uint32Array(n);
      const sortedLens = new Uint32Array(n);
      const sortedTypes = new Uint16Array(n);
      for (let i = 0; i < n; i++) {
        const j = indices[i];
        sortedIds[i] = this.expressIds[j];
        sortedOffsets[i] = this.byteOffsets[j];
        sortedLens[i] = this.byteLengths[j];
        sortedTypes[i] = this.typeIndices[j];
      }
      return new CompactEntityIndex(sortedIds, sortedOffsets, sortedLens, sortedTypes, this.typeStrings, lruMaxSize);
    }

    // Use slice() to create right-sized copies, allowing the builder's
    // potentially over-allocated buffers to be GC'd.
    return new CompactEntityIndex(
      this.expressIds.slice(0, n),
      this.byteOffsets.slice(0, n),
      this.byteLengths.slice(0, n),
      this.typeIndices.slice(0, n),
      this.typeStrings,
      lruMaxSize
    );
  }
}

/**
 * Build a CompactEntityIndex from an array of EntityRefs.
 * Sorts by expressId and deduplicates type strings.
 */
export function buildCompactEntityIndex(
  entityRefs: EntityRef[],
  lruMaxSize?: number
): CompactEntityIndex {
  const count = entityRefs.length;

  // Check if already sorted by expressId (true for 99%+ of IFC files since
  // entities appear sequentially as #1, #2, #3...). This avoids a ~3-5s
  // .slice() + .sort() on 14M objects.
  let isSorted = true;
  for (let i = 1; i < count; i++) {
    if (entityRefs[i].expressId < entityRefs[i - 1].expressId) {
      isSorted = false;
      break;
    }
  }

  const sorted = isSorted ? entityRefs : entityRefs.slice().sort((a, b) => a.expressId - b.expressId);

  // Deduplicate type strings
  const typeStringMap = new Map<string, number>();
  const typeStrings: string[] = [];

  // Allocate typed arrays
  const expressIds = new Uint32Array(count);
  const byteOffsets = new Uint32Array(count);
  const byteLengths = new Uint32Array(count);
  const typeIndices = new Uint16Array(count);

  for (let i = 0; i < count; i++) {
    const ref = sorted[i];
    expressIds[i] = ref.expressId;
    byteOffsets[i] = ref.byteOffset;
    byteLengths[i] = ref.byteLength;

    let typeIdx = typeStringMap.get(ref.type);
    if (typeIdx === undefined) {
      typeIdx = typeStrings.length;
      typeStrings.push(ref.type);
      typeStringMap.set(ref.type, typeIdx);
    }
    typeIndices[i] = typeIdx;
  }

  return new CompactEntityIndex(
    expressIds,
    byteOffsets,
    byteLengths,
    typeIndices,
    typeStrings,
    lruMaxSize
  );
}

export async function buildCompactEntityIndexAsync(
  entityRefs: EntityRef[],
  lruMaxSize?: number,
  chunkSize: number = 8192,
  // Phase 3c: 8ms was the previous default but caused the parser tail
  // to balloon under stream-time contention. Each yield under load
  // costs 10-50ms wall-clock (event-loop backlogged with geometry
  // batches), and 1700 yields × 4ms avg = 6.5s of pure overhead
  // (measured: compact entity index 196ms uncontended → 6700ms
  // contended). 50ms budget cuts yields to ~270 → ~1s overhead, saving
  // ~5s on the parser path. Trade-off: parser worker briefly
  // unresponsive between yields, but it's a worker thread so this only
  // affects message processing back to main, which is buffered anyway.
  budgetMs: number = 50,
): Promise<CompactEntityIndex> {
  const count = entityRefs.length;
  let chunkStart = performance.now();

  let isSorted = true;
  for (let i = 1; i < count; i++) {
    if ((i % chunkSize) === 0 && performance.now() - chunkStart >= budgetMs) {
      await yieldToEventLoop();
      chunkStart = performance.now();
    }
    if (entityRefs[i].expressId < entityRefs[i - 1].expressId) {
      isSorted = false;
      break;
    }
  }

  const sorted = isSorted ? entityRefs : entityRefs.slice().sort((a, b) => a.expressId - b.expressId);

  const typeStringMap = new Map<string, number>();
  const typeStrings: string[] = [];

  const expressIds = new Uint32Array(count);
  const byteOffsets = new Uint32Array(count);
  const byteLengths = new Uint32Array(count);
  const typeIndices = new Uint16Array(count);
  chunkStart = performance.now();

  for (let i = 0; i < count; i++) {
    if ((i % chunkSize) === 0 && performance.now() - chunkStart >= budgetMs) {
      await yieldToEventLoop();
      chunkStart = performance.now();
    }
    const ref = sorted[i];
    expressIds[i] = ref.expressId;
    byteOffsets[i] = ref.byteOffset;
    byteLengths[i] = ref.byteLength;

    let typeIdx = typeStringMap.get(ref.type);
    if (typeIdx === undefined) {
      typeIdx = typeStrings.length;
      typeStrings.push(ref.type);
      typeStringMap.set(ref.type, typeIdx);
    }
    typeIndices[i] = typeIdx;
  }

  return new CompactEntityIndex(
    expressIds,
    byteOffsets,
    byteLengths,
    typeIndices,
    typeStrings,
    lruMaxSize
  );
}
