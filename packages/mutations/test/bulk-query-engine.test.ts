/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkQueryEngine, MutablePropertyView } from '../src/index.js';

/**
 * BulkQueryEngine.select() with propertyFilters exercises the private
 * matchesFilter/filterByProperty operator branches. This is the core
 * selection predicate for bulk edits: a broken operator silently selects
 * the wrong entity set and mass-mutates entities the user never intended.
 */
function makeEntities(count: number) {
  const expressId = new Int32Array(count);
  const typeEnum = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    expressId[i] = i + 1;
    typeEnum[i] = 10;
  }
  return {
    count,
    expressId,
    typeEnum,
    globalId: new Int32Array(count),
    name: new Int32Array(count),
  } as any;
}

/** Build an engine whose entities each carry `value` under Pset_Test/Prop. */
function makeEngineWithProperty(values: Array<string | number | boolean | null>) {
  const entities = makeEntities(values.length);
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor(() => []);

  values.forEach((value, i) => {
    const entityId = i + 1;
    if (value === null) return; // leave unset -> property absent
    const valueType =
      typeof value === 'string'
        ? PropertyValueType.Label
        : typeof value === 'number'
          ? PropertyValueType.Real
          : PropertyValueType.Boolean;
    view.setProperty(entityId, 'Pset_Test', 'Prop', value, valueType);
  });

  const engine = new BulkQueryEngine(entities, view, null, null, null);
  return engine;
}

/**
 * Build an engine with 6 entities spread across a small disjoint spatial
 * hierarchy: sites 100/200, buildings 10/20 (one per site), storeys 1/2
 * (one per building), and a space 500 nested inside storey 1.
 *
 *   site 100 -> building 10 -> storey 1 -> entities 1, 2 (entity 1 also in space 500)
 *   site 200 -> building 20 -> storey 2 -> entities 3, 4
 *   entities 5, 6 are not registered under any spatial container.
 */
function makeEngineWithSpatialHierarchy() {
  const entities = makeEntities(6);
  const view = new MutablePropertyView(null, 'model-1');
  view.setOnDemandExtractor(() => []);

  const spatialHierarchy = {
    project: { expressId: 0, type: 0, name: 'Project', children: [], elements: [] },
    byStorey: new Map([
      [1, [1, 2]],
      [2, [3, 4]],
    ]),
    byBuilding: new Map([
      [10, [1, 2]],
      [20, [3, 4]],
    ]),
    bySite: new Map([
      [100, [1, 2]],
      [200, [3, 4]],
    ]),
    bySpace: new Map([[500, [1]]]),
    storeyElevations: new Map(),
    storeyHeights: new Map(),
    elementToStorey: new Map(),
  } as any;

  return new BulkQueryEngine(entities, view, spatialHierarchy, null, null);
}

describe('BulkQueryEngine spatial filters', () => {
  it('sites filters to entities contained in the given site IDs (disjoint sites)', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [100] });
    expect(ids).toEqual([1, 2]);
  });

  it('sites with a second site ID includes both sites disjoint sets', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [100, 200] });
    expect(ids).toEqual([1, 2, 3, 4]);
  });

  it('sites excludes entities outside the requested site (regression: previously ignored, returned everything)', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [200] });
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).toEqual([3, 4]);
  });

  it('an empty sites array is treated as no filter, matching the storeys/buildings/spaces sibling behavior', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [] });
    expect(ids).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a site ID absent from bySite matches nothing for that ID', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ sites: [999] });
    expect(ids).toEqual([]);
  });

  it('sites combined with storeys intersects (not unions) the two criteria', () => {
    const engine = makeEngineWithSpatialHierarchy();
    // site 100 -> {1,2}; storey 2 -> {3,4}; intersection is empty.
    const ids = engine.select({ sites: [100], storeys: [2] });
    expect(ids).toEqual([]);
    // site 100 -> {1,2}; storey 1 -> {1,2}; intersection is {1,2}.
    const idsMatching = engine.select({ sites: [100], storeys: [1] });
    expect(idsMatching).toEqual([1, 2]);
  });

  it('storeys filters to entities contained in the given storey IDs', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ storeys: [1] });
    expect(ids).toEqual([1, 2]);
  });

  it('buildings filters to entities contained in the given building IDs', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ buildings: [20] });
    expect(ids).toEqual([3, 4]);
  });

  it('spaces filters to entities contained in the given space IDs', () => {
    const engine = makeEngineWithSpatialHierarchy();
    const ids = engine.select({ spaces: [500] });
    expect(ids).toEqual([1]);
  });
});

