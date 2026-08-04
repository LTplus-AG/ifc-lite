/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Recent-files metadata + IndexedDB blob cache.
 *
 * Focus: the failure paths the silent catches used to hide — a connection
 * that was never closed when the body threw, an `open` that fires `blocked`
 * (which fires INSTEAD of success/error, so an unhandled one never settles),
 * and a corrupt metadata payload that parses but is not an array.
 */

// fake-indexeddb installs a Node-compatible IDB implementation on
// `globalThis.indexedDB`; the round-trip test uses it. The failure-path tests
// swap in their own stub for the duration of the test.
import 'fake-indexeddb/auto';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  getRecentFiles,
  cacheFileBlobs,
  getCachedFileNames,
  getCachedFile,
} from './recent-files.js';

interface MemoryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryStorage implements MemoryStorageLike {
  private store = new Map<string, string>();
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void { this.store.set(key, value); }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown; indexedDB?: unknown };
const KEY = 'ifc-lite:recent-files';

const realIndexedDB = g.indexedDB;
let warnings: unknown[][];
const realWarn = console.warn;

beforeEach(() => {
  g.localStorage = new MemoryStorage();
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
});
afterEach(() => {
  g.indexedDB = realIndexedDB;
  console.warn = realWarn;
});

/**
 * An `indexedDB` stand-in whose `open` settles via `outcome`, handing back a
 * database object that counts `close()` calls and can be told to throw from
 * `transaction()` (the shape of `InvalidStateError` / `NotFoundError`).
 */
function stubIndexedDb(
  outcome: 'success' | 'error' | 'blocked',
  opts: { transactionThrows?: boolean } = {},
): { closes: number } {
  const counter = { closes: 0 };
  const db = {
    close() { counter.closes += 1; },
    transaction() {
      if (opts.transactionThrows) throw new Error('InvalidStateError: database is closing');
      throw new Error('unreachable: transaction not expected in this test');
    },
  };
  g.indexedDB = {
    open() {
      const req: Record<string, unknown> = { result: db, error: new Error('open failed'), transaction: null };
      // Handlers are assigned by openDB AFTER open() returns, so fire on a
      // later turn — exactly as the platform does.
      queueMicrotask(() => {
        const handler = req[`on${outcome}`];
        if (typeof handler === 'function') (handler as () => void)();
      });
      return req;
    },
  };
  return counter;
}

/** Reject rather than hang the suite if a promise never settles. */
function withDeadline<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('promise never settled')), ms).unref?.()),
  ]);
}

describe('getRecentFiles', () => {
  it('reads back stored entries', () => {
    (g.localStorage as MemoryStorageLike).setItem(
      KEY, JSON.stringify([{ name: 'a.ifc', size: 1, timestamp: 2 }]),
    );
    assert.deepStrictEqual(getRecentFiles(), [{ name: 'a.ifc', size: 1, timestamp: 2 }]);
  });

  it('returns an empty list for a payload that parses but is not an array', () => {
    // `JSON.parse('{}')` succeeds, so the catch never fires; the object then
    // reached CommandPalette/ViewportContainer, which `.map`/`.slice` it during
    // render. Callers must always get an array.
    for (const corrupt of ['{}', '"5"', 'null', '17']) {
      (g.localStorage as MemoryStorageLike).setItem(KEY, corrupt);
      assert.deepStrictEqual(getRecentFiles(), [], `payload ${corrupt}`);
    }
  });

  it('returns an empty list for unparseable JSON', () => {
    (g.localStorage as MemoryStorageLike).setItem(KEY, '{not json');
    assert.deepStrictEqual(getRecentFiles(), []);
  });
});

describe('IndexedDB blob cache — failure paths', () => {
  it('settles instead of hanging when `open` reports blocked', async () => {
    // `blocked` fires INSTEAD of success/error. Unhandled, the promise never
    // settles and the awaiting click handler parks forever.
    stubIndexedDb('blocked');
    assert.strictEqual(await withDeadline(getCachedFile('a.ifc')), null);
    assert.deepStrictEqual(await withDeadline(getCachedFileNames()), []);
    assert.strictEqual(warnings.length, 2, 'both callers must say why they gave up');
    assert.match(String(warnings[0][1]), /blocked by another open connection/);
  });

  it('closes the connection when the body throws after open succeeded', async () => {
    const counter = stubIndexedDb('success', { transactionThrows: true });
    assert.strictEqual(await withDeadline(getCachedFile('a.ifc')), null);
    assert.strictEqual(counter.closes, 1, 'getCachedFile must close on the error path');

    const counter2 = stubIndexedDb('success', { transactionThrows: true });
    assert.deepStrictEqual(await withDeadline(getCachedFileNames()), []);
    assert.strictEqual(counter2.closes, 1, 'getCachedFileNames must close on the error path');
  });

  it('closes the connection when cacheFileBlobs fails mid-transaction', async () => {
    const counter = stubIndexedDb('success', { transactionThrows: true });
    await withDeadline(cacheFileBlobs([new File([new Uint8Array([1, 2, 3])], 'a.ifc')]));
    assert.strictEqual(counter.closes, 1);
  });

  it('names the cause instead of degrading in silence', async () => {
    stubIndexedDb('success', { transactionThrows: true });
    await withDeadline(getCachedFile('a.ifc'));
    assert.strictEqual(warnings.length, 1);
    assert.match(String(warnings[0][0]), /could not read "a\.ifc"/);

    warnings = [];
    stubIndexedDb('success', { transactionThrows: true });
    await withDeadline(getCachedFileNames());
    assert.strictEqual(warnings.length, 1);
    assert.match(String(warnings[0][0]), /could not list the cached files/);
  });
});

describe('IndexedDB blob cache — round trip', () => {
  it('caches a file and reads it back', async () => {
    await cacheFileBlobs([new File([new Uint8Array([1, 2, 3])], 'roundtrip.ifc')]);
    assert.ok((await getCachedFileNames()).includes('roundtrip.ifc'));
    const file = await getCachedFile('roundtrip.ifc');
    assert.ok(file, 'the cached file must come back');
    assert.strictEqual(file.name, 'roundtrip.ifc');
    assert.deepStrictEqual(new Uint8Array(await file.arrayBuffer()), new Uint8Array([1, 2, 3]));
    assert.deepStrictEqual(warnings, [], 'the happy path must stay quiet');
  });

  it('answers null for a name that was never cached', async () => {
    assert.strictEqual(await getCachedFile('never-seen.ifc'), null);
  });
});
