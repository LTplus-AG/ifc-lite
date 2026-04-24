/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { createSearchSlice, type SearchSlice } from './searchSlice.js';
import type { SearchResult } from '@/lib/search/tier0-scan';

function makeResult(modelId: string, expressId: number, name: string): SearchResult {
  return {
    modelId,
    expressId,
    typeName: 'IfcWall',
    name,
    globalId: `g${String(expressId).padStart(21, 'x')}`,
    description: '',
    objectType: '',
    matchField: 'name',
    score: 100,
  };
}

describe('searchSlice — vim cycle', () => {
  let store: StoreApi<SearchSlice>;
  const rs = (name: string, id: number): SearchResult => makeResult('m', id, name);

  beforeEach(() => {
    store = createStore<SearchSlice>((set, get, api) => createSearchSlice(set, get, api));
  });

  it('is inactive by default', () => {
    assert.strictEqual(store.getState().searchVimCycle, null);
  });

  it('enters with a frozen results snapshot and clamped index', () => {
    const results = [rs('a', 1), rs('b', 2), rs('c', 3)];
    store.getState().enterVimCycle('wall', results, 1);
    const cycle = store.getState().searchVimCycle;
    assert.ok(cycle);
    assert.strictEqual(cycle!.query, 'wall');
    assert.strictEqual(cycle!.index, 1);
    assert.strictEqual(cycle!.results, results, 'snapshot is the same reference');
  });

  it('clamps entry index into range', () => {
    const results = [rs('a', 1), rs('b', 2)];
    store.getState().enterVimCycle('w', results, 99);
    assert.strictEqual(store.getState().searchVimCycle!.index, 1);

    store.getState().enterVimCycle('w', results, -5);
    assert.strictEqual(store.getState().searchVimCycle!.index, 0);
  });

  it('no-ops when called with an empty results list', () => {
    store.getState().enterVimCycle('w', [], 0);
    assert.strictEqual(store.getState().searchVimCycle, null);
  });

  it('step +1 advances; step -1 retreats; both wrap around', () => {
    const results = [rs('a', 1), rs('b', 2), rs('c', 3)];
    store.getState().enterVimCycle('w', results, 0);

    store.getState().stepVimCycle(1);
    assert.strictEqual(store.getState().searchVimCycle!.index, 1);
    store.getState().stepVimCycle(1);
    assert.strictEqual(store.getState().searchVimCycle!.index, 2);
    store.getState().stepVimCycle(1);
    assert.strictEqual(store.getState().searchVimCycle!.index, 0, 'wraps forward');

    store.getState().stepVimCycle(-1);
    assert.strictEqual(store.getState().searchVimCycle!.index, 2, 'wraps backward');
  });

  it('step creates a new cycle object (for React change detection)', () => {
    const results = [rs('a', 1), rs('b', 2)];
    store.getState().enterVimCycle('w', results, 0);
    const first = store.getState().searchVimCycle;
    store.getState().stepVimCycle(1);
    const second = store.getState().searchVimCycle;
    assert.notStrictEqual(first, second, 'new object reference per step');
    assert.strictEqual(second!.results, first!.results, 'results snapshot is stable');
  });

  it('step is a no-op when inactive', () => {
    store.getState().stepVimCycle(1);
    assert.strictEqual(store.getState().searchVimCycle, null);
  });

  it('exits cleanly', () => {
    const results = [rs('a', 1), rs('b', 2)];
    store.getState().enterVimCycle('w', results, 0);
    store.getState().exitVimCycle();
    assert.strictEqual(store.getState().searchVimCycle, null);
  });

  it('typing breaks the cycle (setSearchQuery clears vimCycle)', () => {
    const results = [rs('a', 1), rs('b', 2)];
    store.getState().enterVimCycle('w', results, 0);
    store.getState().setSearchQuery('door');
    assert.strictEqual(store.getState().searchVimCycle, null);
  });

  it('resetSearch clears the cycle', () => {
    const results = [rs('a', 1), rs('b', 2)];
    store.getState().enterVimCycle('w', results, 0);
    store.getState().resetSearch();
    assert.strictEqual(store.getState().searchVimCycle, null);
  });

  it('closeSearch preserves the cycle (user can hit n/N after popover closes)', () => {
    const results = [rs('a', 1), rs('b', 2)];
    store.getState().enterVimCycle('w', results, 0);
    store.getState().closeSearch();
    assert.ok(store.getState().searchVimCycle, 'cycle still active after popover close');
  });
});

describe('searchSlice — advanced modal state', () => {
  let store: StoreApi<SearchSlice>;

  beforeEach(() => {
    store = createStore<SearchSlice>((set, get, api) => createSearchSlice(set, get, api));
  });

  it('modal is closed by default with "all" field filter and null model filter', () => {
    const s = store.getState();
    assert.strictEqual(s.searchModalOpen, false);
    assert.strictEqual(s.searchFieldFilter, 'all');
    assert.strictEqual(s.searchModelFilter, null);
  });

  it('setSearchModalOpen + toggleSearchModal flip the open flag', () => {
    store.getState().setSearchModalOpen(true);
    assert.strictEqual(store.getState().searchModalOpen, true);
    store.getState().toggleSearchModal();
    assert.strictEqual(store.getState().searchModalOpen, false);
    store.getState().toggleSearchModal();
    assert.strictEqual(store.getState().searchModalOpen, true);
  });

  it('setSearchFieldFilter updates the chip selection', () => {
    store.getState().setSearchFieldFilter('name');
    assert.strictEqual(store.getState().searchFieldFilter, 'name');
    store.getState().setSearchFieldFilter('all');
    assert.strictEqual(store.getState().searchFieldFilter, 'all');
  });

  it('toggleSearchModelFilter materialises the include set on first toggle', () => {
    const available = ['m1', 'm2', 'm3'];
    store.getState().toggleSearchModelFilter('m2', available);
    const filter = store.getState().searchModelFilter;
    assert.ok(filter);
    assert.deepStrictEqual(Array.from(filter!).sort(), ['m1', 'm3']);
  });

  it('toggleSearchModelFilter re-including the last excluded model collapses back to null', () => {
    const available = ['m1', 'm2'];
    store.getState().toggleSearchModelFilter('m1', available);
    // now filter is {m2}
    store.getState().toggleSearchModelFilter('m1', available);
    // user re-included m1 → all available included → collapse to null
    assert.strictEqual(store.getState().searchModelFilter, null);
  });

  it('toggleSearchModelFilter successive toggles on different models', () => {
    const available = ['a', 'b', 'c'];
    store.getState().toggleSearchModelFilter('a', available);
    store.getState().toggleSearchModelFilter('b', available);
    const filter = store.getState().searchModelFilter;
    assert.ok(filter);
    assert.deepStrictEqual(Array.from(filter!).sort(), ['c']);
  });

  it('clearSearchModelFilter resets to null', () => {
    const available = ['a', 'b', 'c'];
    store.getState().toggleSearchModelFilter('a', available);
    store.getState().clearSearchModelFilter();
    assert.strictEqual(store.getState().searchModelFilter, null);
  });
});
