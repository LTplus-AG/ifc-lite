/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
} from '@ifc-lite/data';
import { buildIfcxDataStore } from './viewerModelIngest.js';

/**
 * Build a minimal IFCX parse-result shape: a populated entity table (so the
 * entity-table-backed getEntity/getEntitiesByType have data) plus empty-but-valid
 * property/quantity tables (so getProperties/getQuantities resolve to the tables
 * rather than throwing — the original "this.store.getQuantities is not a function").
 */
function makeIfcxResult() {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(2, strings);
  entityBuilder.add(1, 'IfcWall', '', 'Wall A', '', '');
  entityBuilder.add(2, 'IfcSlab', '', 'Slab B', '', '');
  return {
    fileSize: 0,
    entityCount: 2,
    parseTime: 0,
    strings,
    entities: entityBuilder.build(),
    properties: new PropertyTableBuilder(strings).build(),
    quantities: new QuantityTableBuilder(strings).build(),
    relationships: new RelationshipGraphBuilder().build(),
  };
}

describe('buildIfcxDataStore (IFCX selection accessor path)', () => {
  it('wires getQuantities/getProperties so selecting an entity does not throw', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), new ArrayBuffer(0));

    // Regression: these were undefined on the IFCX store → TypeError on selection.
    assert.equal(typeof store.getQuantities, 'function');
    assert.equal(typeof store.getProperties, 'function');

    assert.ok(Array.isArray(store.getQuantities(1)), 'getQuantities returns an array');
    assert.ok(Array.isArray(store.getProperties(1)), 'getProperties returns an array');
  });

  it('serves getEntity from the populated IFCX entity table', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), new ArrayBuffer(0));

    const wall = store.getEntity(1);
    assert.ok(wall, 'known id resolves to an entity');
    assert.equal(wall!.expressId, 1);
    assert.equal(wall!.type, 'IfcWall');
    assert.deepEqual(wall!.attributes, [], 'IFCX has no STEP attribute list');

    assert.equal(store.getEntity(2)?.type, 'IfcSlab');
    assert.equal(store.getEntity(999), null, 'unknown id → null (not a fabricated entity)');
  });

  it('serves getEntitiesByType from the entity table, case-insensitively', () => {
    const store = buildIfcxDataStore(makeIfcxResult(), new ArrayBuffer(0));

    const walls = store.getEntitiesByType('IfcWall');
    assert.equal(walls.length, 1);
    assert.equal(walls[0].expressId, 1);

    assert.equal(store.getEntitiesByType('ifcwall').length, 1, 'type match is case-insensitive');
    assert.deepEqual(store.getEntitiesByType('IfcDoor'), [], 'absent type → empty list');
  });
});
