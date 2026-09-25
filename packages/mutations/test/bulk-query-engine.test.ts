/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { PropertyValueType } from '@ifc-lite/data';
import { BulkQueryEngine, MutablePropertyView, MutationGuardError } from '../src/index.js';

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

/**
 * Regression: github.com/LTplus-AG/ifc-lite/issues/4238
 *
 * `select()` must fail closed (throw) when a globalIds/namePattern
 * restriction is requested but the string table (`strings`) is
 * unavailable, rather than silently dropping the filter and returning the
 * full unfiltered candidate set — which would let a caller's bulk edit
 * (e.g. SET_PROPERTY) apply to every entity in the model instead of the
 * intended narrow subset.
 */
describe('BulkQueryEngine: fail-closed globalIds/namePattern guard (#4238)', () => {
  function makeEngineNoStrings(count: number) {
    const entities = makeEntities(count);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    return new BulkQueryEngine(entities, view, null, null, null);
  }

  it('select() throws when a globalIds filter is requested without a string table', () => {
    const engine = makeEngineNoStrings(3);
    expect(() => engine.select({ globalIds: ['1234-guid'] })).toThrow(/globalIds/);
    expect(() => engine.select({ globalIds: ['1234-guid'] })).toThrow(
      /refusing to run an unscoped bulk selection/
    );
  });

  it('select() throws when a namePattern filter is requested without a string table', () => {
    const engine = makeEngineNoStrings(3);
    expect(() => engine.select({ namePattern: 'Wall.*' })).toThrow(/namePattern/);
    expect(() => engine.select({ namePattern: 'Wall.*' })).toThrow(
      /refusing to run an unscoped bulk selection/
    );
  });

  it('select() narrows correctly (does not throw) when a string table IS available', () => {
    const entities = makeEntities(3);
    // entity 1/2/3 -> globalId + name string indices 0/1/2, resolved via
    // the string table below.
    entities.globalId[0] = 0;
    entities.globalId[1] = 1;
    entities.globalId[2] = 2;
    entities.name[0] = 0;
    entities.name[1] = 1;
    entities.name[2] = 2;
    const strTable = ['GUID-Alpha', 'GUID-Beta', 'GUID-Gamma'];
    const strings = { get: (idx: number) => strTable[idx] };

    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, strings);

    // Guard doesn't fire (a string table is present), and the ordinary
    // narrowing behavior further down in select() still works: the
    // returned selection is a strict subset of the full candidate set,
    // not "reject/pass everything unconditionally".
    expect(() => engine.select({ globalIds: ['GUID-Beta'] })).not.toThrow();
    const byGlobalId = engine.select({ globalIds: ['GUID-Beta'] });
    expect(byGlobalId).toEqual([2]);
    expect(byGlobalId.length).toBeLessThan(3);

    expect(() => engine.select({ namePattern: 'Alpha' })).not.toThrow();
    const byName = engine.select({ namePattern: 'Alpha' });
    expect(byName).toEqual([1]);
    expect(byName.length).toBeLessThan(3);
  });
});

/**
 * `BulkQueryEngine.applyAction` writes straight to
 * `MutablePropertyView.setProperty`/`setEntityType`, bypassing the viewer
 * store's own actions and `canCollabEdit()` entirely (BulkPropertyEditor.tsx
 * constructs and drives this class directly — see mutation-guard.ts). These
 * tests prove the engine refuses a write on its own when constructed with a
 * `canEdit` predicate that returns false — without any caller having to
 * remember to check the role first.
 */
describe('BulkQueryEngine: local-edit guard (mutation-guard.ts)', () => {
  it('applyAction throws MutationGuardError and applies nothing when canEdit() is false', () => {
    const entities = makeEntities(1);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, null, () => false);

    expect(() =>
      engine.applyAction(1, {
        type: 'SET_PROPERTY',
        psetName: 'Pset_Test',
        propName: 'Prop',
        value: 42,
        valueType: PropertyValueType.Real,
      })
    ).toThrow(MutationGuardError);
    expect(view.getPropertyValue(1, 'Pset_Test', 'Prop')).toBeNull();
    expect(view.hasChanges()).toBe(false);
  });

  it('applyAction still applies when canEdit() is true (guard is opt-in, not a new default)', () => {
    const entities = makeEntities(1);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, null, () => true);

    const mutation = engine.applyAction(1, {
      type: 'SET_PROPERTY',
      psetName: 'Pset_Test',
      propName: 'Prop',
      value: 42,
      valueType: PropertyValueType.Real,
    });

    expect(mutation).not.toBeNull();
    expect(view.getPropertyValue(1, 'Pset_Test', 'Prop')).toBe(42);
  });

  it('an engine with no canEdit predicate behaves exactly as before (backward compatible)', () => {
    const entities = makeEntities(1);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, null);

    const mutation = engine.applyAction(1, {
      type: 'SET_PROPERTY',
      psetName: 'Pset_Test',
      propName: 'Prop',
      value: 42,
      valueType: PropertyValueType.Real,
    });

    expect(mutation).not.toBeNull();
    expect(view.getPropertyValue(1, 'Pset_Test', 'Prop')).toBe(42);
  });
});

