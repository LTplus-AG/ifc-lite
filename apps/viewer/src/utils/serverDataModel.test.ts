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
});
