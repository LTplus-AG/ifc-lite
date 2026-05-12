/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcQuery } from '../src/ifc-query.js';
import { createMockStore, PropertyValueType } from './mock-store.js';

function makeStore() {
  return createMockStore({
    entities: [
      { expressId: 1, type: 'IFCWALL', globalId: 'w1', name: 'Wall 1' },
      { expressId: 2, type: 'IFCWALLSTANDARDCASE', globalId: 'w2', name: 'Wall 2' },
      { expressId: 3, type: 'IFCDOOR', globalId: 'd1', name: 'Door 1' },
      { expressId: 4, type: 'IFCWINDOW', globalId: 'win1', name: 'Window 1' },
      { expressId: 5, type: 'IFCSLAB', globalId: 's1', name: 'Slab 1' },
      { expressId: 6, type: 'IFCCOLUMN', globalId: 'c1', name: 'Column 1' },
      { expressId: 7, type: 'IFCBEAM', globalId: 'b1', name: 'Beam 1' },
      { expressId: 8, type: 'IFCSPACE', globalId: 'sp1', name: 'Space 1' },
    ],
    properties: [
      { entityId: 1, psetName: 'Pset_WallCommon', propName: 'IsExternal', propType: PropertyValueType.Boolean, value: true },
    ],
  });
}

describe('IfcQuery', () => {
  // ── Convenience type methods ──────────────────────────────────

  describe('convenience type methods', () => {
    it('walls() should return IfcWall and IfcWallStandardCase entities', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      const results = query.walls().execute();
      const ids = results.map(r => r.expressId).sort();
      expect(ids).toEqual([1, 2]);
    });

  });

  // ── Generic query methods ─────────────────────────────────────

  describe('generic query methods', () => {
    it('ofType() should filter by any type string', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      const results = query.ofType('IfcDoor', 'IfcWindow').execute();
      expect(results).toHaveLength(2);
      const ids = results.map(r => r.expressId).sort();
      expect(ids).toEqual([3, 4]);
    });

    it('all() should return all entities', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      const results = query.all().execute();
      expect(results).toHaveLength(8);
    });

    it('byId() should return entity by expressId', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      const results = query.byId(3).execute();
      expect(results).toHaveLength(1);
      expect(results[0].expressId).toBe(3);
    });
  });

  // ── Entity graph access ───────────────────────────────────────

  describe('entity()', () => {
    it('should return an EntityNode for the given expressId', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      const node = query.entity(1);
      expect(node.expressId).toBe(1);
      expect(node.name).toBe('Wall 1');
    });
  });

  // ── Hierarchy (no spatial hierarchy set up) ───────────────────


  // ── Spatial queries (require spatial index) ───────────────────

  describe('spatial queries without index', () => {
    it('inBounds should throw when spatial index is not available', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      expect(() => query.inBounds({ min: [0, 0, 0], max: [1, 1, 1] } as any)).toThrow(
        /Spatial index not available/,
      );
    });

    it('raycast should throw when spatial index is not available', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      expect(() => query.raycast([0, 0, 0], [1, 0, 0])).toThrow(
        /Spatial index not available/,
      );
    });

    it('onStorey should throw when spatial hierarchy is not available', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      expect(() => query.onStorey(4)).toThrow(/Spatial hierarchy not available/);
    });
  });

  // ── Chaining from convenience methods ─────────────────────────

  describe('chaining from convenience methods', () => {
    it('walls().limit(1) should return at most 1 wall', () => {
      const store = makeStore();
      const query = new IfcQuery(store as any);
      const results = query.walls().limit(1).execute();
      expect(results).toHaveLength(1);
    });

    it('all().whereProperty() should filter', () => {
      const store = createMockStore({
        entities: [
          { expressId: 1, type: 'IFCWALL', globalId: 'w1', name: 'Wall 1' },
          { expressId: 2, type: 'IFCDOOR', globalId: 'd1', name: 'Door 1' },
        ],
        properties: [
          { entityId: 1, psetName: 'Pset_WallCommon', propName: 'FireRating', propType: PropertyValueType.Label, value: 'REI60' },
        ],
      });
      const query = new IfcQuery(store as any);
      const results = query
        .all()
        .whereProperty('Pset_WallCommon', 'FireRating', '=', 'REI60')
        .execute();
      expect(results).toHaveLength(1);
      expect(results[0].expressId).toBe(1);
    });
  });

  // ── Empty store ───────────────────────────────────────────────

  describe('empty store', () => {
    it('all() on empty store should return no results', () => {
      const store = createMockStore();
      const query = new IfcQuery(store as any);
      expect(query.all().execute()).toEqual([]);
    });
  });
});
