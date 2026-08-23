/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import { createListSlice, type ListSlice } from './listSlice.js';
import type { ListDefinition } from '@ifc-lite/lists';

const STORAGE_KEY = 'ifc-lite-lists';

const makeStore = () => createStore<ListSlice>(createListSlice);

const def = (id: string): ListDefinition => ({
  id,
  name: `List ${id}`,
  entityTypes: ['IfcWall'],
  columns: [],
  createdAt: 1,
  updatedAt: 1,
} as unknown as ListDefinition);

describe('listSlice', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('deleteListDefinition clears activeListId/listResult only when deleting the ACTIVE list', () => {
    const s = makeStore();
    s.getState().setListDefinitions([def('a'), def('b')]);
    s.getState().setActiveListId('b');
    s.getState().setListResult({ rows: [], columns: [] } as never);

    // Deleting an unrelated list must not clear the currently active one.
    s.getState().deleteListDefinition('a');
    assert.strictEqual(s.getState().activeListId, 'b');
    assert.notStrictEqual(s.getState().listResult, null);
    assert.deepStrictEqual(s.getState().listDefinitions.map((d) => d.id), ['b']);

    // Deleting the active list DOES clear both, so the panel doesn't keep
    // pointing at a result for a definition that no longer exists.
    s.getState().deleteListDefinition('b');
    assert.strictEqual(s.getState().activeListId, null);
    assert.strictEqual(s.getState().listResult, null);
  });

  it('addListDefinition and deleteListDefinition persist to localStorage', () => {
    const s = makeStore();
    s.getState().addListDefinition(def('a'));
    let raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    assert.strictEqual(raw.length, 1);

    s.getState().deleteListDefinition('a');
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    assert.strictEqual(raw.length, 0);
  });

  it('updateListDefinition patches only the matching definition and bumps updatedAt', () => {
    const s = makeStore();
    s.getState().setListDefinitions([def('a'), def('b')]);
    s.getState().updateListDefinition('a', { name: 'Renamed' });
    const a = s.getState().listDefinitions.find((d) => d.id === 'a')!;
    const b = s.getState().listDefinitions.find((d) => d.id === 'b')!;
    assert.strictEqual(a.name, 'Renamed');
    assert.ok(a.updatedAt > 1);
    // The other definition is untouched, including its updatedAt.
    assert.strictEqual(b.name, 'List b');
    assert.strictEqual(b.updatedAt, 1);
  });

  it('recovers from a corrupt persisted entry instead of starting broken', () => {
    localStorage.setItem(STORAGE_KEY, 'not json');
    const s = makeStore();
    assert.deepStrictEqual(s.getState().listDefinitions, []);
    // The slice must still be usable - addListDefinition spreads
    // listDefinitions, which throws if the corrupt load ever returns a
    // non-array.
    assert.doesNotThrow(() => s.getState().addListDefinition(def('a')));
    assert.strictEqual(s.getState().listDefinitions.length, 1);
  });
});
