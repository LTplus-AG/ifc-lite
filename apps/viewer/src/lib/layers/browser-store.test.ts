/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `readAll()` (browser-store.ts) used to listen only for `tx.oncomplete` /
 * `tx.onerror`. Per the IndexedDB spec, an exception thrown inside a
 * request's `onsuccess` handler ABORTS the transaction and fires `abort` —
 * not `error`, not `complete` — so without a `tx.onabort` branch the
 * returned promise hung forever. `BrowserLayerStore.open()` awaits two
 * `readAll()` calls, and `getBrowserLayerStore()` memoises `open()`'s
 * promise as an app-wide singleton, so the hang stalled layer-store init
 * for the whole session.
 *
 * `readAll()` now rejects on both `error` and `abort`, matching the
 * convention already used by idb-storage.ts / idb-log-storage.ts /
 * idb-flavor-storage.ts / ifc-cache.ts. `open()` in turn catches that
 * rejection and degrades to memory-only — otherwise the rejection would
 * permanently poison the `getBrowserLayerStore()` singleton over what is
 * usually a transient read glitch, trading a silent stall for a permanently
 * broken layer store for the rest of the session.
 *
 * Lives in its own file because the assertions monkeypatch
 * `IDBCursor.prototype`; `tsx --test` runs each file in its own process.
 */

// fake-indexeddb installs a Node-compatible IDB implementation on
// `globalThis.indexedDB` (+ the IDB* constructors) via the `/auto` entry.
import 'fake-indexeddb/auto';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLayerId,
  computeStackHash,
  createProvenanceManifest,
  setProvenance,
} from '@ifc-lite/ifcx';
import type { IfcxFile, IfcxNode, ProvenanceCheck } from '@ifc-lite/ifcx';
import { BrowserLayerStore } from './browser-store.js';

function publishable(
  data: IfcxNode[],
  intent: string,
  baseIds: string[] | null,
  checks: ProvenanceCheck[] = [],
): IfcxFile {
  const bare: IfcxFile = {
    header: { id: '', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0', author: 't', timestamp: '2026-07-11T00:00:00Z' },
    imports: [],
    schemas: {},
    data,
  };
  const manifest = createProvenanceManifest({
    author: { kind: 'human', principal: 'alice' },
    intent,
    base: baseIds === null ? null : { kind: 'stack', id: computeStackHash(baseIds) },
    created: '2026-07-11T00:00:00Z',
    checks,
  });
  const withManifest = setProvenance(bare, manifest);
  const id = computeLayerId(withManifest);
  return { ...withManifest, header: { ...withManifest.header, id } };
}

/** Resolve to the settled outcome, or the literal 'HUNG' after `ms`. */
async function settleOrHang<T>(p: Promise<T>, ms = 1000): Promise<
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
 * One-shot: patch `IDBCursor.prototype.continue` so the very next call
 * throws `InvalidStateError`. Per spec, a request's `onsuccess` handler
 * throwing synchronously aborts its transaction — this reproduces that
 * failure mode without needing invalid data or a broken store.
 */
function failNextCursorContinue(): void {
  const proto = IDBCursor.prototype as unknown as Record<string, (...args: unknown[]) => void>;
  const original = proto.continue;
  proto.continue = function (this: IDBCursor, ...args: unknown[]) {
    proto.continue = original; // restore immediately: strictly one-shot
    throw new DOMException('Induced failure', 'InvalidStateError');
  };
}

describe('BrowserLayerStore / readAll — IndexedDB transaction abort handling', () => {
  it('bounding control: a normal reopen rehydrates every stored layer and ref', async () => {
    const seed = await BrowserLayerStore.open();
    const base = publishable(
      [{ path: 'wall-1', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' } } }],
      'browser-store.test bounding control',
      null,
    );
    seed.storeLayer(base);
    seed.setRef('bounding-control-ref', { layers: [base.header.id] });

    const rehydrated = await BrowserLayerStore.open();
    assert.equal(rehydrated.hasLayer(base.header.id), true, 'stored layer must survive a reopen');
    assert.deepEqual(rehydrated.getRef('bounding-control-ref'), { layers: [base.header.id] });
  });

  it('an aborted cursor transaction degrades open() to memory-only instead of hanging', async () => {
    const seed = await BrowserLayerStore.open();
    const base = publishable(
      [{ path: 'wall-2', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' } } }],
      'browser-store.test induced abort',
      null,
    );
    seed.storeLayer(base);

    failNextCursorContinue();
    const outcome = await settleOrHang(BrowserLayerStore.open());
    assert.equal(outcome.kind, 'resolved', 'open() must reject-and-recover, not hang, when a readAll transaction aborts');

    // Promise.all([readAll(LAYERS), readAll(REFS)]) is all-or-nothing: the
    // induced abort on one store's cursor rejects the pair, so open()
    // degrades to a fully memory-only store rather than a partial hydrate.
    const store = outcome.kind === 'resolved' ? outcome.value : undefined;
    assert.equal(store?.hasLayer(base.header.id), false, 'the induced-failure session starts memory-only, not partially hydrated');

    // And the store is still usable — a degraded open() must not leave a
    // broken object behind.
    const fresh = publishable(
      [{ path: 'wall-3', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' } } }],
      'browser-store.test post-degrade usability',
      null,
    );
    store?.storeLayer(fresh);
    assert.equal(store?.hasLayer(fresh.header.id), true);
  });

  it('a degraded (memory-only) store never issues IndexedDB writes from storeLayer/setRef', async () => {
    failNextCursorContinue();
    const degraded = await BrowserLayerStore.open();

    // Spy on IDBObjectStore.prototype.put: the persistence primitive every
    // write path (storeLayer, setRef) funnels through. If open()'s catch
    // path truly degrades to memory-only, put() must never fire for this
    // store's mutations — not merely "the call resolved".
    const proto = IDBObjectStore.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const originalPut = proto.put;
    let putCalls = 0;
    proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
      putCalls++;
      return originalPut.apply(this, args);
    };
    const layer = publishable(
      [{ path: 'wall-4', attributes: { 'bsi::ifc::class': { code: 'IfcWall', uri: 'u' } } }],
      'browser-store.test degraded-store no-write',
      null,
    );
    try {
      degraded.storeLayer(layer);
      degraded.setRef('degraded-ref', { layers: [layer.header.id] });
      // persist() is fire-and-forget; give any stray IDB write a turn.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(putCalls, 0, 'a degraded store must not call IDBObjectStore.put at all');
    } finally {
      proto.put = originalPut;
    }

    // Corroborate via a fresh, real reopen: the layer written through the
    // degraded store must be absent from durable storage.
    const reopened = await BrowserLayerStore.open();
    assert.equal(
      reopened.hasLayer(layer.header.id),
      false,
      'a layer stored through a degraded store must not have reached IndexedDB',
    );
  });
});
