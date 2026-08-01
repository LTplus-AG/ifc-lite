/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import { IfcTypeEnum, RelationshipType, STOREY_ELEVATION_MATCH_TOLERANCE_M } from '@ifc-lite/data';
import { EntityQuery } from '@ifc-lite/query';
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
