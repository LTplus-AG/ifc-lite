/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QueryBuilder, QueryInterface } from '../src/fluent-api.js';
import { EntityTable } from '../src/entity-table.js';
import { PropertyTable } from '../src/property-table.js';
import type { IfcEntity, EntityIndex } from '@ifc-lite/parser';

function makeEntity(expressId: number, type: string): IfcEntity {
  return { expressId, type, attributes: [] };
}

function setupFixtures() {
  const entities: IfcEntity[] = [
    makeEntity(1, 'IFCWALL'),
    makeEntity(2, 'IFCWALL'),
    makeEntity(3, 'IFCDOOR'),
    makeEntity(4, 'IFCWINDOW'),
  ];

  const entityMap = new Map(entities.map(e => [e.expressId, e]));
  const index: EntityIndex = {
    byId: new Map(entities.map(e => [e.expressId, { expressId: e.expressId, type: e.type, byteOffset: 0, byteLength: 0, lineNumber: 0 }])),
    byType: new Map<string, number[]>([
      ['IFCWALL', [1, 2]],
      ['IFCDOOR', [3]],
      ['IFCWINDOW', [4]],
    ]),
  };

  const entityTable = new EntityTable(entityMap, index);
  const propertyTable = new PropertyTable();

  // Add property sets
  const pset = {
    name: 'Pset_WallCommon',
    properties: new Map([
      ['IsExternal', { type: 'boolean' as const, value: true }],
    ]),
  };
  const pset2 = {
    name: 'Pset_WallCommon',
    properties: new Map([
      ['IsExternal', { type: 'boolean' as const, value: false }],
    ]),
  };
  propertyTable.addPropertySet(100, pset);
  propertyTable.addPropertySet(101, pset2);
  propertyTable.associatePropertySet(1, 100);
  propertyTable.associatePropertySet(2, 101);

  return { entityTable, propertyTable };
}

/**
 * Same as `setupFixtures`, but the door (id 3) also carries the SAME
 * pset/property/value as wall 2 (`Pset_WallCommon.IsExternal: false`). Used
 * only by the conjunction tests below: a filter chain that ANDs on type but
 * ORs (or drops) the property check would let this door leak into a
 * `.ofType('IFCWALL')` result, since the property half alone can't tell it
 * apart from wall 2.
 */
function setupOverlapFixture() {
  const fixtures = setupFixtures();
  fixtures.propertyTable.associatePropertySet(3, 101);
  return fixtures;
}

describe('QueryBuilder', () => {
  it('should return all entities when no filter is applied', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const builder = new QueryBuilder(entityTable, propertyTable);
    const results = builder.execute();
    expect(results).toHaveLength(4);
  });

  it('ofType() should filter entities by type', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const builder = new QueryBuilder(entityTable, propertyTable);
    const results = builder.ofType('IFCWALL').execute();
    expect(results).toHaveLength(2);
    expect(results.every(e => e.type === 'IFCWALL')).toBe(true);
  });

  it('ofType() should return empty for non-existent type', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const builder = new QueryBuilder(entityTable, propertyTable);
    const results = builder.ofType('IFCBEAM').execute();
    expect(results).toEqual([]);
  });

  it('withProperty() with value should filter by exact match', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const builder = new QueryBuilder(entityTable, propertyTable);
    const results = builder.withProperty('Pset_WallCommon', 'IsExternal', true).execute();
    expect(results).toHaveLength(1);
    expect(results[0].expressId).toBe(1);
  });

  it('withProperty() without value should filter for existence', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const builder = new QueryBuilder(entityTable, propertyTable);
    const results = builder.withProperty('Pset_WallCommon', 'IsExternal').execute();
    // Both wall 1 and wall 2 have IsExternal
    expect(results).toHaveLength(2);
  });

  it('withProperty() for non-existent property should return empty', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const builder = new QueryBuilder(entityTable, propertyTable);
    const results = builder.withProperty('NoSuchPset', 'NoSuchProp').execute();
    expect(results).toEqual([]);
  });

  it('should chain ofType and withProperty', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const builder = new QueryBuilder(entityTable, propertyTable);
    const results = builder
      .ofType('IFCWALL')
      .withProperty('Pset_WallCommon', 'IsExternal', false)
      .execute();
    expect(results).toHaveLength(1);
    expect(results[0].expressId).toBe(2);
  });

  it('withProperty(value) ANDs with the prior filter instead of replacing it', () => {
    // Door 3 shares wall 2's exact pset/property/value (see fixture comment).
    // Without the prior filter also required, `withProperty(..., false)` alone
    // matches {2, 3} and `.ofType('IFCWALL')` would wrongly include the door.
    const { entityTable, propertyTable } = setupOverlapFixture();
    const results = new QueryBuilder(entityTable, propertyTable)
      .ofType('IFCWALL')
      .withProperty('Pset_WallCommon', 'IsExternal', false)
      .execute();
    expect(results.map(e => e.expressId)).toEqual([2]);
    // Property side alone (no type filter) legitimately reaches the door too,
    // confirming the fixture actually creates the overlap this test relies on.
    const propertyOnly = new QueryBuilder(entityTable, propertyTable)
      .withProperty('Pset_WallCommon', 'IsExternal', false)
      .execute();
    expect(propertyOnly.map(e => e.expressId).sort()).toEqual([2, 3]);
  });

  it('withProperty(existence) ANDs with the prior filter instead of replacing it', () => {
    // Same overlap, but the value-less "does this property exist" branch.
    const { entityTable, propertyTable } = setupOverlapFixture();
    const results = new QueryBuilder(entityTable, propertyTable)
      .ofType('IFCWALL')
      .withProperty('Pset_WallCommon', 'IsExternal')
      .execute();
    // Both walls carry Pset_WallCommon.IsExternal; the door must not appear.
    expect(results.map(e => e.expressId).sort()).toEqual([1, 2]);
  });

  it('ofType() ANDs with a prior ofType(), so two disagreeing types match nothing', () => {
    // Every entity has exactly one type, so IFCWALL and IFCDOOR never agree.
    // A filter that overwrote rather than ANDed with the previous one would
    // answer this with whichever `ofType()` call ran last (the doors).
    const { entityTable, propertyTable } = setupOverlapFixture();
    const results = new QueryBuilder(entityTable, propertyTable)
      .ofType('IFCWALL')
      .ofType('IFCDOOR')
      .execute();
    expect(results).toEqual([]);
  });

});

describe('QueryInterface', () => {
  it('getEntity() should return an entity by id', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const iface = new QueryInterface(entityTable, propertyTable);
    const entity = iface.getEntity(1);
    expect(entity).not.toBeNull();
    expect(entity!.expressId).toBe(1);
  });

  it('getEntity() should return null for non-existent id', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const iface = new QueryInterface(entityTable, propertyTable);
    expect(iface.getEntity(999)).toBeNull();
  });

  it('getProperties() should return properties for an entity', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const iface = new QueryInterface(entityTable, propertyTable);
    const props = iface.getProperties(1);
    expect(props.size).toBe(1);
    expect(props.has('Pset_WallCommon')).toBe(true);
  });

  it('getProperties() should return empty map for entity without properties', () => {
    const { entityTable, propertyTable } = setupFixtures();
    const iface = new QueryInterface(entityTable, propertyTable);
    const props = iface.getProperties(3); // door with no associated psets
    expect(props.size).toBe(0);
  });
});
