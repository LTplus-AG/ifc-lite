/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Block-compressed backing store for {@link IfcSourceBytes} (#2183).
 *
 * The source is the whole IFC file, resident for the model's lifetime because
 * property and attribute reads slice it synchronously during React render. On
 * a 342 MB model that is 327 MB of the viewer's main-thread heap. Deflating it
 * into fixed-size blocks and inflating on demand trades that for ~67 MB plus a
 * small cache.
 *
 * The numbers this design is built on, measured with fflate 0.8.3 on the real
 * 342.7 MB model rather than assumed:
 *
 *   - 64 KiB blocks at level 6: 342.7 MB -> 67 MB (19.7%), and an inflate costs
 *     0.18 ms p50 / 0.40 ms max. 256 KiB stores 3 MB less but triples the p50
 *     to 0.69 ms, which is the wrong trade for a synchronous read on the render
 *     path. 16 KiB gives back 10 MB for latency nothing needs.
 *   - A full per-entity sweep touches 5161 of 5229 blocks -- essentially each
 *     block exactly once -- because expressId order tracks byte offset in STEP.
 *     It is a sequential scan, not a thrash, so cache CAPACITY barely matters:
 *     32 MB and 256 MB are within 7% of each other. The cache is sized for the
 *     interactive working set, not to chase a hit rate.
 *   - Reusing evicted buffers is worth ~13% on a sweep (1.73 -> 1.53 s). Real
 *     but not load-bearing: inflate itself dominates, so the pool stays small
 *     and simple and is never allowed to justify complexity.
 */

import { safeUtf8Decode } from '@ifc-lite/data';
import { inflateSync } from 'fflate';

/** Fixed-size blocks. See the header for why 64 KiB and not 256 KiB. */
export const DEFAULT_BLOCK_SIZE = 64 * 1024;

/**
 * Inflated-block cache capacity, in bytes.
 *
 * 32 MB = 512 blocks. Sized from the measured interactive working set: the
 * worst interactive case observed (a 1000-product selection) touches 500
 * blocks. Sweeps are unaffected by capacity, so there is nothing to buy by
 * going larger, and every byte here comes straight off the win.
 */
export const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

/** Evicted buffers kept for reuse. Small on purpose: worth ~13%, not more. */
const MAX_POOLED_BUFFERS = 64;

export interface BlockStoreCounters {
  /** Block inflations performed. The number a regression pins. */
  inflates: number;
  /** Reads served entirely from cached blocks. */
  hits: number;
  /** Reads that had to inflate at least one block. */
  misses: number;
  /** Reads spanning a block boundary, which must stitch. */
  boundaryStitches: number;
  /** Inflated bytes produced, cumulative. */
  bytesInflated: number;
  /** Inflations that reused a pooled buffer. */
  poolReuses: number;
  /** Blocks dropped from the cache. */
  evictions: number;
}

/** The wire/consructor shape: compressed blocks plus their offset index. */
export interface BlockedPayload {
  /** All compressed blocks, concatenated. */
  blocks: Uint8Array;
  /**
   * `blocks` offsets, length `blockCount + 1`. Block `i` occupies
   * `[index[i], index[i + 1])`, so the last entry is `blocks.byteLength`.
   */
  index: Uint32Array;
  /**
   * One byte per block: 1 = stored verbatim, 0 = deflated. Incompressible
   * blocks (already-compressed payloads embedded in a STEP file) would
   * otherwise grow, and a store that can grow is not one you can gate on size.
   */
  storedMask: Uint8Array;
  blockSize: number;
  /** Logical length of the original source. */
  totalLength: number;
}

/**
 * Random-access reader over compressed blocks.
 *
 * Deliberately NOT an `IfcSourceBytes`: that interface is the store's public
 * contract and must keep exactly one implementation from the outside. This is
 * the machinery the accessor switches onto in place.
 */
export class BlockStore {
  readonly blockSize: number;
  readonly totalLength: number;
  readonly blockCount: number;

  readonly #blocks: Uint8Array;
  readonly #index: Uint32Array;
  readonly #storedMask: Uint8Array;

  /** Inflated blocks. A `Map` is insertion-ordered, which is the LRU order. */
  readonly #cache = new Map<number, Uint8Array>();
  readonly #pool: Uint8Array[] = [];
  readonly #maxCachedBlocks: number;

  readonly counters: BlockStoreCounters = {
    inflates: 0, hits: 0, misses: 0, boundaryStitches: 0,
    bytesInflated: 0, poolReuses: 0, evictions: 0,
  };

  constructor(payload: BlockedPayload, cacheBytes: number = DEFAULT_CACHE_BYTES) {
    this.blockSize = payload.blockSize;
    this.totalLength = payload.totalLength;
    this.#blocks = payload.blocks;
    this.#index = payload.index;
    this.#storedMask = payload.storedMask;
    this.blockCount = Math.max(0, payload.index.length - 1);
    // At least one block, or a read on a tiny source could never be served.
    this.#maxCachedBlocks = Math.max(1, Math.floor(cacheBytes / payload.blockSize));
  }

  /** Uncompressed length of block `i`; the last block is short. */
  #blockLength(i: number): number {
    const start = i * this.blockSize;
    return Math.min(this.blockSize, this.totalLength - start);
  }

  /**
   * The inflated block `i`, from cache or by inflating it.
   *
   * The returned view is owned by the cache and is only valid until the block
   * is evicted, which is why every public read copies out of it rather than
   * handing it to a caller.
   */
  #block(i: number): Uint8Array {
    const cached = this.#cache.get(i);
    if (cached !== undefined) {
      // Refresh recency: delete + re-set moves it to the end of the Map order.
      this.#cache.delete(i);
      this.#cache.set(i, cached);
      return cached;
    }

    const from = this.#index[i];
    const to = this.#index[i + 1];
    const compressed = this.#blocks.subarray(from, to);
    const length = this.#blockLength(i);

    let out: Uint8Array;
    if (this.#storedMask[i] === 1) {
      // Stored verbatim: still copied, because the caller-visible bytes must
      // not alias the compressed backing store.
      out = this.#take(length);
      out.set(compressed.subarray(0, length));
    } else {
      const reused = this.#takeExact(length);
      out = reused !== null
        ? inflateSync(compressed, { out: reused })
        : inflateSync(compressed);
    }

    this.counters.inflates++;
    this.counters.bytesInflated += out.byteLength;
    this.#cache.set(i, out);
    this.#evictIfNeeded();
    return out;
  }

  /** A pooled buffer of exactly `length`, or null when none fits. */
  #takeExact(length: number): Uint8Array | null {
    for (let i = this.#pool.length - 1; i >= 0; i--) {
      if (this.#pool[i].byteLength === length) {
        const buf = this.#pool[i];
        this.#pool.splice(i, 1);
        this.counters.poolReuses++;
        return buf;
      }
    }
    return null;
  }

  #take(length: number): Uint8Array {
    return this.#takeExact(length) ?? new Uint8Array(length);
  }

  #evictIfNeeded(): void {
    while (this.#cache.size > this.#maxCachedBlocks) {
      const oldest = this.#cache.keys().next().value as number;
      const buf = this.#cache.get(oldest);
      this.#cache.delete(oldest);
      this.counters.evictions++;
      if (buf !== undefined && this.#pool.length < MAX_POOLED_BUFFERS) this.#pool.push(buf);
    }
  }

  /**
   * Bytes in `[start, end)`, as a fresh array.
   *
   * Always a copy, never a view: the bytes live in cache blocks that later
   * reads may evict and hand to the pool for overwriting. A view would go
   * stale silently, which is the worst possible failure for a byte range.
   * Callers were already told `slice` only returns a view when `isResident`.
   */
  read(start: number, end: number): Uint8Array {
    if (end <= start) return new Uint8Array(0);

    const first = Math.floor(start / this.blockSize);
    const last = Math.floor((end - 1) / this.blockSize);

    if (first === last) {
      const block = this.#block(first);
      const offset = start - first * this.blockSize;
      // slice() on the cached block copies, which is what we want here.
      return block.slice(offset, offset + (end - start));
    }

    this.counters.boundaryStitches++;
    const out = new Uint8Array(end - start);
    let written = 0;
    for (let i = first; i <= last; i++) {
      const block = this.#block(i);
      const blockStart = i * this.blockSize;
      const from = Math.max(start, blockStart) - blockStart;
      const to = Math.min(end, blockStart + block.byteLength) - blockStart;
      out.set(block.subarray(from, to), written);
      written += to - from;
    }
    return out;
  }

  /**
   * UTF-8 decode of `[start, end)`.
   *
   * Goes through the same {@link read}, so a multi-byte sequence straddling a
   * block boundary is decoded from stitched bytes and cannot be split.
   */
  decodeUtf8(start: number, end: number): string {
    if (end <= start) return '';
    return safeUtf8Decode(this.read(start, end), 0, end - start);
  }

  /**
   * The whole source, contiguous.
   *
   * Allocates `totalLength` and inflates every block, so it costs roughly a
   * full sweep (~1.8 s and 343 MB on the reference model). It exists because
   * some consumers genuinely need all the bytes; it is not a fallback to reach
   * for casually, and `withMaterialized` on the accessor is the scoped form.
   */
  materialize(): Uint8Array {
    const out = new Uint8Array(this.totalLength);
    for (let i = 0; i < this.blockCount; i++) {
      out.set(this.#block(i), i * this.blockSize);
    }
    return out;
  }

  /** Compressed size, for accounting and the dev counter. */
  get storedBytes(): number {
    return this.#blocks.byteLength;
  }

  /** Inflated bytes currently held by the cache and the pool. */
  get residentBytes(): number {
    let n = 0;
    for (const b of this.#cache.values()) n += b.byteLength;
    for (const b of this.#pool) n += b.byteLength;
    return n;
  }

  /** Drop cached blocks and pooled buffers. */
  clearCache(): void {
    this.#cache.clear();
    this.#pool.length = 0;
  }

  /** The payload, for handing this store to a worker without inflating. */
  toPayload(): BlockedPayload {
    return {
      blocks: this.#blocks,
      index: this.#index,
      storedMask: this.#storedMask,
      blockSize: this.blockSize,
      totalLength: this.totalLength,
    };
  }
}
