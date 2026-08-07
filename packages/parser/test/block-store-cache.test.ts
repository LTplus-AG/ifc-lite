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

/**
 * COMPRESSIBLE, position-dependent content.
 *
 * The obvious fixture -- `(i * 31 + ...) & 0xff` -- is a permutation of 0..255
 * in every 256-byte block, i.e. maximum entropy, so deflate cannot shrink it
 * and all 40 blocks take the stored-verbatim path. That made the entire
 * `inflateSync(compressed, { out: reused })` line unreachable from this file,
 * which is the exact line the aliasing tests below exist to protect: 191
 * fresh inflates, 197 verbatim copies, ZERO pooled inflates across the whole
 * suite. Repetitive text deflates, so the pooled path actually runs; a
 * per-position marker keeps every range distinguishable.
 */
function fixture(blocks: number): Uint8Array {
  const out = new Uint8Array(blocks * BLOCK);
  const filler = new TextEncoder().encode("#1=IFCWALL('0YvCT2',$,'Wall',$);\n");
  for (let i = 0; i < out.length; i++) out[i] = filler[i % filler.length];
  // A marker every 16 bytes so a misplaced range is still detectable.
  for (let i = 0; i < out.length; i += 16) out[i] = (i / 16) & 0xff;
  return out;
}

/** Maximum entropy: deflate cannot shrink it, so every block is verbatim. */
function incompressibleFixture(blocks: number): Uint8Array {
  const out = new Uint8Array(blocks * BLOCK);
  let x = 0x9e3779b9;
  for (let i = 0; i < out.length; i += 4) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    for (let b = 0; b < 4 && i + b < out.length; b++) out[i + b] = (x >>> (b * 8)) & 0xff;
  }
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

/**
 * The pooled-inflate path, which nothing else reaches.
 *
 * `inflateSync(compressed, { out: reused })` is the line the aliasing tests
 * above are written to protect, and until this suite's fixture became
 * compressible it executed zero times in the whole package. These force the
 * two preconditions to co-occur: deflated blocks AND enough cache pressure to
 * recycle buffers into the pool.
 */
describe('BlockStore pooled inflation', () => {
  it('actually inflates into recycled buffers, and returns correct bytes', () => {
    const { store: s, bytes } = store(40, 2);

    for (let b = 0; b < 40; b++) s.read(b * BLOCK, b * BLOCK + 64);
    assertPooledInflationHappened(s);

    // Every block, read again after heavy recycling, must still be exact.
    for (let b = 0; b < 40; b++) {
      const got = s.read(b * BLOCK, (b + 1) * BLOCK);
      const want = bytes.subarray(b * BLOCK, (b + 1) * BLOCK);
      for (let i = 0; i < want.length; i++) {
        if (got[i] !== want[i]) {
          expect.fail(`block ${b} byte ${i} wrong after pooled reuse: ${got[i]} != ${want[i]}`);
        }
      }
    }
  });

  it('keeps verbatim blocks correct when the pool is shared with deflated ones', () => {
    // Mixed content: some blocks deflate, some do not, and both draw from the
    // same free list. A pooled buffer written by `out.set` and one written by
    // inflateSync must be equally safe to recycle.
    const compressible = fixture(20);
    const random = incompressibleFixture(20);
    const mixed = new Uint8Array(compressible.length + random.length);
    mixed.set(compressible, 0);
    mixed.set(random, compressible.length);

    const payload = compressSource(mixed, BLOCK);
    expect(payload.storedMask.some((f) => f === 1), 'no verbatim blocks').toBe(true);
    expect(payload.storedMask.some((f) => f === 0), 'no deflated blocks').toBe(true);

    const s = new BlockStore(payload, 2 * BLOCK);
    for (let b = 0; b < 40; b++) s.read(b * BLOCK, b * BLOCK + 64);
    assertPooledInflationHappened(s);

    for (let off = 0; off < mixed.length; off += 97) {
      const end = Math.min(off + 97, mixed.length);
      const got = s.read(off, end);
      for (let i = 0; i < end - off; i++) {
        if (got[i] !== mixed[off + i]) {
          expect.fail(`byte ${off + i} wrong after mixed pooled reuse`);
        }
      }
    }
  });
});