/**
 * Regression for #5196: `select()` and `getAllEntityIds()` enumerated the
 * raw base `EntityTable` and never consulted the mutation view's
 * tombstones, so a deleted entity was selected, counted in the preview,
 * and written to by a bulk action — and the write survived
 * `restoreFromTombstone` (undo of the delete), because the tombstone check
 * lived nowhere in the enumeration.
 */
describe('BulkQueryEngine excludes tombstoned entities', () => {
  it('select({entityTypes}) — the fast path — excludes a deleted entity and its match count', () => {
    const entities = makeEntities(4); // ids 1,2,3,4, all typeEnum 10
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, null);

    expect(view.deleteEntity(2)).toBe(true);
    expect(view.isDeleted(2)).toBe(true);

    const ids = engine.select({ entityTypes: [10] });
    expect(ids).toEqual([1, 3, 4]);

    const preview = engine.preview({ select: { entityTypes: [10] }, action: { type: 'DELETE_PROPERTY', psetName: 'Pset_Bulk', propName: 'Flag' } });
    expect(preview.matchedCount).toBe(3);
    expect(preview.matchedEntityIds).not.toContain(2);
  });

  it('select({}) — the no-type-filter / getAllEntityIds path — excludes a deleted entity and its match count', () => {
    const entities = makeEntities(4);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, null);

    expect(view.deleteEntity(2)).toBe(true);

    const ids = engine.select({});
    expect(ids).toEqual([1, 3, 4]);

    const preview = engine.preview({ select: {}, action: { type: 'DELETE_PROPERTY', psetName: 'Pset_Bulk', propName: 'Flag' } });
    expect(preview.matchedCount).toBe(3);
    expect(preview.matchedEntityIds).not.toContain(2);
  });

  it('execute() does not write to a deleted entity, and the write does not survive restoreFromTombstone (issue repro)', () => {
    const entities = makeEntities(3); // ids 1,2,3
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, null);

    expect(view.deleteEntity(2)).toBe(true);

    const result = engine.execute({
      select: { entityTypes: [10] },
      action: {
        type: 'SET_PROPERTY',
        psetName: 'Pset_Bulk',
        propName: 'Flag',
        value: true,
        valueType: PropertyValueType.Boolean,
      },
    });

    expect(result.affectedEntityCount).toBe(2);
    expect(result.mutations.some((m) => m.entityId === 2)).toBe(false);

    // Undo the delete — the way the issue's repro did — and confirm the
    // deleted entity never picked up the bulk write in the first place.
    expect(view.restoreFromTombstone(2)).toBe(true);
    expect(view.isDeleted(2)).toBe(false);
    expect(view.getPropertyValue(2, 'Pset_Bulk', 'Flag')).toBeNull();
  });

  it('no-regression: live (non-deleted) entities are still selected, counted, and mutated exactly as before', () => {
    const entities = makeEntities(3);
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    const engine = new BulkQueryEngine(entities, view, null, null, null);

    // No deletions at all — full baseline behavior.
    expect(engine.select({ entityTypes: [10] })).toEqual([1, 2, 3]);
    expect(engine.select({})).toEqual([1, 2, 3]);

    const preview = engine.preview({ select: {}, action: { type: 'DELETE_PROPERTY', psetName: 'Pset_Bulk', propName: 'Flag' } });
    expect(preview.matchedCount).toBe(3);

    const result = engine.execute({
      select: { entityTypes: [10] },
      action: {
        type: 'SET_PROPERTY',
        psetName: 'Pset_Bulk',
        propName: 'Flag',
        value: true,
        valueType: PropertyValueType.Boolean,
      },
    });

    expect(result.affectedEntityCount).toBe(3);
    expect(view.getPropertyValue(1, 'Pset_Bulk', 'Flag')).toBe(true);
    expect(view.getPropertyValue(2, 'Pset_Bulk', 'Flag')).toBe(true);
    expect(view.getPropertyValue(3, 'Pset_Bulk', 'Flag')).toBe(true);
  });
});

/**
 * #5249: the other two directions of the #5196 enumeration defect. An entity
 * created this session has no EntityTable row, and a retyped entity's row
 * still carries its PARSED class. Both have to be answered from the overlay.
 */
