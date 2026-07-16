/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DataModel } from '@ifc-lite/server-client';
import { IfcTypeEnum, RelationshipType } from '@ifc-lite/data';
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
      entities: new Map([
        [1, { entity_id: 1, type_name: 'IFCPROJECT', global_id: '0', name: 'Infra Project', has_geometry: false }],
        [2, { entity_id: 2, type_name: 'IFCBRIDGE', global_id: '1', name: 'Bridge A', has_geometry: false }],
        [3, { entity_id: 3, type_name: 'IFCBRIDGEPART', global_id: '2', name: 'Deck', has_geometry: false }],
        [4, { entity_id: 4, type_name: 'IFCWALL', global_id: '3', name: 'Barrier', has_geometry: true }],
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
      entities: new Map([
        [1, { entity_id: 1, type_name: 'IFCPROJECT', global_id: '0', name: 'Project', has_geometry: false }],
        [2, { entity_id: 2, type_name: 'IFCBUILDING', global_id: '1', name: 'Building', has_geometry: false }],
        [3, { entity_id: 3, type_name: 'IFCDOCUMENTREFERENCE', global_id: '', name: 'Spec', has_geometry: false }],
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
      entities: new Map([
        [10, { entity_id: 10, type_name: 'IFCWALL', global_id: 'w', name: 'W', has_geometry: true }],
        [20, { entity_id: 20, type_name: 'IFCWALLTYPE', global_id: 't', name: 'WT', has_geometry: false }],
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
});