/** Both preconditions actually co-occurred, or the test above proves nothing. */
function assertPooledInflationHappened(s: BlockStore): void {
  expect(s.counters.inflates, 'no block ever deflated; the fixture is incompressible')
    .toBeGreaterThan(0);
  expect(s.counters.evictions, 'no eviction; the cache is too large to recycle')
    .toBeGreaterThan(0);
  expect(s.counters.poolReuses, 'nothing was ever recycled into a pooled buffer')
    .toBeGreaterThan(0);
}

describe('BlockStore counters', () => {
  it('counts hits and misses, one per read', () => {
    // These are surfaced to the dev counter through sourceBlockStats. They
    // were declared, documented and never incremented, so the reported hit
    // rate would have been 0% forever -- true-looking and meaningless.
    const { store: s } = store(10, 10);

    s.read(0, 32);
    expect(s.counters.misses, 'a cold read is a miss').toBe(1);
    expect(s.counters.hits).toBe(0);

    s.read(0, 32);
    expect(s.counters.hits, 'a warm read is a hit').toBe(1);
    expect(s.counters.misses).toBe(1);

    s.read(BLOCK - 4, BLOCK + 4);
    expect(s.counters.misses, 'a straddling read with one cold half is a miss').toBe(2);
    s.read(BLOCK - 4, BLOCK + 4);
    expect(s.counters.hits, 'both halves cached now').toBe(2);
  });

  it('does NOT count a verbatim copy as an inflate', () => {
    // Conflating them would overstate decompression work on exactly the models
    // whose content cannot be compressed.
    const bytes = incompressibleFixture(4);
    const payload = compressSource(bytes, BLOCK);
    expect(payload.storedMask.every((f) => f === 1), 'fixture must be all-verbatim').toBe(true);

    const s = new BlockStore(payload, 4 * BLOCK);
    s.read(0, BLOCK * 4);
    expect(s.counters.inflates, 'verbatim blocks were counted as inflations').toBe(0);
    expect(s.counters.bytesInflated).toBe(0);
  });

  it('recycles buffers through the INFLATE path specifically', () => {
    // An all-compressible fixture, so `#take` (the verbatim path) is never
    // reached and the only possible source of a pool reuse is
    // `inflateSync(compressed, { out: reused })` -- the line this file exists
    // to protect. With mixed content this assertion is satisfiable by the
    // verbatim path alone, which is how it went unpinned.
    const bytes = fixture(40);
    const payload = compressSource(bytes, BLOCK);
    expect(payload.storedMask.every((f) => f === 0), 'fixture must be all-deflated').toBe(true);

    const s = new BlockStore(payload, 2 * BLOCK);
    for (let b = 0; b < 40; b++) s.read(b * BLOCK, b * BLOCK + 32);
    expect(s.counters.poolReuses, 'no buffer was recycled into an inflate').toBeGreaterThan(0);
  });
});

describe('BlockStore payload validation', () => {
  // Reached from sourceBytesFromTransferable, i.e. across a worker boundary,
  // where the payload is whatever the other side sent. The read path promises
  // never to throw, so a malformed payload has to fail at construction rather
  // than deep inside a slice() far from the cause.
  const good = () => compressSource(fixture(4), BLOCK);

  it.each([
    ['a fractional block size', (p: ReturnType<typeof good>) => ({ ...p, blockSize: 100.5 })],
    ['a zero block size', (p: ReturnType<typeof good>) => ({ ...p, blockSize: 0 })],
    ['an infinite block size', (p: ReturnType<typeof good>) => ({ ...p, blockSize: Infinity })],
    ['a short index', (p: ReturnType<typeof good>) => ({ ...p, index: p.index.slice(0, 2) })],
    ['a short stored mask', (p: ReturnType<typeof good>) => ({ ...p, storedMask: p.storedMask.slice(0, 1) })],
    ['a non-monotonic index', (p: ReturnType<typeof good>) => {
      const index = p.index.slice();
      index[2] = 0;
      return { ...p, index };
    }],
    ['an index past the end of the blocks', (p: ReturnType<typeof good>) => {
      const index = p.index.slice();
      index[index.length - 1] = p.blocks.byteLength + 1000;
      return { ...p, index };
    }],
  ])('rejects %s at construction', (_what, corrupt) => {
    expect(() => new BlockStore(corrupt(good()))).toThrow(/BlockStore:/);
  });

  it('accepts a well-formed payload', () => {
    // The control: without it every row above could pass because the
    // constructor rejects everything.
    expect(() => new BlockStore(good())).not.toThrow();
  });
});
