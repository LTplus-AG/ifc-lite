/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fake-indexeddb installs a Node-compatible IDB implementation on
// `globalThis.indexedDB` (+ the IDB* constructors) via the `/auto` entry.
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  setCached,
  getCached,
  clearCache,
  openDatabase,
  ensureRoomForEntry,
  evictToFree,
  availableQuotaBytes,
  PER_ENTRY_MAX_BYTES,
} from './ifc-cache.js';

const KB = 1024;
const MB = 1024 * 1024;

/** A buffer filled with a key-derived pattern so we can assert byte-identity. */
function patterned(bytes: number, seed: number): ArrayBuffer {
  const buf = new ArrayBuffer(bytes);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bytes; i++) view[i] = (i * 31 + seed) & 0xff;
  return buf;
}

function bytesEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- navigator.storage.estimate stubbing (Safari-robustness paths) -----------
const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

/** Install a `navigator.storage.estimate` that reports the given quota/usage. */
function stubEstimate(quota: number | undefined, usage: number | undefined): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { estimate: async () => ({ quota, usage }) } },
    configurable: true,
    writable: true,
  });
}

/** Simulate Safari / older browsers where the Storage estimate API is absent. */
function stubEstimateUnavailable(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: {}, // no `.storage`
    configurable: true,
    writable: true,
  });
}

function restoreNavigator(): void {
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  else delete (globalThis as Record<string, unknown>).navigator;
}

describe('ifc-cache quota + robustness (blocker #2)', () => {
  beforeEach(async () => {
    await clearCache();
    stubEstimateUnavailable();
  });
  afterEach(() => {
    restoreNavigator();
  });

  it('round-trips the mesh-only validation metadata (lastModified + fullSourceHash)', async () => {
    // These fields are the source-decoupled tier's real validation guard, so a
    // hit can reject a changed source instead of forming a chimera.
    await setCached('meta', patterned(8 * KB, 8), 'meta.ifc', 8 * KB, undefined, {
      lastModified: 1_720_000_000_123,
      fullSourceHash: 'deadbeef'.repeat(8),
    });
    const got = await getCached('meta');
    assert.ok(got);
    assert.equal(got!.lastModified, 1_720_000_000_123);
    assert.equal(got!.fullSourceHash, 'deadbeef'.repeat(8));
    assert.equal(got!.sourceBuffer, undefined, 'mesh-only entries persist no source');
  });

  it('round-trips a large single record (buffer + source) byte-identical', async () => {
    // Proves a single large IndexedDB record writes AND reads back intact, so
    // the mesh-only geometry blob does not need chunking: the per-entry ceiling
    // (PER_ENTRY_MAX_BYTES) + graceful-skip cover the only failure (Safari
    // rejecting an oversized blob), and everything under it round-trips.
    const buffer = patterned(24 * MB, 1);
    const source = patterned(16 * MB, 2);
    await setCached('big', buffer, 'big.ifc', source.byteLength, source);

    const got = await getCached('big');
    assert.ok(got, 'large record must be retrievable');
    assert.ok(bytesEqual(got!.buffer, buffer), 'cache buffer round-trips byte-identical');
    assert.ok(got!.sourceBuffer && bytesEqual(got!.sourceBuffer, source), 'source round-trips byte-identical');
  });

  it('estimate-unavailable → falls back to the per-entry ceiling and still writes', async () => {
    // availableQuotaBytes returns Infinity when the Storage API is absent, so
    // ensureRoomForEntry relies on the ceiling alone rather than refusing writes.
    assert.equal(await availableQuotaBytes(), Infinity);
    await setCached('u', patterned(64 * KB, 3), 'u.ifc', 64 * KB);
    const got = await getCached('u');
    assert.ok(got, 'write proceeds when the estimate API is unavailable');
  });

  it('estimate available → availableQuotaBytes reports quota minus usage', async () => {
    stubEstimate(500 * MB, 200 * MB);
    assert.equal(await availableQuotaBytes(), 300 * MB);
    stubEstimate(undefined, undefined); // malformed estimate → treat as unavailable
    assert.equal(await availableQuotaBytes(), Infinity);
  });

  it('refuses an oversized record (per-entry ceiling) without allocating it', async () => {
    const db = await openDatabase();
    // Pass a byte COUNT above the ceiling — no giant allocation needed.
    assert.equal(await ensureRoomForEntry(db, PER_ENTRY_MAX_BYTES + 1, 'x'), false);
    assert.equal(await ensureRoomForEntry(db, 10 * MB, 'x'), true);
  });

  it('quota exhausted (cannot free enough) → graceful skip; existing entries survive; no throw', async () => {
    // Seed a keeper while quota looks fine.
    await setCached('keep', patterned(32 * KB, 4), 'keep.ifc', 32 * KB);

    // Now the origin quota is nearly full and eviction cannot free the 128MB
    // headroom (there is nothing large to evict), so the write must be skipped.
    stubEstimate(1 * MB, 1 * MB - 4 * KB); // ~4KB free
    await assert.doesNotReject(
      setCached('new', patterned(2 * MB, 5), 'new.ifc', 2 * MB),
      'a quota failure must never throw (a cache write can never break the load)',
    );

    assert.equal(await getCached('new'), null, 'the over-quota entry was not written');
    const keep = await getCached('keep');
    assert.ok(keep && bytesEqual(keep.buffer, patterned(32 * KB, 4)), 'the surviving entry is intact');
  });

  it('non-fatal when the put itself fails (transaction error/abort)', async () => {
    // Simulate a Safari "blob too large" rejection at put time (the estimate said
    // there was room). setCached must resolve, not reject or hang.
    const proto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: unknown } } }).IDBObjectStore.prototype;
    const originalPut = proto.put;
    proto.put = function put(): never {
      throw new DOMException('simulated quota', 'QuotaExceededError');
    };
    try {
      await assert.doesNotReject(
        setCached('boom', patterned(16 * KB, 6), 'boom.ifc', 16 * KB),
        'a put failure must be caught and non-fatal',
      );
      assert.equal(await getCached('boom'), null);
    } finally {
      proto.put = originalPut;
    }
    // The cache is still usable after the failure.
    await setCached('after', patterned(16 * KB, 7), 'after.ifc', 16 * KB);
    assert.ok(await getCached('after'), 'cache still works after a transient put failure');
  });
});

