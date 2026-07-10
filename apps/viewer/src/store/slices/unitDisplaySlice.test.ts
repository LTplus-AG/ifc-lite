/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createUnitDisplaySlice, type UnitDisplaySlice } from './unitDisplaySlice.js';

// Stub localStorage so the slice can read/write without browser env.
function installStubStorage(): { wipe: () => void } {
  const data = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    clear: () => data.clear(),
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
  } as Storage;
  return { wipe: () => data.clear() };
}

describe('UnitDisplaySlice', () => {
  let state: UnitDisplaySlice;
  let setState: (partial: Partial<UnitDisplaySlice> | ((s: UnitDisplaySlice) => Partial<UnitDisplaySlice>)) => void;
  let storage: { wipe: () => void };

  beforeEach(() => {
    storage = installStubStorage();
    storage.wipe();

    setState = (partial) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };
    state = createUnitDisplaySlice(setState as never, () => state, {} as never);
  });

  it('starts with no overrides', () => {
    assert.deepStrictEqual(state.unitDisplayOverrides, {});
  });

  it('sets an override for a unit type', () => {
    state.setUnitDisplayOverride('VOLUMETRICFLOWRATEUNIT', 'm3h');
    assert.strictEqual(state.unitDisplayOverrides.VOLUMETRICFLOWRATEUNIT, 'm3h');
  });

  it('clears an override when passed null, leaving other overrides intact', () => {
    state.setUnitDisplayOverride('VOLUMETRICFLOWRATEUNIT', 'm3h');
    state.setUnitDisplayOverride('LENGTHUNIT', 'mm');
    state.setUnitDisplayOverride('VOLUMETRICFLOWRATEUNIT', null);
    assert.strictEqual('VOLUMETRICFLOWRATEUNIT' in state.unitDisplayOverrides, false);
    assert.strictEqual(state.unitDisplayOverrides.LENGTHUNIT, 'mm');
  });

  it('resetUnitDisplayOverrides wipes every override', () => {
    state.setUnitDisplayOverride('VOLUMETRICFLOWRATEUNIT', 'm3h');
    state.setUnitDisplayOverride('LENGTHUNIT', 'mm');
    state.resetUnitDisplayOverrides();
    assert.deepStrictEqual(state.unitDisplayOverrides, {});
  });

  describe('persistence', () => {
    it('survives a fresh slice instantiation by round-tripping localStorage', () => {
      state.setUnitDisplayOverride('VOLUMETRICFLOWRATEUNIT', 'm3h');

      // Spin up a brand-new slice — it should pick up the saved override
      // without us threading state through ourselves.
      let s2: UnitDisplaySlice;
      const setState2: (p: never) => void = () => {};
      s2 = createUnitDisplaySlice(setState2 as never, () => s2, {} as never);
      assert.strictEqual(s2.unitDisplayOverrides.VOLUMETRICFLOWRATEUNIT, 'm3h');
    });

    it('discards a malformed persisted entry (non-string value) rather than throwing', () => {
      localStorage.setItem('ifc-lite:unit-display-overrides', JSON.stringify({ LENGTHUNIT: 42 }));
      let s2: UnitDisplaySlice;
      const setState2: (p: never) => void = () => {};
      s2 = createUnitDisplaySlice(setState2 as never, () => s2, {} as never);
      assert.deepStrictEqual(s2.unitDisplayOverrides, {});
    });
  });
});
