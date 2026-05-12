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
