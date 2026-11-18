/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `buildTabularDataStore` driven with tables no IFCX reader built: an IFC4
 * label, millimetres the file declares, properties and quantities with rows.
 * The IFCX caller is pinned separately in viewerModelIngest*.test.ts.
 */

import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PropertyValueType, QuantityType, iterateEffectiveEntities } from '@ifc-lite/data';
import { extractLengthUnitScale, isSourceBytes } from '@ifc-lite/parser';

import { PROXY_A, PROXY_B, WALL, tabularFixtureStore } from '@/test/tabular-store-fixture.js';

describe('buildTabularDataStore', () => {
  afterEach(() => mock.restoreAll());

  it('serves getEntity and getEntitiesByType from the entity table', () => {
    const store = tabularFixtureStore();

    assert.deepEqual(store.getEntity(WALL), { expressId: WALL, type: 'IfcWall', attributes: [] });
    assert.equal(store.getEntity(999), null, 'an id the table does not hold is not fabricated');

    const proxies = store.getEntitiesByType('IfcBuildingElementProxy');
    assert.deepEqual(proxies.map((entity) => entity.expressId), [PROXY_A, PROXY_B]);
    assert.equal(store.getEntitiesByType('IFCBUILDINGELEMENTPROXY').length, 2, 'type match ignores case');
    assert.deepEqual(store.getEntitiesByType('IfcDoor'), []);
  });

  it('answers properties from the property table rows', () => {
    const store = tabularFixtureStore();

    assert.deepEqual(store.getProperties(PROXY_A), [{
      name: 'Attribute User Text',
      globalId: '',
      properties: [
        { name: 'Supplier', type: PropertyValueType.Label, value: 'Acme' },
        { name: 'Phase', type: PropertyValueType.Label, value: 'Shell' },
      ],
    }]);
    assert.deepEqual(store.getProperties(PROXY_B), [], 'an entity without rows has no sets');
  });

  it('answers quantities from the quantity table rows', () => {
    const store = tabularFixtureStore();

    const sets = store.getQuantities(WALL);
    assert.equal(sets.length, 1);
    assert.equal(sets[0].name, 'Qto_WallBaseQuantities');
    assert.deepEqual(
      sets[0].quantities.map((quantity) => [quantity.name, quantity.type, quantity.value]),
      [['Length', QuantityType.Length, 4200], ['NetVolume', QuantityType.Volume, 2.52]],
    );
    assert.deepEqual(store.getQuantities(PROXY_A), []);
  });

  it('labels the store with the schema and unit source the caller states, not the IFCX ones', () => {
    const store = tabularFixtureStore();

    assert.equal(store.schemaVersion, 'IFC4');
    assert.equal(store.lengthUnitSource, 'declared');
    assert.equal(store.entityCount, 3, 'counted from the entity table');
  });

  it('answers the unit from source + entityIndex without the "No IFCPROJECT" warning', () => {
    const warn = mock.method(console, 'warn', () => undefined);
    const store = tabularFixtureStore();

    assert.equal(extractLengthUnitScale(store.source, store.entityIndex), 0.001);
    assert.equal(warn.mock.callCount(), 0);
  });

  it('marks the store tabular, so its rows are enumerated under any schema label', () => {
    const store = tabularFixtureStore();

    assert.equal(store.sourceKind, 'tabular');
    assert.deepEqual([...iterateEffectiveEntities(store, null)].map((e) => e.expressId), [PROXY_A, PROXY_B, WALL]);
    assert.deepEqual([...iterateEffectiveEntities(store, null, ['IFCWALL'])].map((e) => e.expressId), [WALL]);
  });

  it('keeps the file bytes behind the source accessor', () => {
    const bytes = new TextEncoder().encode('not STEP, not JSON');
    const store = tabularFixtureStore({ source: bytes.buffer as ArrayBuffer });

    assert.equal(isSourceBytes(store.source), true);
    assert.deepEqual(store.source.materialize(), bytes);
    assert.ok((store.source.contentKey ?? '').length > 0);
  });
});
