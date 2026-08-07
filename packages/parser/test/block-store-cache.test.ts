/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cache, eviction, buffer reuse and inflate accounting for {@link BlockStore}
 * (#2183).
 *
 * These cover the two failure classes the byte-equivalence suite structurally
 * cannot see:
 *
 *   1. **Aliasing.** Equivalence tests read and compare immediately, so they
 *      pass even if `read()` hands back a live view into a cache block. That
 *      view goes stale the moment the block is evicted, and worse, the free
 *      list hands the buffer to `inflateSync({ out })` which overwrites it in
 *      place. The corruption is silent, delayed, and depends on cache
 *      pressure -- the worst possible bug to debug. Mutating `read` to return
 *      a `subarray` instead of a copy passes the whole equivalence suite; it
 *      must fail here.
 *
 *   2. **Inflate count.** Nothing about correctness changes if the store
 *      inflates a block it did not need, or re-inflates one it already had.
 *      That is exactly how a 275 MB memory win turns into a CPU regression
 *      nobody notices. These pin the counts.
 */

import { describe, expect, it } from 'vitest';

import { BlockStore } from '../src/block-store.js';
import { compressSource } from '../src/source-compress.js';

const BLOCK = 256;

/** Distinct, position-dependent bytes: any misplaced range is detectable. */
function fixture(blocks: number): Uint8Array {
  const out = new Uint8Array(blocks * BLOCK);
  for (let i = 0; i < out.length; i++) out[i] = (i * 31 + (i >> 8) * 7) & 0xff;
  return out;
}

/** A store whose cache holds `cacheBlocks` blocks, so eviction is reachable. */
function store(blocks: number, cacheBlocks: number): { store: BlockStore; bytes: Uint8Array } {
  const bytes = fixture(blocks);
  return {
    store: new BlockStore(compressSource(bytes, BLOCK), cacheBlocks * BLOCK),
    bytes,
  };
}

describe('BlockStore aliasing', () => {
  it('returns bytes that survive the block being evicted and its buffer reused', () => {
    // Cache 2 blocks out of 40, so reading the rest evicts many times and the
    // free list recycles buffers into inflateSync({ out }).
    const { store: s, bytes } = store(40, 2);

    const held = s.read(0, 100);
    const expected = bytes.slice(0, 100);
    expect(Array.from(held)).toEqual(Array.from(expected));

    // Churn: every read after the first two evicts, and pooled buffers get
    // overwritten in place by subsequent inflations.
    for (let b = 0; b < 40; b++) s.read(b * BLOCK, b * BLOCK + 50);
    expect(s.counters.evictions).toBeGreaterThan(0);
    expect(s.counters.poolReuses).toBeGreaterThan(0);

    // The bytes handed out earlier must be untouched.
    expect(Array.from(held), 'a previously returned range was corrupted by eviction')
      .toEqual(Array.from(expected));
  });

  it('returns independent arrays for two reads of the same range', () => {
    const { store: s } = store(4, 4);
    const a = s.read(0, 32);
    const b = s.read(0, 32);
    expect(a).not.toBe(b);
    a[0] = (a[0] + 1) & 0xff;
    // Mutating one must not disturb the other, nor the cached block itself.
    expect(b[0]).not.toBe(a[0]);
    expect(Array.from(s.read(0, 32))).toEqual(Array.from(b));
  });

  it('does not let a caller corrupt the cache through a returned range', () => {
    const { store: s, bytes } = store(4, 4);
    const got = s.read(0, 64);
    got.fill(0xee);
    expect(Array.from(s.read(0, 64)), 'writing to a returned range reached the cache')
      .toEqual(Array.from(bytes.slice(0, 64)));
  });
});

describe('BlockStore inflate accounting', () => {
  // A COLD store per case. Resetting the counter on a warm store measures
  // nothing: the blocks are already cached, so every count is 0 and the
  // assertions pass no matter what the index arithmetic does.
  it.each([
    { range: [0, 10], want: 1, what: 'a range inside one block' },
    // [0, BLOCK) lies wholly within block 0, so it must NOT pull in block 1.
    // This is the off-by-one that costs an inflate on every read while
    // changing not one byte of output -- invisible to equivalence tests.
    { range: [0, BLOCK], want: 1, what: 'a range ending exactly on a block boundary' },
    { range: [BLOCK, BLOCK * 2], want: 1, what: 'a whole middle block' },
    { range: [BLOCK - 1, BLOCK + 1], want: 2, what: 'a range straddling one boundary' },
    { range: [0, BLOCK * 3], want: 3, what: 'three whole blocks, cold' },
    { range: [BLOCK * 9 + 10, BLOCK * 10], want: 1, what: 'the final block' },
  ])('inflates $want block(s) for $what', ({ range, want }) => {
    const { store: s } = store(10, 10);
    s.read(range[0], range[1]);
    expect(s.counters.inflates).toBe(want);
  });

  it('serves a repeated read from cache', () => {
    const { store: s } = store(10, 10);
    s.read(500, 600);
    const after = s.counters.inflates;
    expect(after).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) s.read(500, 600);
    expect(s.counters.inflates, 'repeated identical reads re-inflated').toBe(after);
  });

  it('holds the cache to its configured capacity', () => {
    const { store: s } = store(40, 3);
    for (let b = 0; b < 40; b++) s.read(b * BLOCK, b * BLOCK + 10);
    // 3 blocks of 256 B; residentBytes also counts pooled buffers, which are
    // capped separately, so assert the cache itself did not grow unbounded.
    expect(s.residentBytes).toBeLessThanOrEqual(3 * BLOCK + 64 * BLOCK);
    expect(s.counters.evictions).toBe(37);
  });

  it('counts a full sweep as one inflate per block', () => {
    // The tripwire for a future change that turns a materialize() into a
    // per-entity loop, or that breaks LRU so a sequential scan re-inflates.
    const blocks = 40;
    const { store: s } = store(blocks, 4);
    for (let off = 0; off < blocks * BLOCK; off += 32) s.read(off, off + 32);
    expect(s.counters.inflates, 'a sequential sweep should touch each block once')
      .toBe(blocks);
  });

  it('materialize inflates every block exactly once', () => {
    const { store: s, bytes } = store(10, 2);
    const all = s.materialize();
    expect(Array.from(all)).toEqual(Array.from(bytes));
    expect(s.counters.inflates).toBe(10);
  });
});
