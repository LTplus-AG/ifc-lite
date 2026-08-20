/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadListDefinitions, saveListDefinitions } from './persistence.js';

const STORAGE_KEY = 'ifc-lite-lists';

describe('list definitions persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a saved list back through load', () => {
    const defs = [{ id: 'a', name: 'A' } as never];
    saveListDefinitions(defs);
    assert.deepStrictEqual(loadListDefinitions(), defs);
  });

  it('returns [] when nothing is stored', () => {
    assert.deepStrictEqual(loadListDefinitions(), []);
  });

  it('returns [] for corrupt (non-JSON) localStorage rather than throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json{');
    assert.doesNotThrow(() => loadListDefinitions());
    assert.deepStrictEqual(loadListDefinitions(), []);
  });

  it('returns [] for well-formed JSON that is not an array, so callers can still spread it', () => {
    // A hand-edited or half-written entry: valid JSON, but an object instead
    // of an array. `listSlice.addListDefinition` does
    // `[...get().listDefinitions, definition]` - if this ever comes back
    // as a non-array, that spread throws "is not iterable" on the very
    // first list the user tries to create, bricking the List panel at boot.
    localStorage.setItem(STORAGE_KEY, JSON.stringify({}));
    const defs = loadListDefinitions();
    assert.ok(Array.isArray(defs), 'expected an array even for object-shaped stored JSON');
    assert.doesNotThrow(() => [...defs, { id: 'x' } as never]);
  });

  it('returns [] for a stored JSON primitive (e.g. a stray number or string)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(42));
    const defs = loadListDefinitions();
    assert.ok(Array.isArray(defs));
  });
});
