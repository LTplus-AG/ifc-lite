/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  loadRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
  __internal,
} from './recent-searches.js';

/** Minimal Storage surface that `recent-searches` actually calls. Keeping
 *  it narrow (no `length`, `clear`, `key`) is fine — the safeStorage()
 *  helper in the module under test only touches get/set/remove. We assign
 *  it via `unknown` so we don't have to stub the full DOM Storage API. */
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

const g = globalThis as { localStorage?: unknown };

describe('recent-searches', () => {
  beforeEach(() => {
    g.localStorage = new MemoryStorage();
  });

  it('returns an empty list when nothing is stored', () => {
    assert.deepStrictEqual(loadRecentSearches(), []);
  });

  it('records a committed query', () => {
    pushRecentSearch('wall');
    assert.deepStrictEqual(loadRecentSearches(), ['wall']);
  });

  it('ignores empty and whitespace-only queries', () => {
    pushRecentSearch('');
    pushRecentSearch('   ');
    assert.deepStrictEqual(loadRecentSearches(), []);
  });

  it('trims queries before storing them', () => {
    pushRecentSearch('   wall   ');
    assert.deepStrictEqual(loadRecentSearches(), ['wall']);
  });

  it('move-to-front dedupes repeated queries', () => {
    pushRecentSearch('wall');
    pushRecentSearch('door');
    pushRecentSearch('wall'); // move-to-front
    assert.deepStrictEqual(loadRecentSearches(), ['wall', 'door']);
  });

  it('caps the list at MAX_ENTRIES', () => {
    for (let i = 0; i < __internal.MAX_ENTRIES + 5; i++) {
      pushRecentSearch(`q-${i}`);
    }
    const list = loadRecentSearches();
    assert.strictEqual(list.length, __internal.MAX_ENTRIES);
    // Most-recent-first: the last insert is at the head.
    assert.strictEqual(list[0], `q-${__internal.MAX_ENTRIES + 4}`);
  });

  it('drops queries longer than MAX_QUERY_LEN', () => {
    const huge = 'x'.repeat(__internal.MAX_QUERY_LEN + 1);
    pushRecentSearch(huge);
    assert.deepStrictEqual(loadRecentSearches(), []);
  });

  it('clears the list on demand', () => {
    pushRecentSearch('wall');
    pushRecentSearch('door');
    clearRecentSearches();
    assert.deepStrictEqual(loadRecentSearches(), []);
  });

  it('gracefully recovers from malformed storage payloads', () => {
    (g.localStorage as MemoryStorageLike).setItem(__internal.STORAGE_KEY, '{not-an-array}');
    assert.deepStrictEqual(loadRecentSearches(), []);
    // Write should succeed after the malformed payload was auto-cleared.
    pushRecentSearch('wall');
    assert.deepStrictEqual(loadRecentSearches(), ['wall']);
  });

  it('returns an empty list when no localStorage is available', () => {
    delete g.localStorage;
    assert.deepStrictEqual(loadRecentSearches(), []);
    // Writes are silent no-ops.
    pushRecentSearch('wall');
    assert.deepStrictEqual(loadRecentSearches(), []);
  });

  it('returns an empty list when storage writes throw (sandbox/quota)', () => {
    const throwing: MemoryStorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {},
    };
    g.localStorage = throwing;
    // probe setItem will throw → safeStorage returns null → empty list.
    assert.deepStrictEqual(loadRecentSearches(), []);
  });
});
