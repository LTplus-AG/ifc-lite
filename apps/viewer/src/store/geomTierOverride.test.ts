/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2544 — the stored `?geomTier=` override, end-to-end through the
 * window/localStorage-reading wrappers.
 *
 * `constants.test.ts` covers the resolution rule by injecting the override, so
 * it cannot catch the wrapper being unwired from the persisted value. These
 * tests exercise the real production path (`resolveLoadTessellationTier` reading
 * `getGeomTierOverride()` itself) with the globals stubbed, which is the only
 * way a regression in the *plumbing* fails a test rather than the *rule*.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearGeomTierOverride,
  getGeomTierOverride,
  resolveLoadTessellationTier,
  AUTO_LOW_TIER_MB,
  GEOM_TIER_STORAGE_KEY,
} from './constants.js';

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const savedLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

/** Install a fake `window.location.search` + `localStorage`; returns the store. */
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

describe('getGeomTierOverride (persistence)', () => {
  it('persists a URL param so a LATER plain load still resolves it', () => {
    // This stickiness is the whole hazard: one link visit governs every load
    // afterwards, with nothing in the URL to say so.
    const store = stub('?geomTier=low');
    assert.equal(getGeomTierOverride(), 'low');
    assert.equal(store.get(GEOM_TIER_STORAGE_KEY), 'low');

    stub('', { [GEOM_TIER_STORAGE_KEY]: 'low' });
    assert.equal(getGeomTierOverride(), 'low');
  });

  it('ignores a bogus tier rather than pinning garbage', () => {
    stub('?geomTier=ultra');
    assert.equal(getGeomTierOverride(), undefined);
  });

  it('?geomTier=auto clears the persisted override', () => {
    const store = stub('?geomTier=auto', { [GEOM_TIER_STORAGE_KEY]: 'low' });
    assert.equal(getGeomTierOverride(), undefined);
    assert.equal(store.has(GEOM_TIER_STORAGE_KEY), false);
  });
});

describe('clearGeomTierOverride', () => {
  it('drops the persisted override so the next load resolves automatically', () => {
    const store = stub('', { [GEOM_TIER_STORAGE_KEY]: 'lowest' });
    assert.equal(getGeomTierOverride(), 'lowest');
    clearGeomTierOverride();
    assert.equal(store.has(GEOM_TIER_STORAGE_KEY), false);
    assert.equal(getGeomTierOverride(), undefined);
  });

  it('does not throw when storage is blocked (Safari private mode)', () => {
    const throwing = {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      setItem: () => { throw new DOMException('blocked', 'SecurityError'); },
      removeItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    };
    Object.defineProperty(globalThis, 'window', {
      value: { location: { search: '' }, localStorage: throwing }, configurable: true, writable: true,
    });
    Object.defineProperty(globalThis, 'localStorage', { value: throwing, configurable: true, writable: true });
    assert.doesNotThrow(() => clearGeomTierOverride());
  });
});

describe('a pinned preview tier cannot govern an exact load (#2544)', () => {
  it('exact mode ignores a persisted low override on the real read path', () => {
    // The regression this exists for: `exact` promises "full boolean cuts +
    // full curve density", but a persisted `low` used to win, and `low` also
    // trips `quality_skips_small_cuts` in the Rust boolean processor — so the
    // model was meshed with coarse curves AND dropped sub-10% cutters while the
    // UI said Exact. Display, measure and export all read that geometry.
    stub('', { [GEOM_TIER_STORAGE_KEY]: 'low' });
    assert.equal(resolveLoadTessellationTier(76.73, 'exact'), undefined);
    assert.equal(resolveLoadTessellationTier(10, 'exact'), undefined);
  });

  it('exact mode keeps a persisted high override (pinning full density still works)', () => {
    stub('', { [GEOM_TIER_STORAGE_KEY]: 'high' });
    assert.equal(resolveLoadTessellationTier(200, 'exact'), 'high');
  });

  it('fast mode still honours a persisted low override over the size heuristic', () => {
    stub('', { [GEOM_TIER_STORAGE_KEY]: 'lowest' });
    assert.equal(resolveLoadTessellationTier(AUTO_LOW_TIER_MB, 'fast'), 'lowest');
  });

  it('clearing the override hands the exact load back to the engine default', () => {
    stub('', { [GEOM_TIER_STORAGE_KEY]: 'low' });
    clearGeomTierOverride();
    assert.equal(resolveLoadTessellationTier(76.73, 'exact'), undefined);
    // ...and the fast load back to the size heuristic rather than the pin.
    assert.equal(resolveLoadTessellationTier(76.73, 'fast'), 'low');
  });
});