describe('BulkQueryEngine property filter operators', () => {
  describe('string operators', () => {
    const engine = makeEngineWithProperty(['Alpha', 'Beta', 'Gamma', null]);

    it('= matches exact string', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 'Beta' }],
      });
      expect(ids).toEqual([2]);
    });

    it('!= excludes the exact match but keeps unset entities excluded too (value required)', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: 'Beta' }],
      });
      // Entity 4 has no property at all -> null value never matches non-null ops.
      expect(ids).toEqual([1, 3]);
    });

    it('CONTAINS is case-insensitive substring match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'CONTAINS', value: 'amm' }],
      });
      expect(ids).toEqual([3]);
    });

    it('STARTS_WITH is case-insensitive prefix match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'STARTS_WITH', value: 'al' }],
      });
      expect(ids).toEqual([1]);
    });

    it('ENDS_WITH is case-insensitive suffix match', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'ENDS_WITH', value: 'MA' }],
      });
      expect(ids).toEqual([3]);
    });

    it('IS_NULL selects only entities missing the property', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'IS_NULL' }],
      });
      expect(ids).toEqual([4]);
    });

    it('IS_NOT_NULL selects only entities that have the property', () => {
      const ids = engine.select({
        propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: 'IS_NOT_NULL' }],
      });
      expect(ids).toEqual([1, 2, 3]);
    });
  });

  describe('numeric operators', () => {
    const engine = makeEngineWithProperty([10, 20, 30]);

    it('= matches exact number', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 20 }] })
      ).toEqual([2]);
    });

    it('!= excludes the exact number', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: 20 }] })
      ).toEqual([1, 3]);
    });

    it('> selects strictly greater values', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>', value: 20 }] })
      ).toEqual([3]);
    });

    it('< selects strictly lesser values', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '<', value: 20 }] })
      ).toEqual([1]);
    });

    it('>= includes the boundary value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '>=', value: 20 }] })
      ).toEqual([2, 3]);
    });

    it('<= includes the boundary value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '<=', value: 20 }] })
      ).toEqual([1, 2]);
    });
  });

  describe('boolean operators', () => {
    const engine = makeEngineWithProperty([true, false, true]);

    it('= matches the boolean value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: true }] })
      ).toEqual([1, 3]);
    });

    it('!= matches the opposite boolean value', () => {
      expect(
        engine.select({ propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '!=', value: true }] })
      ).toEqual([2]);
    });

    it('= accepts a string "true"/"false" filter value (UI form input)', () => {
      expect(
        engine.select({
          propertyFilters: [{ psetName: 'Pset_Test', propName: 'Prop', operator: '=', value: 'false' as any }],
        })
      ).toEqual([2]);
    });
  });

  describe('multiple propertyFilters compose as AND', () => {
    // Two independent properties per entity so a fixture with only one
    // filter can't observe whether later filters actually narrow the
    // candidate set or silently replace it (`select()` applies each
    // filter in `criteria.propertyFilters` in sequence over the same
    // `candidates` array — a bug that used only the LAST filter would
    // pass every single-filter test above unnoticed).
    function makeEngineWithTwoProperties(rows: Array<[string, number]>) {
      const entities = makeEntities(rows.length);
      const view = new MutablePropertyView(null, 'model-1');
      view.setOnDemandExtractor(() => []);
      rows.forEach(([category, qty], i) => {
        const entityId = i + 1;
        view.setProperty(entityId, 'Pset_Test', 'Category', category, PropertyValueType.Label);
        view.setProperty(entityId, 'Pset_Test', 'Qty', qty, PropertyValueType.Real);
      });
      return new BulkQueryEngine(entities, view, null, null, null);
    }

    it('narrows on both conditions, not just the last one in the array', () => {
      const engine = makeEngineWithTwoProperties([
        ['A', 5], // entity 1: matches Category, fails Qty
        ['A', 15], // entity 2: matches both
        ['B', 15], // entity 3: fails Category, matches Qty
      ]);

      const ids = engine.select({
        propertyFilters: [
          { psetName: 'Pset_Test', propName: 'Category', operator: '=', value: 'A' },
          { psetName: 'Pset_Test', propName: 'Qty', operator: '>', value: 10 },
        ],
      });

      expect(ids).toEqual([2]);
    });
  });
});
