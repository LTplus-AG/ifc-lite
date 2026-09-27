/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ListDefinition, PropertyCondition } from '@ifc-lite/lists';
import { importListDefinition, loadListDefinitions, saveListDefinitions } from './persistence.js';

const STORAGE_KEY = 'ifc-lite-lists';

const legacy: Omit<ListDefinition, 'groups'> & { conditions: PropertyCondition[] } = {
  id: 'v1', name: 'Saved walls', createdAt: 1, updatedAt: 2,
  entityTypes: [], columns: [],
  conditions: [
    { source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating', operator: 'equals', value: '2HR' },
    { source: 'zone', psetName: 'zones', propertyName: 'Zone', operator: 'equals', value: 'West' },
  ],
};

describe('list definitions persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a saved list back through load', () => {
    const defs: ListDefinition[] = [{
      id: 'a', name: 'A', createdAt: 1, updatedAt: 1, entityTypes: [], groups: [], columns: [],
    }];
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

  it('loads a v1 list with every condition as a Rules rule (#5894, #6190)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([legacy]));
    const [migrated] = loadListDefinitions();

    assert.equal(migrated.groups?.[0].rules[0].kind, 'property');
    assert.equal(migrated.groups?.[0].combinator, 'AND');
    assert.deepEqual(migrated.groups?.[0].rules[1], { kind: 'listCondition', ...legacy.conditions[1] });
    assert.equal(migrated.unreadableConditions, undefined);
    assert.equal('conditions' in migrated, false, 'the public definition no longer stores v1 conditions');

    saveListDefinitions([migrated]);
    assert.equal(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')[0].conditions, undefined);
    assert.deepEqual(loadListDefinitions(), [migrated], 'round-trip does not duplicate groups or unreadable rows');
  });

  it('migrates valid members beside malformed v1 conditions without hiding neighboring lists (#5894)', async () => {
    const damaged = { ...legacy, id: 'damaged', conditions: [legacy.conditions[0], null] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([damaged, legacy]));

    const loaded = loadListDefinitions();
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].groups?.[0].rules[0].kind, 'property');
    assert.deepEqual(loaded[0].unreadableConditions, [{ condition: null, reason: 'invalid-condition' }]);
    assert.equal('conditions' in loaded[0], false, 'keep the malformed row visible without retaining v1 fields');
    assert.equal(loaded[1].groups?.[0].rules[0].kind, 'property');

    const imported = await importListDefinition(new File([JSON.stringify(damaged)], 'mixed.list.json', { type: 'application/json' }));
    assert.deepEqual(imported.groups, loaded[0].groups);
    assert.deepEqual(imported.unreadableConditions, loaded[0].unreadableConditions);
  });

  it('skips a malformed whole entry without hiding the neighboring valid list (#5894)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([null, [], { id: 'x' },
      { ...legacy, groups: {} }, legacy]));
    const loaded = loadListDefinitions();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, legacy.id);
    assert.equal(loaded[0].groups?.[0].rules[0].kind, 'property');
  });

  it('keeps a list whose saved group holds an unreadable rule, with that rule visible (#6190)', async () => {
    const saved = { ...legacy, id: 'future', conditions: undefined, groups: [{ combinator: 'AND', rules: [null] }] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([saved]));
    const [loaded] = loadListDefinitions();
    assert.equal(loaded?.id, 'future', 'the list is not hidden');
    assert.deepEqual(loaded?.unreadableConditions, [{ condition: null, reason: 'invalid-condition' }]);
    const imported = await importListDefinition(new File([JSON.stringify(saved)], 'future.list.json', { type: 'application/json' }));
    assert.deepEqual(imported.unreadableConditions, loaded?.unreadableConditions);
  });

  it('rejects malformed import shapes instead of saving an unusable definition (#5894)', async () => {
    for (const malformed of [
      { id: 1, name: 2, entityTypes: {}, columns: {} },
      { ...legacy, groups: {} },
    ]) {
      await assert.rejects(importListDefinition(new File(
        [JSON.stringify(malformed)], 'bad.list.json', { type: 'application/json' },
      )), /Failed to parse list definition file/);
    }
  });

  it('imports the same v1 condition conversion from a .list.json file (#5894)', async () => {
    const file = new File([JSON.stringify(legacy)], 'saved.list.json', { type: 'application/json' });
    const imported = await importListDefinition(file);
    assert.deepEqual(imported.groups?.[0].rules.map((rule) => rule.kind), ['property', 'listCondition']);
    assert.equal(imported.unreadableConditions, undefined);
    assert.equal('conditions' in imported, false);
    const roundTrip = await importListDefinition(new File(
      [JSON.stringify(imported)], 'migrated.list.json', { type: 'application/json' },
    ));
    assert.deepEqual(roundTrip.groups, imported.groups);
    assert.deepEqual(roundTrip.unreadableConditions, imported.unreadableConditions);
    assert.equal('conditions' in roundTrip, false);
  });
});
