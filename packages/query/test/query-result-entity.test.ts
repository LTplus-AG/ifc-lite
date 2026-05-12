/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { QueryResultEntity } from '../src/query-result-entity.js';
import { createMockStore, PropertyValueType, QuantityType } from './mock-store.js';

function makeStore() {
  return createMockStore({
    entities: [
      { expressId: 1, type: 'IFCWALL', globalId: 'wall-guid-1', name: 'Test Wall' },
      { expressId: 2, type: 'IFCDOOR', globalId: 'door-guid-1', name: 'Test Door' },
    ],
    properties: [
      { entityId: 1, psetName: 'Pset_WallCommon', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: true },
      { entityId: 1, psetName: 'Pset_WallCommon', propName: 'FireRating', propType: PropertyValueType.Label, value: 'REI60' },
    ],
    quantities: [
      { entityId: 1, qsetName: 'Qto_WallBaseQuantities', quantityName: 'Length', quantityType: QuantityType.Length, value: 5.0 },
    ],
  });
}

describe('QueryResultEntity', () => {
  it('should expose expressId, globalId, name, and type', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 1);
    expect(entity.expressId).toBe(1);
    expect(entity.globalId).toBe('wall-guid-1');
    expect(entity.name).toBe('Test Wall');
    expect(entity.type).toBe('IfcWall');
  });

  it('should return properties from the store', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 1);
    const props = entity.properties;
    expect(props.length).toBeGreaterThan(0);
    const psetNames = props.map(p => p.name);
    expect(psetNames).toContain('Pset_WallCommon');
  });

  it('getProperty() should return a specific property value', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 1);
    expect(entity.getProperty('Pset_WallCommon', 'FireRating')).toBe('REI60');
  });

  it('getProperty() should return null for missing property', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 1);
    expect(entity.getProperty('Pset_WallCommon', 'NoSuchProp')).toBeNull();
  });

  it('should return quantities from the store', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 1);
    const qsets = entity.quantities;
    expect(qsets.length).toBe(1);
    expect(qsets[0].name).toBe('Qto_WallBaseQuantities');
  });

  it('should return empty quantities for entity with none', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 2);
    expect(entity.quantities).toEqual([]);
  });

  // ── asNode() ──────────────────────────────────────────────────

  it('asNode() should return an EntityNode with the same expressId', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 1);
    const node = entity.asNode();
    expect(node.expressId).toBe(1);
    expect(node.name).toBe('Test Wall');
  });

  // ── toJSON() ──────────────────────────────────────────────────

  it('toJSON() should return a serializable object', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 1);
    const json = entity.toJSON();
    expect(json).toHaveProperty('expressId', 1);
    expect(json).toHaveProperty('globalId', 'wall-guid-1');
    expect(json).toHaveProperty('name', 'Test Wall');
    expect(json).toHaveProperty('type', 'IfcWall');
    expect(json).toHaveProperty('properties');
  });

  // ─�� Edge cases ─��──────────────────────────────────────────────

  it('should return empty strings for non-existent entity', () => {
    const store = makeStore();
    const entity = new QueryResultEntity(store as any, 999);
    expect(entity.globalId).toBe('');
    expect(entity.name).toBe('');
    expect(entity.type).toBe('Unknown');
  });
});