describe('BulkQueryEngine selects the effective model (#5249)', () => {
  const IFC_WALL = 10;
  const IFC_COLUMN = 15;

  function session() {
    const entities = makeEntities(3); // ids 1,2,3, all IfcWall
    const strings = ['', 'guid-1', 'Wall 1', 'guid-2', 'Wall 2', 'guid-3', 'Wall 3'];
    for (let i = 0; i < 3; i++) {
      entities.globalId[i] = 1 + i * 2;
      entities.name[i] = 2 + i * 2;
    }
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    view.setExpressIdWatermark(3);
    const engine = new BulkQueryEngine(entities, view, null, null, { get: (i: number) => strings[i] ?? '' });
    return { view, engine };
  }

  it('an entity created this session is selected by type, untyped, by GlobalId and by name', () => {
    const { view, engine } = session();
    const created = view.createEntity('IfcWall', ['guid-new', null, 'New wall']).expressId;

    expect(engine.select({ entityTypes: [IFC_WALL] })).toEqual([1, 2, 3, created]);
    expect(engine.select({})).toEqual([1, 2, 3, created]);
    expect(engine.select({ globalIds: ['guid-new'] })).toEqual([created]);
    expect(engine.select({ namePattern: '^New' })).toEqual([created]);
  });

  it('a bulk write reaches a created entity', () => {
    const { view, engine } = session();
    const created = view.createEntity('IfcColumn', ['guid-c', null, 'Column']).expressId;
    const result = engine.execute({
      select: { entityTypes: [IFC_COLUMN] },
      action: { type: 'SET_PROPERTY', psetName: 'Pset_Bulk', propName: 'Flag', value: true, valueType: PropertyValueType.Boolean },
    });
    expect(result.mutations.map((m) => m.entityId)).toEqual([created]);
    expect(view.getPropertyValue(created, 'Pset_Bulk', 'Flag')).toBe(true);
  });

  it('a retyped entity is selected by its new class only', () => {
    const { view, engine } = session();
    view.setEntityType(2, 'IfcColumn', null, 'IfcWall');

    expect(engine.select({ entityTypes: [IFC_WALL] })).toEqual([1, 3]);
    expect(engine.select({ entityTypes: [IFC_COLUMN] })).toEqual([2]);
  });

  it('a queued Name edit is what namePattern matches', () => {
    const { view, engine } = session();
    view.setAttribute(3, 'Name', 'Renamed');
    expect(engine.select({ namePattern: '^Renamed$' })).toEqual([3]);
    expect(engine.select({ namePattern: '^Wall 3$' })).toEqual([]);
  });

  it('a created-then-deleted entity is selected nowhere', () => {
    const { view, engine } = session();
    const created = view.createEntity('IfcWall', ['guid-new', null, 'New wall']).expressId;
    view.deleteEntity(created);
    expect(engine.select({ entityTypes: [IFC_WALL] })).toEqual([1, 2, 3]);
    expect(engine.select({ globalIds: ['guid-new'] })).toEqual([]);
  });
});

/**
 * #5867: SET_ATTRIBUTE returned null for every entity, so a run reported
 * `success: true` with nothing written. It now writes the EXPRESS attribute
 * through the view, and an attribute the class does not declare fails.
 */
