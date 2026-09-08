/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import { IfcTypeEnum, QuantityType, RelationshipType, STOREY_ELEVATION_MATCH_TOLERANCE_M } from '@ifc-lite/data';
import { EntityQuery } from '@ifc-lite/query';
import { extractClassificationsOnDemand } from '@ifc-lite/parser';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { checkClassificationFacet } from '@ifc-lite/ids';
import { convertServerDataModel, type ServerParseResult } from './serverDataModel';

const parseResult: ServerParseResult = {
  cache_key: 'test',
  metadata: {
    schema_version: 'IFC4X3',
  },
  stats: {
    total_time_ms: 1,
    parse_time_ms: 1,
    geometry_time_ms: 0,
    total_vertices: 0,
    total_triangles: 0,
  },
};

describe('convertServerDataModel', () => {
  it('preserves IFC4.3 facility-part hierarchies from server spatial data', () => {
    const dataModel: DataModel = {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 1, type_name: 'IFCPROJECT', global_id: '0', name: 'Infra Project', has_geometry: false },
        { entity_id: 2, type_name: 'IFCBRIDGE', global_id: '1', name: 'Bridge A', has_geometry: false },
        { entity_id: 3, type_name: 'IFCBRIDGEPART', global_id: '2', name: 'Deck', has_geometry: false },
        { entity_id: 4, type_name: 'IFCWALL', global_id: '3', name: 'Barrier', has_geometry: true },
      ]),
      propertySets: new Map(),
      quantitySets: new Map(),
      relationships: [
        { rel_type: 'IFCRELAGGREGATES', relating_id: 1, related_id: 2 },
        { rel_type: 'IFCRELAGGREGATES', relating_id: 2, related_id: 3 },
        { rel_type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', relating_id: 3, related_id: 4 },
      ],
      classifications: [],
      materials: [],
      documents: [],
      spatialHierarchy: {
        nodes: [
          {
            entity_id: 1,
            parent_id: 0,
            level: 0,
            path: 'Infra Project',
            type_name: 'IFCPROJECT',
            name: 'Infra Project',
            children_ids: [2],
            element_ids: [],
          },
          {
            entity_id: 2,
            parent_id: 1,
            level: 1,
            path: 'Infra Project/Bridge A',
            type_name: 'IFCBRIDGE',
            name: 'Bridge A',
            children_ids: [3],
            element_ids: [],
          },
          {
            entity_id: 3,
            parent_id: 2,
            level: 2,
            path: 'Infra Project/Bridge A/Deck',
            type_name: 'IFCBRIDGEPART',
            name: 'Deck',
            children_ids: [],
            element_ids: [4],
          },
        ],
        project_id: 1,
        element_to_storey: new Map(),
        element_to_building: new Map([[4, 2]]),
        element_to_site: new Map(),
        element_to_space: new Map(),
      },
    };

    const dataStore = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);

    assert.equal(dataStore.spatialHierarchy?.project.children[0].type, IfcTypeEnum.IfcBridge);
    assert.equal(dataStore.spatialHierarchy?.project.children[0].children[0].type, IfcTypeEnum.IfcBridgePart);
    assert.deepEqual(dataStore.spatialHierarchy?.project.children[0].children[0].elements, [4]);
    assert.deepEqual(dataStore.spatialHierarchy?.getPath(4).map((node) => node.expressId), [1, 2, 3]);
    assert.deepEqual(dataStore.spatialHierarchy?.byBuilding.get(2), []);
  });

  it('uses the canonical parser relationship map for server relationships', () => {
    const dataModel: DataModel = {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 1, type_name: 'IFCPROJECT', global_id: '0', name: 'Project', has_geometry: false },
        { entity_id: 2, type_name: 'IFCBUILDING', global_id: '1', name: 'Building', has_geometry: false },
        { entity_id: 3, type_name: 'IFCDOCUMENTREFERENCE', global_id: '', name: 'Spec', has_geometry: false },
      ]),
      propertySets: new Map(),
      quantitySets: new Map(),
      relationships: [
        { rel_type: 'IFCRELNESTS', relating_id: 1, related_id: 2 },
        { rel_type: 'IFCRELASSOCIATESDOCUMENT', relating_id: 3, related_id: 2 },
      ],
      classifications: [],
      materials: [],
      documents: [],
      spatialHierarchy: {
        nodes: [
          {
            entity_id: 1,
            parent_id: 0,
            level: 0,
            path: 'Project',
            type_name: 'IFCPROJECT',
            name: 'Project',
            children_ids: [2],
            element_ids: [],
          },
          {
            entity_id: 2,
            parent_id: 1,
            level: 1,
            path: 'Project/Building',
            type_name: 'IFCBUILDING',
            name: 'Building',
            children_ids: [],
            element_ids: [],
          },
        ],
        project_id: 1,
        element_to_storey: new Map(),
        element_to_building: new Map(),
        element_to_site: new Map(),
        element_to_space: new Map(),
      },
    };

    const dataStore = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);

    assert.deepEqual(dataStore.relationships.getRelated(1, RelationshipType.Aggregates, 'forward'), [2]);
    assert.deepEqual(dataStore.relationships.getRelated(3, RelationshipType.AssociatesDocument, 'forward'), [2]);
  });

  it('materialises native property values and attaches type sets by type id (#1751)', () => {
    const dataModel: DataModel = {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 10, type_name: 'IFCWALL', global_id: 'w', name: 'W', has_geometry: true },
        { entity_id: 20, type_name: 'IFCWALLTYPE', global_id: 't', name: 'WT', has_geometry: false },
      ]),
      propertySets: new Map([
        [30, { pset_id: 30, pset_name: 'Pset_WallCommon', properties: [
          { property_name: 'IsExternal', property_value: 'true', property_type: 'boolean', data_type: 'IFCBOOLEAN' },
          { property_name: 'U', property_value: '0.24', property_type: 'real', data_type: 'IFCTHERMALTRANSMITTANCEMEASURE' },
          { property_name: 'Manufacturer', property_value: 'ACME', property_type: 'string', data_type: 'IFCLABEL' },
        ] }],
      ]),
      quantitySets: new Map(),
      relationships: [
        { rel_type: 'IFCRELDEFINESBYTYPE', relating_id: 20, related_id: 10 },
        { rel_type: 'TYPEHASPROPERTYSETS', relating_id: 30, related_id: 20 },
      ],
      spatialHierarchy: {
        nodes: [{ entity_id: 1, parent_id: 0, level: 0, path: 'P', type_name: 'IFCPROJECT', name: 'P', children_ids: [], element_ids: [] }],
        project_id: 1,
        element_to_storey: new Map(), element_to_building: new Map(), element_to_site: new Map(), element_to_space: new Map(),
      },
    } as unknown as DataModel;

    const store = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);

    // Element -> type resolves via the (previously dropped) DefinesByType edge.
    assert.deepEqual(store.relationships.getRelated(10, RelationshipType.DefinesByType, 'inverse'), [20]);

    // The type's HasPropertySets landed on the TYPE id, with NATIVE values +
    // the measure tag preserved (not the raw parquet string).
    const typePsets = store.properties.getForEntity(20);
    assert.equal(typePsets.length, 1);
    const props = typePsets[0].properties;
    const byName = (n: string) => props.find((p) => p.name === n)!;
    assert.equal(byName('IsExternal').value, true);
    assert.equal(byName('U').value, 0.24);
    assert.equal(byName('U').dataType, 'IFCTHERMALTRANSMITTANCEMEASURE');
    assert.equal(byName('Manufacturer').value, 'ACME');
    // TYPEHASPROPERTYSETS must NOT become a graph edge.
    assert.deepEqual(store.relationships.getRelated(20, RelationshipType.DefinesByProperties, 'forward'), []);
  });
  it('classifies IfcQuantityNumber as QuantityType.Number, not Count (#3266 sibling)', () => {
    // IFC4X3 added `IfcQuantityNumber`. The columnar parser's own
    // QUANTITY_TYPE_MAP already carries it (packages/parser's
    // columnar-parser-indexes.ts, fixed by #3266); this pins the server-hydrated
    // path's INDEPENDENT `mapQuantityType` switch, which must classify the
    // server's "number" quantity_type string the same way — not silently fall
    // through its `default` to Count, which is exactly the #3266 defect this
    // pins for the second, un-fixed implementation of the same mapping.
    const dataModel: DataModel = {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 10, type_name: 'IFCREINFORCINGBAR', global_id: 'r', name: 'Bar', has_geometry: false },
      ]),
      propertySets: new Map(),
      quantitySets: new Map([
        [30, {
          qset_id: 30,
          qset_name: 'Qto_ReinforcingBarBaseQuantities',
          quantities: [
            { quantity_name: 'BarCount', quantity_value: 12, quantity_type: 'number' },
          ],
        }],
      ]),
      relationships: [
        { rel_type: 'IFCRELDEFINESBYPROPERTIES', relating_id: 30, related_id: 10 },
      ],
      spatialHierarchy: {
        nodes: [{ entity_id: 1, parent_id: 0, level: 0, path: 'P', type_name: 'IFCPROJECT', name: 'P', children_ids: [], element_ids: [] }],
        project_id: 1,
        element_to_storey: new Map(), element_to_building: new Map(), element_to_site: new Map(), element_to_space: new Map(),
      },
    } as unknown as DataModel;

    const store = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);
    const qsets = store.quantities.getForEntity(10);
    assert.equal(qsets.length, 1);
    assert.equal(qsets[0].quantities[0].name, 'BarCount');
    assert.equal(qsets[0].quantities[0].type, QuantityType.Number, 'must classify as Number, not fall through to Count');
  });

  it('resolves storey by elevation with the same tolerance as the parser path (#1841)', () => {
    // Two storeys at 0m and 3m. The server-loaded path used to always snap to
    // the nearest storey, so a Z far above the building still resolved to the
    // top floor while the wasm/parser path correctly returned null.
    const storey = (entity_id: number, name: string, elevation: number) => ({
      entity_id,
      parent_id: 1,
      level: 1,
      path: `Project/${name}`,
      type_name: 'IFCBUILDINGSTOREY',
      name,
      elevation,
      children_ids: [],
      element_ids: [],
    });

    const dataModel: DataModel = {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 1, type_name: 'IFCPROJECT', global_id: '0', name: 'Project', has_geometry: false },
        { entity_id: 2, type_name: 'IFCBUILDINGSTOREY', global_id: '1', name: 'Level 0', has_geometry: false },
        { entity_id: 3, type_name: 'IFCBUILDINGSTOREY', global_id: '2', name: 'Level 1', has_geometry: false },
      ]),
      propertySets: new Map(),
      quantitySets: new Map(),
      relationships: [
        { rel_type: 'IFCRELAGGREGATES', relating_id: 1, related_id: 2 },
        { rel_type: 'IFCRELAGGREGATES', relating_id: 1, related_id: 3 },
      ],
      classifications: [],
      materials: [],
      documents: [],
      spatialHierarchy: {
        nodes: [
          {
            entity_id: 1,
            parent_id: 0,
            level: 0,
            path: 'Project',
            type_name: 'IFCPROJECT',
            name: 'Project',
            children_ids: [2, 3],
            element_ids: [],
          },
          storey(2, 'Level 0', 0),
          storey(3, 'Level 1', 3),
        ],
        project_id: 1,
        element_to_storey: new Map(),
        element_to_building: new Map(),
        element_to_site: new Map(),
        element_to_space: new Map(),
      },
    };

    const dataStore = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);
    const hierarchy = dataStore.spatialHierarchy!;

    // Exact and near matches resolve.
    assert.equal(hierarchy.getStoreyByElevation(0), 2);
    assert.equal(hierarchy.getStoreyByElevation(3), 3);
    assert.equal(hierarchy.getStoreyByElevation(3.4), 3);

    // Beyond the 1m band: no storey, rather than snapping to the closest.
    assert.equal(hierarchy.getStoreyByElevation(40), null);
    assert.equal(hierarchy.getStoreyByElevation(-25), null);

    // Exactly ON the boundary is out of range (exclusive comparison).
    assert.equal(hierarchy.getStoreyByElevation(3 + STOREY_ELEVATION_MATCH_TOLERANCE_M), null);
  });

  it('findByProperty honours relational operators, not just equality (issue #577 follow-up)', () => {
    // `store.properties.findByProperty(prop, operator, value, psetName)` is a
    // documented store API (docs/guide/querying.md, "Direct Data Access").
    // The server-converted table ignored `operator` and compared with `===`,
    // so `'>' 60` answered `= 60`: every relational query against a
    // server-loaded model returned only exact hits. It now routes through
    // `comparePropertyValues`, the same helper the columnar table uses.
    //
    // This is the DIRECT-API path. `EntityQuery.whereProperty` does not reach
    // it: `convertServerDataModel` reports `count: 0` on both tables, so the
    // query layer resolves through `store.getProperties` instead — covered
    // separately by the `whereProperty` test below.
    const dataModel = {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 10, type_name: 'IFCWALL', global_id: 'a', name: 'A', has_geometry: true },
        { entity_id: 11, type_name: 'IFCWALL', global_id: 'b', name: 'B', has_geometry: true },
      ]),
      propertySets: new Map([
        [30, { pset_id: 30, pset_name: 'Pset_WallCommon', properties: [
          { property_name: 'FireRating', property_value: '60', property_type: 'integer', data_type: 'IFCINTEGER' },
          { property_name: 'Reference', property_value: 'W-01', property_type: 'string', data_type: 'IFCLABEL' },
          { property_name: 'IsExternal', property_value: 'true', property_type: 'boolean', data_type: 'IFCBOOLEAN' },
        ] }],
        [31, { pset_id: 31, pset_name: 'Pset_WallCommon', properties: [
          { property_name: 'FireRating', property_value: '90', property_type: 'integer', data_type: 'IFCINTEGER' },
        ] }],
      ]),
      quantitySets: new Map(),
      relationships: [
        { rel_type: 'IFCRELDEFINESBYPROPERTIES', relating_id: 30, related_id: 10 },
        { rel_type: 'IFCRELDEFINESBYPROPERTIES', relating_id: 31, related_id: 11 },
      ],
      classifications: [],
      materials: [],
      documents: [],
      spatialHierarchy: {
        nodes: [{ entity_id: 1, parent_id: 0, level: 0, path: 'P', type_name: 'IFCPROJECT', name: 'P', children_ids: [], element_ids: [] }],
        project_id: 1,
        element_to_storey: new Map(),
        element_to_building: new Map(),
        element_to_site: new Map(),
        element_to_space: new Map(),
      },
    } as unknown as DataModel;

    const store = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);
    const find = (op: string, value: unknown) =>
      store.properties.findByProperty('FireRating', op, value as never, 'Pset_WallCommon').sort();

    // Equality was the only operator that ever worked; keep it as the control.
    assert.deepEqual(find('=', 60), [10]);
    // Relational operators used to answer as if they were `=`.
    assert.deepEqual(find('>', 60), [11]);
    assert.deepEqual(find('>=', 60), [10, 11]);
    assert.deepEqual(find('<', 90), [10]);
    assert.deepEqual(find('!=', 60), [11]);
    // String operators, likewise.
    assert.deepEqual(
      store.properties.findByProperty('Reference', 'startsWith', 'W-', 'Pset_WallCommon'),
      [10],
    );
    assert.deepEqual(
      store.properties.findByProperty('Reference', 'contains', '-01', 'Pset_WallCommon'),
      [10],
    );
    // No coercion: the string '60' does not match the integer 60.
    assert.deepEqual(find('=', '60'), []);
    // Booleans compare as booleans.
    assert.deepEqual(
      store.properties.findByProperty('IsExternal', '=', true, 'Pset_WallCommon'),
      [10],
    );
  });

  it('whereProperty filters a server-converted store through the on-demand path (#577)', () => {
    // The transition this pins: `convertServerDataModel` reports `count: 0` on
    // both tables, so `EntityQuery.applyPropertyFilters` classifies a
    // server-loaded model as on-demand and resolves candidates through
    // `store.getProperties` / `store.getQuantities` — NOT through the table's
    // `findByProperty`, which it used to call. Nothing else exercises that
    // re-route, so a regression to the table path (or a `getForEntity` that
    // stopped agreeing with `findByProperty`) would otherwise go unnoticed.
    const dataModel = {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 10, type_name: 'IFCWALL', global_id: 'a', name: 'A', has_geometry: true },
        { entity_id: 11, type_name: 'IFCWALL', global_id: 'b', name: 'B', has_geometry: true },
        { entity_id: 12, type_name: 'IFCWALL', global_id: 'c', name: 'C', has_geometry: true },
      ]),
      propertySets: new Map([
        [30, { pset_id: 30, pset_name: 'Pset_WallCommon', properties: [
          { property_name: 'FireRating', property_value: '60', property_type: 'integer', data_type: 'IFCINTEGER' },
        ] }],
        [31, { pset_id: 31, pset_name: 'Pset_WallCommon', properties: [
          { property_name: 'FireRating', property_value: '90', property_type: 'integer', data_type: 'IFCINTEGER' },
        ] }],
      ]),
      quantitySets: new Map([
        [40, { qset_id: 40, qset_name: 'Qto_WallBaseQuantities', quantities: [
          { quantity_name: 'NetSideArea', quantity_value: 12.5, quantity_type: 'area' },
        ] }],
      ]),
      relationships: [
        { rel_type: 'IFCRELDEFINESBYPROPERTIES', relating_id: 30, related_id: 10 },
        { rel_type: 'IFCRELDEFINESBYPROPERTIES', relating_id: 31, related_id: 11 },
        { rel_type: 'IFCRELDEFINESBYPROPERTIES', relating_id: 40, related_id: 12 },
      ],
      classifications: [],
      materials: [],
      documents: [],
      spatialHierarchy: {
        nodes: [{ entity_id: 1, parent_id: 0, level: 0, path: 'P', type_name: 'IFCPROJECT', name: 'P', children_ids: [], element_ids: [] }],
        project_id: 1,
        element_to_storey: new Map(),
        element_to_building: new Map(),
        element_to_site: new Map(),
        element_to_space: new Map(),
      },
    } as unknown as DataModel;

    const store = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);

    // The discriminator that selects the on-demand strategy.
    assert.equal(store.properties.count, 0);
    assert.equal(store.quantities.count, 0);

    // Assert the table path is genuinely not taken, so this test cannot pass
    // by the query layer quietly reverting to `findByProperty`.
    let findByPropertyCalls = 0;
    const realFindByProperty = store.properties.findByProperty.bind(store.properties);
    store.properties.findByProperty = (...args: Parameters<typeof realFindByProperty>) => {
      findByPropertyCalls++;
      return realFindByProperty(...args);
    };

    const idsOf = (q: EntityQuery) => q.execute().map((e) => e.expressId).sort((a, b) => a - b);

    // Relational operator across two entities: the bug this PR fixes would
    // return [] here (empty table), and a `===`-only comparison would return [].
    assert.deepEqual(
      idsOf(new EntityQuery(store, null, [10, 11, 12]).whereProperty('Pset_WallCommon', 'FireRating', '>', 60)),
      [11],
    );
    assert.deepEqual(
      idsOf(new EntityQuery(store, null, [10, 11, 12]).whereProperty('Pset_WallCommon', 'FireRating', '>=', 60)),
      [10, 11],
    );
    // Quantity sets resolve through `getQuantities` on the same call.
    assert.deepEqual(
      idsOf(new EntityQuery(store, null, [10, 11, 12]).whereProperty('Qto_WallBaseQuantities', 'NetSideArea', '>', 10)),
      [12],
    );
    // An entity with no property sets never matches, not even with `!=`.
    assert.deepEqual(
      idsOf(new EntityQuery(store, null, [10, 11, 12]).whereProperty('Pset_WallCommon', 'FireRating', '!=', 60)),
      [11],
    );

    assert.equal(findByPropertyCalls, 0, 'server store must not take the columnar table path');
  });
});

