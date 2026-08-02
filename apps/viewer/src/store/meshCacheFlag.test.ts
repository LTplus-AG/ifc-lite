/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMeshCacheDecision,
  isMeshOnlyCacheEnabled,
  MESH_ONLY_CACHE_STORAGE_KEY,
} from './constants.js';

describe('resolveMeshCacheDecision (pure kill-switch logic)', () => {
  it('defaults ON when no URL param and no persisted kill switch (un-flagged default)', () => {
    assert.deepEqual(resolveMeshCacheDecision(null, null), { enabled: true });
  });

  it('stays ON when a legacy opt-in value ("1") is persisted', () => {
    assert.deepEqual(resolveMeshCacheDecision(null, '1'), { enabled: true });
  });

  it('is OFF only when the kill switch "0" is persisted', () => {
    assert.deepEqual(resolveMeshCacheDecision(null, '0'), { enabled: false });
  });

  it('?meshCache=0 disables AND persists the kill switch', () => {
    for (const v of ['0', 'false', 'off']) {
      assert.deepEqual(resolveMeshCacheDecision(v, null), { enabled: false, persist: '0' });
    }
  });

  it('?meshCache=1 re-enables AND clears the persisted kill switch', () => {
    for (const v of ['1', 'true', 'on']) {
      assert.deepEqual(resolveMeshCacheDecision(v, '0'), { enabled: true, clear: true });
    }
  });
});

// End-to-end through the window/localStorage-reading wrapper. Stubs the two
// globals it reads and restores them so no other test file is affected.
describe('isMeshOnlyCacheEnabled (window + localStorage)', () => {
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  function stub(search: string, initial: Record<string, string> = {}): Map<string, string> {
    const store = new Map<string, string>(Object.entries(initial));
    const localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    Object.defineProperty(globalThis, 'window', {
      value: { location: { search }, localStorage },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: localStorage,
      configurable: true,
      writable: true,
    });
    return store;
  }

  afterEach(() => {
    if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
    else delete (globalThis as Record<string, unknown>).window;
    if (savedLocalStorage) Object.defineProperty(globalThis, 'localStorage', savedLocalStorage);
    else delete (globalThis as Record<string, unknown>).localStorage;
  });

  it('is ON by default (no param, nothing persisted)', () => {
    stub('');
    assert.equal(isMeshOnlyCacheEnabled(), true);
  });

  it('stays OFF after ?meshCache=0 persisted the kill switch', () => {
    const store = stub('?meshCache=0');
    assert.equal(isMeshOnlyCacheEnabled(), false);
    assert.equal(store.get(MESH_ONLY_CACHE_STORAGE_KEY), '0');
    // A later plain load (no param) keeps the persisted kill switch → still OFF.
    stub('', { [MESH_ONLY_CACHE_STORAGE_KEY]: '0' });
    assert.equal(isMeshOnlyCacheEnabled(), false);
  });

  it('?meshCache=1 clears a persisted kill switch and re-enables', () => {
    const store = stub('?meshCache=1', { [MESH_ONLY_CACHE_STORAGE_KEY]: '0' });
    assert.equal(isMeshOnlyCacheEnabled(), true);
    assert.equal(store.has(MESH_ONLY_CACHE_STORAGE_KEY), false);
  });

  it('honours ?meshCache=0 even when storage is blocked (Safari private mode)', () => {
    // localStorage throws on access → the URL kill switch must still win, and a
    // plain load (no param) falls back to default-on.
    const throwing = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    const install = (search: string) => {
      Object.defineProperty(globalThis, 'window', {
        value: { location: { search }, localStorage: throwing }, configurable: true, writable: true,
      });
      Object.defineProperty(globalThis, 'localStorage', { value: throwing, configurable: true, writable: true });
    };
    install('?meshCache=0');
    assert.equal(isMeshOnlyCacheEnabled(), false, 'kill switch works without storage');
    install('');
    assert.equal(isMeshOnlyCacheEnabled(), true, 'defaults on without storage');
  });
});
