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

describe('searchSlice — SQL builder actions', () => {
  let store: StoreApi<SearchSlice>;

  beforeEach(() => {
    store = createStore<SearchSlice>((set, get, api) => createSearchSlice(set, get, api));
  });

  it('starts in builder mode with the empty builder state', () => {
    const s = store.getState();
    assert.strictEqual(s.searchSqlMode, 'builder');
    assert.strictEqual(s.searchSqlBuilder.ifcType, null);
    assert.deepStrictEqual(s.searchSqlBuilder.propertyFilters, []);
    assert.strictEqual(s.searchSqlBuilder.limit, 500);
  });

  it('setSearchSqlMode flips between builder and editor', () => {
    store.getState().setSearchSqlMode('editor');
    assert.strictEqual(store.getState().searchSqlMode, 'editor');
    store.getState().setSearchSqlMode('builder');
    assert.strictEqual(store.getState().searchSqlMode, 'builder');
  });

  it('setBuilderIfcType / setBuilderLimit patch the builder state', () => {
    store.getState().setBuilderIfcType('IfcWall');
    assert.strictEqual(store.getState().searchSqlBuilder.ifcType, 'IfcWall');
    store.getState().setBuilderLimit(100);
    assert.strictEqual(store.getState().searchSqlBuilder.limit, 100);
  });

  it('addBuilderFilter appends a new filter', () => {
    const f = {
      psetName: 'Pset_WallCommon',
      propName: 'IsExternal',
      op: '=' as const,
      valueType: 'bool' as const,
      value: 'true',
    };
    store.getState().addBuilderFilter(f);
    const filters = store.getState().searchSqlBuilder.propertyFilters;
    assert.strictEqual(filters.length, 1);
    assert.deepStrictEqual(filters[0], f);
  });

  it('updateBuilderFilter patches a filter by index', () => {
    const f = { psetName: 'A', propName: 'B', op: '=' as const, valueType: 'string' as const, value: '' };
    store.getState().addBuilderFilter(f);
    store.getState().updateBuilderFilter(0, { value: 'EI60' });
    const updated = store.getState().searchSqlBuilder.propertyFilters[0];
    assert.strictEqual(updated.value, 'EI60');
    assert.strictEqual(updated.propName, 'B');
  });

  it('updateBuilderFilter is a no-op for out-of-range indices', () => {
    const before = store.getState().searchSqlBuilder;
    store.getState().updateBuilderFilter(5, { value: 'x' });
    assert.strictEqual(store.getState().searchSqlBuilder, before);
  });

  it('removeBuilderFilter drops the filter at the given index', () => {
    const f1 = { psetName: 'A', propName: 'X', op: '=' as const, valueType: 'string' as const, value: '' };
    const f2 = { psetName: 'B', propName: 'Y', op: '=' as const, valueType: 'string' as const, value: '' };
    store.getState().addBuilderFilter(f1);
    store.getState().addBuilderFilter(f2);
    store.getState().removeBuilderFilter(0);
    const remaining = store.getState().searchSqlBuilder.propertyFilters;
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].psetName, 'B');
  });

  it('removeBuilderFilter is a no-op for out-of-range indices', () => {
    const before = store.getState().searchSqlBuilder;
    store.getState().removeBuilderFilter(2);
    assert.strictEqual(store.getState().searchSqlBuilder, before);
  });

  it('setSearchSqlBuilder replaces the whole builder state', () => {
    const newState = {
      ifcType: 'IfcDoor',
      propertyFilters: [],
      limit: 42,
    };
    store.getState().setSearchSqlBuilder(newState);
    assert.strictEqual(store.getState().searchSqlBuilder, newState);
  });
});
