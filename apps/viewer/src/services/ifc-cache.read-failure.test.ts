/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A cache READ failure must degrade to a MISS, never break the load.
 *
 * `setCached` already guarantees this on the WRITE path ("A cache write must
 * NEVER break the load"). The read/maintenance helpers each wrap their work in
 * a `try`/`catch` that documents the same contract — warn and return
 * `null`/`false`/zeros — but they used to `return new Promise(...)` INSIDE the
 * try without `await`, so the promise's own rejection bypassed the catch
 * entirely and propagated to the caller. That bug is fixed with `return await`.
 *
 * Failure induction: #2102 (`withConnection` / `beginTransaction`) added a
 * ONE-SHOT reopen for a connection that was closed underneath the cache
 * (`InvalidStateError` from `db.transaction()`), so closing the memoised
 * connection is no longer a failure at all — it's a recoverable condition
 * `beginTransaction` transparently papers over. These tests instead force a
 * `request.onerror` — the failure mode #2102 deliberately leaves alone,
 * because by the time a request exists the transaction was already created
 * successfully, so there is nothing left to retry. We do this by aborting the
 * transaction the moment the request is issued: IndexedDB fires `onerror`
 * (with `AbortError`), not `onsuccess`, on every request still pending when
 * its transaction aborts — a spec-guaranteed way to fail a request without
 * needing invalid data or a broken store.
 *
 * Lives in its own file because the assertions monkeypatch
 * `IDBObjectStore.prototype`; `tsx --test` runs each file in its own process.
 */

// fake-indexeddb installs a Node-compatible IDB implementation on
// `globalThis.indexedDB` (+ the IDB* constructors) via the `/auto` entry.
import 'fake-indexeddb/auto';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  setCached,
  getCached,
  hasCached,
  deleteCached,
  clearCache,
  getCacheStats,
} from './ifc-cache.js';

/** Resolve to the settled outcome, or the literal 'HUNG' after `ms`. */
async function settleOrHang<T>(p: Promise<T>, ms = 500): Promise<
  { kind: 'resolved'; value: T } | { kind: 'rejected'; error: unknown } | { kind: 'hung' }
> {
  return Promise.race([
    p.then(
      (value) => ({ kind: 'resolved' as const, value }),
      (error: unknown) => ({ kind: 'rejected' as const, error }),
    ),
    new Promise<{ kind: 'hung' }>((resolve) => {
      setTimeout(() => resolve({ kind: 'hung' as const }), ms).unref?.();
    }),
  ]);
}

/**
 * One-shot: patch `IDBObjectStore.prototype[methodName]` so the NEXT call
 * issues a real request, then immediately aborts that request's transaction
 * before returning control to the caller. Per spec, a pending request whose
 * transaction aborts fires `onerror` (with an `AbortError`), never
 * `onsuccess` — this fails the request without any invalid data, and without
 * touching `openDatabase`'s memo, so `beginTransaction`'s reopen path is never
 * even triggered (the transaction it handed back was created just fine).
 */
function failNextRequest(methodName: 'get' | 'count' | 'delete' | 'clear' | 'getAll'): void {
  const proto = IDBObjectStore.prototype as unknown as Record<string, (...args: unknown[]) => IDBRequest>;
  const original = proto[methodName];
  proto[methodName] = function (this: IDBObjectStore, ...args: unknown[]) {
    proto[methodName] = original; // restore immediately: strictly one-shot
    const request = original.apply(this, args);
    try {
      request.transaction!.abort();
    } catch {
      /* transaction may already be inactive; the request still errors */
    }
    return request;
  };
}

describe('ifc-cache: a read failure degrades to a miss, it does not break the load', () => {
  it('getCached resolves null (not rejects) when the underlying request errors', async () => {
    await setCached('req-error', new ArrayBuffer(64), 'a.ifc', 64);

    // Guard against a vacuous pass: the entry must really be readable first,
    // so a later `null` means "degraded to a miss", not "was never there".
    assert.notEqual(await getCached('req-error'), null, 'precondition: entry is readable');

    failNextRequest('get');
    const outcome = await settleOrHang(getCached('req-error'));
    assert.equal(outcome.kind, 'resolved', 'getCached must not reject on a read failure');
    assert.equal(outcome.kind === 'resolved' ? outcome.value : undefined, null);

    // The entry is untouched — this was a transient failure, not a corruption
    // or a real miss. Confirms we degraded rather than actually losing data.
    assert.notEqual(await getCached('req-error'), null, 'entry survives the induced failure');
  });

  it('hasCached / getCacheStats / deleteCached / clearCache also degrade instead of rejecting', async () => {
    await setCached('req-error-2', new ArrayBuffer(64), 'b.ifc', 64);
    assert.equal(await hasCached('req-error-2'), true, 'precondition: entry is present');

    failNextRequest('count');
    const has = await settleOrHang(hasCached('req-error-2'));
    assert.equal(has.kind, 'resolved', 'hasCached must not reject');
    assert.equal(has.kind === 'resolved' ? has.value : undefined, false, 'degrades to "not found", not a throw');

    failNextRequest('getAll');
    const stats = await settleOrHang(getCacheStats());
    assert.equal(stats.kind, 'resolved', 'getCacheStats must not reject');
    assert.deepEqual(
      stats.kind === 'resolved' ? stats.value : undefined,
      { entryCount: 0, totalSize: 0, entries: [] },
      'degrades to an empty report, not a throw',
    );

    failNextRequest('delete');
    const del = await settleOrHang(deleteCached('req-error-2'));
    assert.equal(del.kind, 'resolved', 'deleteCached must not reject');
    // The delete request errored, so the entry must still be there — deleteCached
    // degraded (silently skipped), it did not silently "succeed" on a lie.
    assert.equal(await hasCached('req-error-2'), true, 'entry survives the failed delete');

    failNextRequest('clear');
    const cleared = await settleOrHang(clearCache());
    assert.equal(cleared.kind, 'resolved', 'clearCache must not reject');
    assert.equal(await hasCached('req-error-2'), true, 'entry survives the failed clear');
  });
});
