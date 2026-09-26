/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { ListDefinition } from '@ifc-lite/lists';
import { importListDefinition, loadListDefinitions, saveListDefinitions } from './persistence.js';

const STORAGE_KEY = 'ifc-lite-lists';

const legacy: ListDefinition = {
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

  it('loads a v1 list with Rules groups and an explicit unreadable legacy row (#5894)', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([legacy]));
    const [migrated] = loadListDefinitions();

    assert.equal(migrated.groups?.[0].rules[0].kind, 'property');
    assert.equal(migrated.groups?.[0].combinator, 'AND');
    assert.deepEqual(migrated.unreadableConditions, [
      { condition: legacy.conditions[1], reason: 'unsupported-source' },
    ]);
    assert.deepEqual(migrated.conditions, legacy.conditions, 'the old evaluator can still produce the same rows');

    saveListDefinitions([migrated]);
    assert.deepEqual(loadListDefinitions(), [migrated], 'round-trip does not duplicate groups or unreadable rows');
  });

  it('keeps neighboring saved lists visible when one v1 condition member is null (#5894)', () => {
    const damaged = { ...legacy, id: 'damaged', conditions: [null] };
    localStorage.setItem(STORAGE_KEY, JSON.stringify([damaged, legacy]));

    const loaded = loadListDefinitions();
    assert.equal(loaded.length, 2);
    assert.deepEqual(loaded[0], damaged, 'leave the damaged entry intact for recovery');
    assert.equal(loaded[1].groups?.[0].rules[0].kind, 'property');
  });

  it('imports the same v1 condition conversion from a .list.json file (#5894)', async () => {
    const file = new File([JSON.stringify(legacy)], 'saved.list.json', { type: 'application/json' });
    const imported = await importListDefinition(file);
    assert.equal(imported.groups?.[0].rules[0].kind, 'property');
    assert.equal(imported.unreadableConditions?.[0].reason, 'unsupported-source');
    assert.deepEqual(imported.conditions, legacy.conditions);
    const exportedJson = JSON.stringify(imported);
    const roundTrip = await importListDefinition(new File([exportedJson], 'round-trip.list.json', { type: 'application/json' }));
    assert.deepEqual(roundTrip.groups, imported.groups);
    assert.deepEqual(roundTrip.unreadableConditions, imported.unreadableConditions);
    assert.deepEqual(roundTrip.conditions, imported.conditions);
  });
});
