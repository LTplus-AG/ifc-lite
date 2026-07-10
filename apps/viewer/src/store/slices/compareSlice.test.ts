/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
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
