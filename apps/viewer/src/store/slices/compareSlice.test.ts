/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createCompareSlice, type CompareSlice } from './compareSlice.js';

// The slice persists the blacklist to localStorage guarded on `typeof window`,
// so under node:test (no `window`) persistence is a no-op and these tests cover
// the pure state logic - the same reducers the panel drives.
describe('CompareSlice - ignored-classes blacklist (#1470)', () => {
  let state: CompareSlice;
  let setState: (partial: Partial<CompareSlice> | ((s: CompareSlice) => Partial<CompareSlice>)) => void;

  beforeEach(() => {
    setState = (partial) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createCompareSlice(setState, () => state, {} as never);
  });

  it('starts empty (no window -> nothing persisted to load)', () => {
    assert.deepStrictEqual(state.compareExcludedTypes, []);
  });

  it('adds a class', () => {
    state.addCompareExcludedType('IfcOpeningElement');
    assert.deepStrictEqual(state.compareExcludedTypes, ['IfcOpeningElement']);
  });

  it('de-duplicates case-insensitively, keeping first-seen casing', () => {
    state.addCompareExcludedType('IfcOpeningElement');
    state.addCompareExcludedType('ifcopeningelement');
    state.addCompareExcludedType('  IFCOPENINGELEMENT  ');
    assert.deepStrictEqual(state.compareExcludedTypes, ['IfcOpeningElement']);
  });

  it('ignores blank / whitespace-only adds', () => {
    state.addCompareExcludedType('   ');
    state.addCompareExcludedType('');
    assert.deepStrictEqual(state.compareExcludedTypes, []);
  });

  it('a no-op add keeps the same array reference (no needless re-render/re-diff)', () => {
    state.addCompareExcludedType('IfcSpace');
    const before = state.compareExcludedTypes;
    state.addCompareExcludedType('ifcspace'); // already present
    assert.strictEqual(state.compareExcludedTypes, before);
  });

  it('removes a class case-insensitively', () => {
    state.setCompareExcludedTypes(['IfcSpace', 'IfcOpeningElement']);
    state.removeCompareExcludedType('ifcopeningelement');
    assert.deepStrictEqual(state.compareExcludedTypes, ['IfcSpace']);
  });

  it('a no-op remove keeps the same array reference', () => {
    state.setCompareExcludedTypes(['IfcSpace']);
    const before = state.compareExcludedTypes;
    state.removeCompareExcludedType('IfcWall'); // not present
    assert.strictEqual(state.compareExcludedTypes, before);
  });

  it('setCompareExcludedTypes de-dupes and drops blanks', () => {
    state.setCompareExcludedTypes(['IfcSpace', 'ifcspace', '  ', 'IfcWall']);
    assert.deepStrictEqual(state.compareExcludedTypes, ['IfcSpace', 'IfcWall']);
  });

  it('clears the whole blacklist', () => {
    state.setCompareExcludedTypes(['IfcSpace', 'IfcWall']);
    state.clearCompareExcludedTypes();
    assert.deepStrictEqual(state.compareExcludedTypes, []);
  });
});

// The content-matching toggle persists through `window.localStorage`, and the
// slice's persistence helpers early-return on `typeof window === 'undefined'`.
// Without a window the default/load branches are never reached at all, so a
// wrong default would sail through - these tests install a fake window so the
// real branch is the one under test.
describe('CompareSlice - content matching toggle (#1891)', () => {
  const KEY = 'ifc-lite:compare-match-by-content-v1';
  let storage: Map<string, string>;
  let failReads = false;

  function installWindow(): void {
    storage = new Map<string, string>();
    Reflect.set(globalThis, 'window', {
      localStorage: {
        getItem: (key: string) => {
          if (failReads) throw new Error('denied');
          return storage.get(key) ?? null;
        },
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      },
    });
  }

  function makeSlice(): CompareSlice {
    let state: CompareSlice;
    const setState = (partial: Partial<CompareSlice> | ((s: CompareSlice) => Partial<CompareSlice>)) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };
    state = createCompareSlice(setState, () => state, {} as never);
    return new Proxy({} as CompareSlice, { get: (_t, prop) => state[prop as keyof CompareSlice] });
  }

  beforeEach(() => {
    failReads = false;
    installWindow();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('defaults ON - a re-export otherwise reads as "everything deleted, everything added"', () => {
    assert.strictEqual(makeSlice().compareMatchByContent, true);
  });

  it('remembers an explicit opt-out', () => {
    storage.set(KEY, 'false');
    assert.strictEqual(makeSlice().compareMatchByContent, false);
  });

  it('remembers an explicit opt-in', () => {
    storage.set(KEY, 'true');
    assert.strictEqual(makeSlice().compareMatchByContent, true);
  });

  it('falls back to ON when the preference cannot be read', () => {
    failReads = true;
    assert.strictEqual(makeSlice().compareMatchByContent, true);
  });

  it('persists both directions through the setter', () => {
    const state = makeSlice();
    state.setCompareMatchByContent(false);
    assert.strictEqual(state.compareMatchByContent, false);
    assert.strictEqual(storage.get(KEY), 'false');
    state.setCompareMatchByContent(true);
    assert.strictEqual(state.compareMatchByContent, true);
    assert.strictEqual(storage.get(KEY), 'true');
  });
});
