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
import { PropertyValueType, QuantityType } from '@ifc-lite/data';
import { extractLengthUnitScale, isSourceBytes } from '@ifc-lite/parser';

import { PROXY_A, PROXY_B, WALL, tabularFixtureStore, tabularFixtureTables } from '@/test/tabular-store-fixture.js';
import { buildTabularDataStore } from './tabularDataStore.js';

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

  it('carries the schema, counts and unit the caller states, not IFCX defaults', () => {
    const store = tabularFixtureStore();

    assert.equal(store.schemaVersion, 'IFC4');
    assert.equal(store.entityCount, 3);
    assert.equal(store.fileSize, 4096);
    assert.equal(store.parseTime, 12);
    assert.equal(store.lengthUnitScale, 0.001);
    assert.equal(store.lengthUnitSource, 'declared');
    assert.equal(store.georeferencing, undefined);
  });

  it('answers the unit from source + entityIndex without the "No IFCPROJECT" warning', () => {
    const warn = mock.method(console, 'warn', () => undefined);
    const store = tabularFixtureStore();

    assert.equal(extractLengthUnitScale(store.source, store.entityIndex), 0.001);
    assert.equal(warn.mock.callCount(), 0);
  });

  it('keeps the file bytes behind the source accessor', () => {
    const bytes = new TextEncoder().encode('not STEP, not JSON');
    const store = buildTabularDataStore(tabularFixtureTables(), {
      schemaVersion: 'IFC4', source: bytes.buffer as ArrayBuffer, fileSize: bytes.byteLength,
      entityCount: 3, parseTime: 0, lengthUnitScale: 1, lengthUnitSource: 'declared',
    });

    assert.equal(isSourceBytes(store.source), true);
    assert.deepEqual(store.source.materialize(), bytes);
    assert.ok((store.source.contentKey ?? '').length > 0);
  });

  it('carries georeferencing the caller already resolved', () => {
    const georeferencing = { hasGeoreference: true, source: 'mapConversion' as const };
    const store = buildTabularDataStore(tabularFixtureTables(), {
      schemaVersion: 'IFC4', source: new ArrayBuffer(0), fileSize: 0,
      entityCount: 3, parseTime: 0, lengthUnitScale: 1, lengthUnitSource: 'declared', georeferencing,
    });

    assert.equal(store.georeferencing, georeferencing);
  });
});
