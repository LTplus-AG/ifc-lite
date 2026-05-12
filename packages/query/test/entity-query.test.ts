/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityQuery } from '../src/entity-query.js';
import { createMockStore, IfcTypeEnum, PropertyValueType } from './mock-store.js';

// ── Helpers ─────────────────────────────────────────────────────

function defaultEntities() {
  return [
    { expressId: 1, type: 'IFCWALL', globalId: 'wall-1', name: 'Exterior Wall A' },
    { expressId: 2, type: 'IFCWALL', globalId: 'wall-2', name: 'Interior Wall B' },
    { expressId: 3, type: 'IFCDOOR', globalId: 'door-1', name: 'Main Door' },
    { expressId: 4, type: 'IFCWINDOW', globalId: 'win-1', name: 'Window 1' },
    { expressId: 5, type: 'IFCSLAB', globalId: 'slab-1', name: 'Ground Floor Slab' },
  ];
}

function defaultProperties() {
  return [
    { entityId: 1, psetName: 'Pset_WallCommon', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: true },
    { entityId: 1, psetName: 'Pset_WallCommon', propName: 'ThermalTransmittance', propType: PropertyValueType.Real, value: 0.24 },
    { entityId: 2, psetName: 'Pset_WallCommon', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: false },
    { entityId: 3, psetName: 'Pset_DoorCommon', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: true },
    { entityId: 3, psetName: 'Pset_DoorCommon', propName: 'FireRating', propType: PropertyValueType.Label, value: 'EI30' },
  ];
}

function makeStore() {
  return createMockStore({
    entities: defaultEntities(),
    properties: defaultProperties(),
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe('EntityQuery', () => {
  // ── Type filtering ────────────────────────────────────────────

  describe('type filtering', () => {
    it('should return entities matching a single type', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, [IfcTypeEnum.IfcWall]);
      const results = query.execute();
      expect(results).toHaveLength(2);
      expect(results.map(r => r.expressId).sort()).toEqual([1, 2]);
    });

    it('should return entities matching multiple types', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, [IfcTypeEnum.IfcDoor, IfcTypeEnum.IfcWindow]);
      const results = query.execute();
      expect(results).toHaveLength(2);
      const ids = results.map(r => r.expressId).sort();
      expect(ids).toEqual([3, 4]);
    });

    it('should return all entities when typeFilter is null', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null);
      const results = query.execute();
      expect(results).toHaveLength(5);
    });

    it('should return empty array for type with no entities', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, [IfcTypeEnum.IfcBeam]);
      const results = query.execute();
      expect(results).toHaveLength(0);
    });
  });

  // ── ID filtering ──────────────────────────────────────────────

  describe('id filtering', () => {
    it('should return only entities with given IDs', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null, [1, 4]);
      const results = query.execute();
      expect(results).toHaveLength(2);
      expect(results.map(r => r.expressId).sort()).toEqual([1, 4]);
    });

    it('should return QueryResultEntity wrappers for non-existent IDs', () => {
      const store = makeStore();
      // IDs are passed through — QueryResultEntity uses lazy loading
      const query = new EntityQuery(store as any, null, [900, 901]);
      const results = query.execute();
      expect(results).toHaveLength(2);
    });
  });

  // ── Property filtering (whereProperty) ────────────────────────

  describe('whereProperty', () => {
    it('should filter by string property with equality', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null);
      query.whereProperty('Pset_DoorCommon', 'FireRating', '=', 'EI30');
      const results = query.execute();
      expect(results).toHaveLength(1);
      expect(results[0].expressId).toBe(3);
    });

    it('should filter by numeric comparison', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null);
      query.whereProperty('Pset_WallCommon', 'ThermalTransmittance', '>=', 0.2);
      const results = query.execute();
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.expressId === 1)).toBe(true);
    });

    it('should filter by string property with contains operator', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null);
      query.whereProperty('Pset_DoorCommon', 'FireRating', 'contains', 'EI');
      const results = query.execute();
      expect(results).toHaveLength(1);
      expect(results[0].expressId).toBe(3);
    });

    it('should return empty results when property does not match', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null);
      query.whereProperty('Pset_WallCommon', 'ThermalTransmittance', '>', 100);
      const results = query.execute();
      expect(results).toHaveLength(0);
    });

    it('should chain multiple property filters (AND logic)', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null);
      query
        .whereProperty('Pset_WallCommon', 'ThermalTransmittance', '>=', 0.2)
        .whereProperty('Pset_WallCommon', 'ThermalTransmittance', '<', 0.5);
      const results = query.execute();
      expect(results).toHaveLength(1);
      expect(results[0].expressId).toBe(1);
    });
  });

  // ── Limit & Offset ────────────────────────────────────────────

  describe('limit and offset', () => {
    it('should limit the number of results', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null).limit(2);
      const results = query.execute();
      expect(results).toHaveLength(2);
    });

    it('should offset results', () => {
      const store = makeStore();
      const all = new EntityQuery(store as any, null).execute();
      const offsetResults = new EntityQuery(store as any, null).offset(2).execute();
      expect(offsetResults).toHaveLength(all.length - 2);
      expect(offsetResults[0].expressId).toBe(all[2].expressId);
    });

    it('should combine limit and offset', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null).offset(1).limit(2);
      const results = query.execute();
      expect(results).toHaveLength(2);
    });

    it('should return empty array when offset exceeds results', () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null).offset(100);
      const results = query.execute();
      expect(results).toHaveLength(0);
    });

  });

  // ── Async helpers: ids(), count(), first() ────────────────────

  describe('async helpers', () => {
    it('ids() should return array of expressIds', async () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, [IfcTypeEnum.IfcWall]);
      const ids = await query.ids();
      expect(ids.sort()).toEqual([1, 2]);
    });

    it('count() should return the number of matching entities', async () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, null);
      const count = await query.count();
      expect(count).toBe(5);
    });

    it('count() with filter should return filtered count', async () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, [IfcTypeEnum.IfcDoor]);
      const count = await query.count();
      expect(count).toBe(1);
    });

    it('first() should return the first result', async () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, [IfcTypeEnum.IfcWall]);
      const first = await query.first();
      expect(first).not.toBeNull();
      expect(first!.expressId).toBe(1);
    });

    it('first() should return null when no results', async () => {
      const store = makeStore();
      const query = new EntityQuery(store as any, [IfcTypeEnum.IfcBeam]);
      const first = await query.first();
      expect(first).toBeNull();
    });
  });

  // ── Empty store ───────────────────────────────────────────────

  describe('empty store', () => {
    it('should return empty results from an empty store', () => {
      const store = createMockStore();
      const query = new EntityQuery(store as any, null);
      expect(query.execute()).toEqual([]);
    });
  });
});
