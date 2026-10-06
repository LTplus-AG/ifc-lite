/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * U02 (#6925) result selection invariants:
 *   - a prepared batch (`included`) never changes because a filter or the
 *     selection changed afterwards; only explicit include/exclude/clear do;
 *   - "select all" records whether it meant the loaded page or the whole
 *     matching population, and a complete-population action is enabled only
 *     once the authoritative keys have been retrieved;
 *   - an answer for an older population request is dropped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_SELECTION, canActOnPopulation, canActOnSelection, reduceSelection, type ResultSelection, type SelectionAction,
} from './selection-model.js';

const run = (...actions: SelectionAction[]): ResultSelection => actions.reduce(reduceSelection, EMPTY_SELECTION);
const keys = (set: ReadonlySet<string>) => [...set].sort();

// Deterministic population: 250 matching rows, of which the first 50 are loaded.
const POPULATION = Array.from({ length: 250 }, (_, i) => `row-${String(i).padStart(3, '0')}`);
const PAGE = POPULATION.slice(0, 50);

describe('result selection (U02, #6925)', () => {
  it('a prepared batch survives later filter and selection changes', () => {
    const prepared = run({ type: 'toggle', key: 'a' }, { type: 'toggle', key: 'b' }, { type: 'include' });
    assert.deepEqual(keys(prepared.included), ['a', 'b']);
    const later = [
      { type: 'populationChanged' },
      { type: 'toggle', key: 'c' },
      { type: 'selectPage', keys: ['x', 'y'] },
      { type: 'clear' },
    ] satisfies SelectionAction[];
    const after = later.reduce(reduceSelection, prepared);
    assert.deepEqual(keys(after.included), ['a', 'b'], 'nothing but include/exclude/clearBatch changes the batch');
    assert.deepEqual(keys(reduceSelection(after, { type: 'exclude', key: 'a' }).included), ['b']);
    assert.equal(reduceSelection(after, { type: 'clearBatch' }).included.size, 0);
  });

  it('select all on a partial page means the page, not the population', () => {
    const page = run({ type: 'selectPage', keys: PAGE });
    assert.deepEqual(page.selectAll, { scope: 'page', count: 50 });
    assert.equal(canActOnSelection(page), true, 'a page selection is a concrete set of keys');
    assert.equal(canActOnPopulation(page), false, 'a page is not the matching population');
  });

  it('select all on a complete page is already the authoritative population', () => {
    const all = run({ type: 'selectPage', keys: POPULATION, complete: true });
    assert.equal(canActOnPopulation(all), true);
    assert.equal(all.selected.size, 250);
  });

  it('complete-population actions wait for the retrieved keys', () => {
    const resolving = run({ type: 'selectPage', keys: PAGE }, { type: 'requestPopulation', total: 250 });
    assert.equal(canActOnPopulation(resolving), false, 'disabled while retrieving');
    assert.equal(canActOnSelection(resolving), false, 'the page-sized subset must not stand in for the population');
    assert.equal(reduceSelection(resolving, { type: 'include' }), resolving, 'nothing authoritative to pin yet');

    const request = resolving.requests;
    const resolved = reduceSelection(resolving, { type: 'populationResolved', request, keys: POPULATION });
    assert.equal(canActOnPopulation(resolved), true);
    assert.equal(resolved.selected.size, 250);
    assert.equal(reduceSelection(resolved, { type: 'include' }).included.size, 250);
  });

  it('a failed retrieval keeps population actions disabled', () => {
    const resolving = run({ type: 'requestPopulation', total: 250 });
    const failed = reduceSelection(resolving, { type: 'populationFailed', request: resolving.requests });
    assert.equal(failed.selectAll?.scope === 'population' && failed.selectAll.state, 'failed');
    assert.equal(canActOnPopulation(failed), false);
  });

  it('drops the answer to an older population request', () => {
    const first = run({ type: 'requestPopulation', total: 250 });
    const second = reduceSelection(first, { type: 'requestPopulation', total: 120 });
    const stale = reduceSelection(second, { type: 'populationResolved', request: first.requests, keys: POPULATION });
    assert.equal(stale, second, 'the older answer is ignored');
    const fresh = reduceSelection(second, { type: 'populationResolved', request: second.requests, keys: POPULATION.slice(0, 120) });
    assert.equal(fresh.selected.size, 120);
  });

  it('a filter change drops a select-all but keeps individual picks', () => {
    const picks = run({ type: 'toggle', key: 'a' }, { type: 'toggle', key: 'b' });
    assert.equal(reduceSelection(picks, { type: 'populationChanged' }), picks);
    const all = run({ type: 'selectPage', keys: POPULATION, complete: true });
    const changed = reduceSelection(all, { type: 'populationChanged' });
    assert.equal(changed.selected.size, 0, '"all 250 matching" no longer names the new population');
    assert.equal(changed.selectAll, null);
  });

  it('a pick after select all turns it into an individual selection', () => {
    const toggled = run({ type: 'selectPage', keys: PAGE }, { type: 'toggle', key: PAGE[0] });
    assert.equal(toggled.selectAll, null);
    assert.equal(toggled.selected.size, 49);
  });
});
