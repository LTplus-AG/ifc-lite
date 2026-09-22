/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTrackingStore } from './persistence.js';

class MemoryStorage {
  readonly store = new Map<string, string>();
  fail = false;
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.fail) throw new Error('QuotaExceededError');
    this.store.set(key, value);
  }
  removeItem(key: string): void { this.store.delete(key); }
}

const g = globalThis as { localStorage?: unknown };
const SET = { trackingKey: 'g/n', generation: 0, entries: { k: { globalId: 'G', digest: 'd' } }, nodeType: 't' };

describe('BrowserTrackingStore', () => {
  let ls: MemoryStorage;
  beforeEach(() => {
    ls = new MemoryStorage();
    g.localStorage = ls;
  });

  it('round-trips sets, lists keys, and deletes; a sidecar pinned elsewhere is not adopted', () => {
    const store = new BrowserTrackingStore('g', 'content:a');
    store.save(SET);
    assert.deepEqual(new BrowserTrackingStore('g', 'content:a').load('g/n'), SET);
    assert.deepEqual(new BrowserTrackingStore('g', 'content:a').keys(), ['g/n']);
    assert.equal(new BrowserTrackingStore('g', 'content:b').load('g/n'), undefined);
    store.delete('g/n');
    assert.deepEqual(new BrowserTrackingStore('g', 'content:a').keys(), []);
  });

  it('a sidecar whose sets are malformed reads as absent, so load() never hands the scheduler a non-set', () => {
    ls.setItem('ifc-lite-flow-tracking:g', JSON.stringify({ version: 1, pinnedTo: 'content:a', sets: { 'g/n': 'stale' } }));
    assert.equal(BrowserTrackingStore.read('g'), undefined);
    assert.equal(new BrowserTrackingStore('g', 'content:a').load('g/n'), undefined);
    ls.setItem('ifc-lite-flow-tracking:g', JSON.stringify({ version: 1, pinnedTo: 'content:a', sets: [] }));
    assert.equal(BrowserTrackingStore.read('g'), undefined);
  });

  it('a storage write that throws is recorded as persistError instead of propagating, and clears on the next good write', () => {
    const store = new BrowserTrackingStore('g', 'content:a');
    ls.fail = true;
    store.save(SET);
    assert.match(store.persistError ?? '', /QuotaExceededError/);
    assert.deepEqual(store.load('g/n'), SET, 'the in-memory set is still there for this run');
    ls.fail = false;
    store.save(SET);
    assert.equal(store.persistError, undefined);
  });
});