describe('ifc-cache LRU eviction correctness (blocker #2)', () => {
  // Seed three entries oldest→newest with distinct createdAt (real-time gaps),
  // each 2KB, under an unlimited quota (no eviction during seeding).
  async function seedThree(): Promise<void> {
    await clearCache();
    stubEstimateUnavailable();
    await setCached('a', patterned(2 * KB, 10), 'a.ifc', 2 * KB);
    await delay(4);
    await setCached('b', patterned(2 * KB, 11), 'b.ifc', 2 * KB);
    await delay(4);
    await setCached('c', patterned(2 * KB, 12), 'c.ifc', 2 * KB);
  }

  beforeEach(seedThree);
  afterEach(restoreNavigator);

  it('evicts oldest-by-createdAt first (LRU), leaving the newest', async () => {
    const db = await openDatabase();
    // Free ~3KB: evict 'a' (2KB, still short), then 'b' (4KB total ≥ 3KB) → stop.
    const enough = await evictToFree(db, 3 * KB, '__none__');
    assert.equal(enough, true);
    assert.equal(await getCached('a'), null, 'oldest evicted');
    assert.equal(await getCached('b'), null, 'next-oldest evicted');
    assert.ok(await getCached('c'), 'newest survives (LRU order honoured)');
  });

  it('never evicts the keepKey (the entry being written), even if it is the oldest', async () => {
    const db = await openDatabase();
    // Free ~3KB while keepKey 'a' (the OLDEST) is skipped → evicts 'b' then 'c'.
    const enough = await evictToFree(db, 3 * KB, 'a');
    assert.equal(enough, true);
    assert.ok(await getCached('a'), 'keepKey preserved despite being the oldest');
    assert.equal(await getCached('b'), null);
    assert.equal(await getCached('c'), null);
  });

  it('is non-destructive when it cannot free enough (keeps every entry)', async () => {
    const db = await openDatabase();
    // Target exceeds the combined size of all eligible entries → delete NOTHING,
    // so we never throw away caches for a write that would be skipped anyway.
    const enough = await evictToFree(db, 1024 * MB, '__none__');
    assert.equal(enough, false);
    assert.ok(await getCached('a'), 'a survives a failed eviction');
    assert.ok(await getCached('b'), 'b survives a failed eviction');
    assert.ok(await getCached('c'), 'c survives a failed eviction');
  });

  it('leaves surviving entries byte-identical (no corruption of neighbours)', async () => {
    const db = await openDatabase();
    await evictToFree(db, 2 * KB, '__none__'); // evict just 'a'
    assert.equal(await getCached('a'), null);
    const c = await getCached('c');
    assert.ok(c && bytesEqual(c.buffer, patterned(2 * KB, 12)), 'survivor is uncorrupted');
  });
});