describe('BulkQueryEngine SET_ATTRIBUTE (#5867)', () => {
  function makeEngine(classes: Record<number, string>, schema?: 'IFC2X3' | 'IFC4') {
    const ids = Object.keys(classes).map(Number);
    const entities = { ...makeEntities(ids.length), getTypeName: (id: number) => classes[id] ?? 'Unknown' };
    const view = new MutablePropertyView(null, 'model-1');
    view.setOnDemandExtractor(() => []);
    return { engine: new BulkQueryEngine(entities, view, null, null, null, undefined, schema), view };
  }
  const setAttr = (attribute: string, ids: number[]) =>
    ({ select: { expressIds: ids }, action: { type: 'SET_ATTRIBUTE' as const, attribute, value: 'X' } });
  const attr = (view: MutablePropertyView, id: number, name: string) =>
    view.getAttributeMutationsForEntity(id).find((a) => a.name === name)?.value;

  it('writes Name on every selected wall and reports each entity', () => {
    const { engine, view } = makeEngine({ 1: 'IfcWall', 2: 'IfcWall' });
    const result = engine.execute({ select: { expressIds: [1, 2] }, action: { type: 'SET_ATTRIBUTE', attribute: 'Name', value: 'X' } });

    expect(result.success).toBe(true);
    expect(result.affectedEntityCount).toBe(2);
    expect(attr(view, 1, 'Name')).toBe('X');
    expect(attr(view, 2, 'Name')).toBe('X');
    expect(result.mutations.map((m) => [m.type, m.attributeName, m.newValue])).toEqual([
      ['UPDATE_ATTRIBUTE', 'Name', 'X'],
      ['UPDATE_ATTRIBUTE', 'Name', 'X'],
    ]);
  });

  it('records the overlay value it replaces, so undo can restore an earlier edit', () => {
    const { engine, view } = makeEngine({ 1: 'IfcWall' });
    view.setAttribute(1, 'ObjectType', 'EARLIER');
    const [mutation] = engine.execute({ select: { expressIds: [1] }, action: { type: 'SET_ATTRIBUTE', attribute: 'ObjectType', value: 'LATER' } }).mutations;
    expect(mutation.oldValue).toBe('EARLIER');
    expect(attr(view, 1, 'ObjectType')).toBe('LATER');
  });

  it('fails, not skips, an entity whose class lacks the attribute', () => {
    const { engine, view } = makeEngine({ 1: 'IfcWall', 2: 'IfcWallType' });
    const result = engine.execute({ select: { expressIds: [1, 2] }, action: { type: 'SET_ATTRIBUTE', attribute: 'ObjectType', value: 'X' } });

    expect(result.success).toBe(false);
    expect(result.affectedEntityCount).toBe(1);
    expect(result.errors).toEqual(['Entity 2: IfcWallType has no ObjectType attribute']);
    expect(attr(view, 2, 'ObjectType')).toBeUndefined();
  });

  it('refuses a name that is not a writable EXPRESS attribute once for the run (no lower-case aliases)', () => {
    const { engine, view } = makeEngine({ 1: 'IfcWall', 2: 'IfcWall' });
    const result = engine.execute(setAttr('name', [1, 2]));
    expect(result.success).toBe(false);
    expect(result.errors).toEqual(['"name" is not an attribute a bulk edit can set (Name, Description, ObjectType, Tag)']);
    expect(view.getAttributeMutationsForEntity(1)).toEqual([]);
    expect(() => engine.applyAction(1, setAttr('GlobalId', [1]).action)).toThrow(/not an attribute a bulk edit can set/);
  });

  it('writes Tag on an element and refuses it on a storey, which declares none', () => {
    const { engine, view } = makeEngine({ 1: 'IfcWall', 2: 'IfcBuildingStorey' });
    const result = engine.execute(setAttr('Tag', [1, 2]));
    expect(attr(view, 1, 'Tag')).toBe('X');
    expect(result.errors).toEqual(['Entity 2: IfcBuildingStorey has no Tag attribute']);
  });

  it("judges by the model's schema when it is known", () => {
    // IfcMaterial.Description exists from IFC4 on; IFC2X3 declares only Name.
    expect(makeEngine({ 1: 'IfcMaterial' }, 'IFC4').engine.execute(setAttr('Description', [1])).success).toBe(true);
    expect(makeEngine({ 1: 'IfcMaterial' }, 'IFC2X3').engine.execute(setAttr('Description', [1])).errors)
      .toEqual(['Entity 1: IfcMaterial has no Description attribute in IFC2X3']);
    // Unknown schema: refused unless every schema declares it.
    expect(makeEngine({ 1: 'IfcMaterial' }).engine.execute(setAttr('Description', [1])).success).toBe(false);
  });

  it("falls back to every schema when the model's own does not know the class, and refuses an unknown class", () => {
    // IfcGeotechnicalStratum is IFC4X3-only: an IFC4 model's table lacks it, like the exporter's fallback.
    expect(makeEngine({ 1: 'IfcGeotechnicalStratum' }, 'IFC4').engine.execute(setAttr('Name', [1])).success).toBe(true);
    expect(makeEngine({ 1: 'IfcSolidStratum' }, 'IFC4').engine.execute(setAttr('Name', [1])).errors)
      .toEqual(['Entity 1: IfcSolidStratum is not a class in the bundled IFC schemas, so Name cannot be checked']);
  });

  it('judges a created entity by its retype, not its authored class', () => {
    const { engine, view } = makeEngine({});
    const wall = view.createEntity('IfcWall', []).expressId;
    const wallType = view.createEntity('IfcWallType', []).expressId;
    view.setEntityType(wall, 'IfcWallType');
    view.setEntityType(wallType, 'IfcWall');
    const result = engine.execute(setAttr('ObjectType', [wall, wallType]));
    expect(result.errors).toEqual([`Entity ${wall}: IfcWallType has no ObjectType attribute`]);
    expect(attr(view, wallType, 'ObjectType')).toBe('X');
  });

  it('judges a retyped entity by its new class', () => {
    const { engine, view } = makeEngine({ 1: 'IfcWall' });
    view.setEntityType(1, 'IfcWallType');
    const result = engine.execute({ select: { expressIds: [1] }, action: { type: 'SET_ATTRIBUTE', attribute: 'ObjectType', value: 'X' } });
    expect(result.errors).toEqual(['Entity 1: IfcWallType has no ObjectType attribute']);
  });
});