describe('convertServerDataModel classification wiring (#3955)', () => {
  /**
   * Build a realistic server DataModel: a wall (4) associated to an
   * IfcClassificationReference (100) which the server has already resolved
   * (system/identification/name walked server-side, per
   * apps/server/src/services/data_model/classifications.rs), a second wall
   * (5) with NO classification at all (control), plus the general
   * IFCRELASSOCIATESCLASSIFICATION relationship edge the server always emits
   * regardless of the dedicated `classifications` field.
   */
  function buildClassifiedDataModel(includeClassifications: boolean): DataModel {
    return {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 1, type_name: 'IFCPROJECT', global_id: 'p', name: 'Project', has_geometry: false },
        { entity_id: 4, type_name: 'IFCWALL', global_id: 'w-classified', name: 'Classified Wall', has_geometry: true },
        { entity_id: 5, type_name: 'IFCWALL', global_id: 'w-plain', name: 'Plain Wall', has_geometry: true },
        { entity_id: 100, type_name: 'IFCCLASSIFICATIONREFERENCE', global_id: '', name: 'EF_25_10', has_geometry: false },
      ]),
      propertySets: new Map(),
      quantitySets: new Map(),
      relationships: [
        // The server emits this edge unconditionally (relationships.rs), so
        // the relationship graph proves entity 4 is classified independent
        // of whether `classifications` below is populated.
        { rel_type: 'IFCRELASSOCIATESCLASSIFICATION', relating_id: 100, related_id: 4 },
      ],
      classifications: includeClassifications
        ? [
            {
              element_id: 4,
              system_name: 'Uniclass 2015',
              identification: 'EF_25_10',
              name: 'Walls',
              location: undefined,
            },
          ]
        : [],
      materials: [],
      documents: [],
      spatialHierarchy: {
        nodes: [
          { entity_id: 1, parent_id: 0, level: 0, path: 'Project', type_name: 'IFCPROJECT', name: 'Project', children_ids: [], element_ids: [4, 5] },
        ],
        project_id: 1,
        element_to_storey: new Map(),
        element_to_building: new Map(),
        element_to_site: new Map(),
        element_to_space: new Map(),
      },
    };
  }

  const systemFacet = {
    type: 'classification' as const,
    system: { type: 'simpleValue' as const, value: 'Uniclass 2015' },
  };

  it('resolves a system-constrained classification facet from DataModel.classifications on a server-parsed store', () => {
    const store = convertServerDataModel(buildClassifiedDataModel(true), parseResult, { size: 1 }, []);

    // extractClassificationsOnDemand — the parser primitive the IDS bridge
    // and the properties panel both call — now returns the server-resolved
    // attributes instead of [] (no source bytes to decode from directly).
    const info = extractClassificationsOnDemand(store, 4);
    assert.equal(info.length, 1);
    assert.equal(info[0].system, 'Uniclass 2015');
    assert.equal(info[0].identification, 'EF_25_10');

    // End-to-end through the real IDS bridge + facet checker (not a
    // hand-built accessor): a system-constrained facet now PASSES instead of
    // reporting the entity as unclassified.
    const accessor = createDataAccessor(store);
    const result = checkClassificationFacet(systemFacet, 4, accessor);
    assert.equal(result.passed, true);
  });

  it('control: a genuinely unclassified entity still reports CLASSIFICATION_MISSING, distinguishably', () => {
    const store = convertServerDataModel(buildClassifiedDataModel(true), parseResult, { size: 1 }, []);
    const accessor = createDataAccessor(store);

    const result = checkClassificationFacet(systemFacet, 5, accessor);
    assert.equal(result.passed, false);
    assert.equal(result.failure?.type, 'CLASSIFICATION_MISSING');
  });

  it('mutation: dropping DataModel.classifications from the payload reverts to CLASSIFICATION_UNRESOLVED, never a false pass', () => {
    // The relationship graph edge (IFCRELASSOCIATESCLASSIFICATION) is still
    // present — the graph proves entity 4 IS classified — but the resolved
    // attribute payload is empty, as it would be from an older server/cache
    // that predates the `classifications` field. This must not silently
    // manufacture a passing result for data that never arrived, and — since
    // #3951 — must not collapse to the same result as a genuinely
    // unclassified entity (CLASSIFICATION_MISSING) either: the graph still
    // proves classification, so the correct outcome is the distinct
    // "classified, but unresolved" marker/failure.
    const store = convertServerDataModel(buildClassifiedDataModel(false), parseResult, { size: 1 }, []);

    const info = extractClassificationsOnDemand(store, 4);
    assert.deepEqual(info, [{ unresolved: true }]);

    const accessor = createDataAccessor(store);
    const result = checkClassificationFacet(systemFacet, 4, accessor);
    assert.equal(result.passed, false);
    assert.equal(result.failure?.type, 'CLASSIFICATION_UNRESOLVED');
  });

  it('resolves canonical repeated classification relationships after graph deduplication (#3959)', () => {
    const dataModel = buildClassifiedDataModel(true);
    // Two legal IfcRelAssociatesClassification records share the same pair.
    // The server emits one classification row per relationship, while the
    // viewer graph collapses their equal (source, target, type) edges.
    dataModel.relationships[0].rel_id = 200;
    dataModel.relationships.push({ ...dataModel.relationships[0], rel_id: 201 });
    dataModel.classifications.push({ ...dataModel.classifications[0] });
    const store = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);
    const refs = store.relationships.getRelated(4, RelationshipType.AssociatesClassification, 'inverse');
    assert.deepEqual(refs, [100]);
    const info = extractClassificationsOnDemand(store, 4);
    assert.equal(info.length, 2);
    assert.ok(info.every((row) => row.system === 'Uniclass 2015' && row.identification === 'EF_25_10'));
    const result = checkClassificationFacet(systemFacet, 4, createDataAccessor(store));
    assert.equal(result.passed, true);
    assert.equal(result.failure, undefined);
  });

  it('mutation: an attribute the server never sent (location) stays undefined, never fabricated', () => {
    const store = convertServerDataModel(buildClassifiedDataModel(true), parseResult, { size: 1 }, []);
    const info = extractClassificationsOnDemand(store, 4);
    assert.equal(info[0].location, undefined);
  });

  it('mutation: a graph/payload disagreement (id present in payload for an entity the graph does not link) never surfaces as a false positive for the unlinked entity', () => {
    // entity 5 has no IFCRELASSOCIATESCLASSIFICATION edge at all, so
    // classRefIds is empty for it regardless of what `classifications`
    // carries — resolvedClassifications must never be consulted independent
    // of relationship-graph presence.
    const dataModel = buildClassifiedDataModel(true);
    // Inject a payload row for entity 5 the graph does NOT corroborate.
    dataModel.classifications.push({ element_id: 5, system_name: 'Uniclass 2015', identification: 'EF_25_10', name: 'Walls' });
    const store = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);

    const info = extractClassificationsOnDemand(store, 5);
    assert.deepEqual(info, []);

    const accessor = createDataAccessor(store);
    const result = checkClassificationFacet(systemFacet, 5, accessor);
    assert.equal(result.passed, false);
    assert.equal(result.failure?.type, 'CLASSIFICATION_MISSING');
  });

  it('aggregates multiple classifications on a single element, preserving all in payload order (#3959)', () => {
    // An element carrying multiple classifications (e.g., Uniclass and an
    // in-house system) is realistic. The resolvedClassifications aggregation
    // loop must exercise the `existing.push(info)` branch when an element
    // has two or more rows in DataModel.classifications. This pins that the
    // loop does not lose, merge, deduplicate, or reorder classifications.
    const dataModel: DataModel = {
      entities: ServerEntityIndex.fromRows([
        { entity_id: 1, type_name: 'IFCPROJECT', global_id: 'p', name: 'Project', has_geometry: false },
        { entity_id: 4, type_name: 'IFCWALL', global_id: 'w-multi', name: 'Multi-classified Wall', has_geometry: true },
        { entity_id: 100, type_name: 'IFCCLASSIFICATIONREFERENCE', global_id: '', name: 'EF_25_10', has_geometry: false },
        { entity_id: 101, type_name: 'IFCCLASSIFICATIONREFERENCE', global_id: '', name: 'IN-HOUSE-A1', has_geometry: false },
      ]),
      propertySets: new Map(),
      quantitySets: new Map(),
      relationships: [
        // Two IFCRELASSOCIATESCLASSIFICATION edges for element 4, one per system.
        { rel_type: 'IFCRELASSOCIATESCLASSIFICATION', relating_id: 100, related_id: 4 },
        { rel_type: 'IFCRELASSOCIATESCLASSIFICATION', relating_id: 101, related_id: 4 },
      ],
      classifications: [
        // First classification (Uniclass): must survive.
        {
          element_id: 4,
          system_name: 'Uniclass 2015',
          identification: 'EF_25_10',
          name: 'Walls',
          location: undefined,
        },
        // Second classification (in-house system): must also survive and NOT
        // overwrite or merge with the first. The loop's existing.push(info)
        // branch must be exercised.
        {
          element_id: 4,
          system_name: 'In-House System',
          identification: 'A1',
          name: 'Structural Element',
          location: 'Level 1',
        },
      ],
      materials: [],
      documents: [],
      spatialHierarchy: {
        nodes: [
          { entity_id: 1, parent_id: 0, level: 0, path: 'Project', type_name: 'IFCPROJECT', name: 'Project', children_ids: [], element_ids: [4] },
        ],
        project_id: 1,
        element_to_storey: new Map(),
        element_to_building: new Map(),
        element_to_site: new Map(),
        element_to_space: new Map(),
      },
    };

    const store = convertServerDataModel(dataModel, parseResult, { size: 1 }, []);

    // Both classifications must survive, in payload order.
    const info = extractClassificationsOnDemand(store, 4);
    assert.equal(info.length, 2, 'element 4 must have exactly 2 classifications, not 1 or 0');

    // First classification (Uniclass): assert on actual values, not just count.
    // A count-only check would pass even if both entries were the same object.
    assert.equal(info[0].system, 'Uniclass 2015', 'first classification system must be preserved');
    assert.equal(info[0].identification, 'EF_25_10', 'first classification identification must be preserved');
    assert.equal(info[0].name, 'Walls', 'first classification name must be preserved');
    assert.equal(info[0].location, undefined, 'first classification location must be undefined');

    // Second classification (In-House System): distinct fields intact.
    assert.equal(info[1].system, 'In-House System', 'second classification system must be preserved');
    assert.equal(info[1].identification, 'A1', 'second classification identification must be preserved');
    assert.equal(info[1].name, 'Structural Element', 'second classification name must be preserved');
    assert.equal(info[1].location, 'Level 1', 'second classification location must be preserved');

    // Verify they are not deduplicated or merged: the objects must be distinct.
    assert.notEqual(info[0], info[1], 'classifications must be separate objects, not merged');
  });
});
