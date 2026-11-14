/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model loaded from the server must answer the model info panel's counts
 * the way a locally parsed one does.
 *
 * The panel asked a server store for `IFCBUILDINGSTOREY` and for its physical
 * classes in the uppercase STEP spelling every store's type index uses. The
 * converter keyed that index by `IfcTypeEnum` member names (`IfcBuildingStorey`)
 * instead, so both lookups missed: "Building Storeys 0" and "Elements with
 * Geometry 0" beside a hierarchy that listed the storeys.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import type { GeometryResult } from '@ifc-lite/geometry';
import { computeModelStats } from '@/components/viewer/properties/modelMetadataStats';
import { convertServerDataModel, type ServerParseResult } from './serverDataModel';

const parseResult: ServerParseResult = {
  cache_key: 'stats',
  metadata: { schema_version: 'IFC4' },
  stats: { total_time_ms: 1, parse_time_ms: 1, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
};

/** Two storeys; a wall and a sanitary terminal with meshes, a wall without one, and a wall type. */
function model(): DataModel {
  const node = (entity_id: number, parent_id: number, type_name: string, children_ids: number[], element_ids: number[]) =>
    ({ entity_id, parent_id, level: 0, path: String(entity_id), type_name, name: type_name, children_ids, element_ids });
  return {
    entities: ServerEntityIndex.fromRows([
      { entity_id: 1, type_name: 'IFCPROJECT', global_id: 'p', name: 'Project', has_geometry: false },
      { entity_id: 2, type_name: 'IFCBUILDINGSTOREY', global_id: 's1', name: 'EG', has_geometry: false },
      { entity_id: 3, type_name: 'IFCBUILDINGSTOREY', global_id: 's2', name: 'OG', has_geometry: false },
      { entity_id: 4, type_name: 'IFCWALL', global_id: 'w1', name: 'Meshed wall', has_geometry: true },
      { entity_id: 5, type_name: 'IFCWALL', global_id: 'w2', name: 'Wall without a shape', has_geometry: false },
      // No `IfcTypeEnum` member: the enum-keyed index filed this class under 'Unknown'.
      { entity_id: 6, type_name: 'IFCSANITARYTERMINAL', global_id: 't', name: 'Basin', has_geometry: true },
      { entity_id: 7, type_name: 'IFCWALLTYPE', global_id: 'wt', name: 'Wall type', has_geometry: false },
    ]),
    propertySets: new Map(), quantitySets: new Map(),
    relationships: [
      { rel_type: 'IFCRELAGGREGATES', relating_id: 1, related_id: 2 },
      { rel_type: 'IFCRELAGGREGATES', relating_id: 1, related_id: 3 },
      { rel_type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', relating_id: 2, related_id: 4 },
      { rel_type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', relating_id: 2, related_id: 5 },
      { rel_type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', relating_id: 3, related_id: 6 },
    ],
    classifications: [], materials: [], documents: [],
    spatialHierarchy: {
      nodes: [node(1, 0, 'IFCPROJECT', [2, 3], []), node(2, 1, 'IFCBUILDINGSTOREY', [], [4, 5]), node(3, 1, 'IFCBUILDINGSTOREY', [], [6])],
      project_id: 1, element_to_storey: new Map([[4, 2], [5, 2], [6, 3]]), element_to_building: new Map(),
      element_to_site: new Map(), element_to_space: new Map(),
    },
  };
}

const geometry = { meshes: [{ expressId: 4 }, { expressId: 6 }] } as unknown as GeometryResult;

describe('model info counts on a server-loaded model', () => {
  it('counts the storeys and the elements that produced a mesh', () => {
    const store = convertServerDataModel(model(), parseResult, { size: 46_000_000 }, []);
    const stats = computeModelStats(store, geometry, { geometryReady: true, toLocalId: (id) => id });
    assert.deepEqual(stats, { storeys: 2, elementsWithGeometry: 2 });
    assert.equal(store.fileSize, 46_000_000);
  });

  it('indexes every class under its own uppercase STEP name, like a parsed store', () => {
    const store = convertServerDataModel(model(), parseResult, { size: 1 }, []);
    const byType = store.entityIndex.byType;
    assert.deepEqual(byType.get('IFCBUILDINGSTOREY'), [2, 3]);
    assert.deepEqual(byType.get('IFCWALL'), [4, 5]);
    assert.deepEqual(byType.get('IFCSANITARYTERMINAL'), [6]);
    assert.deepEqual([...byType.keys()].filter((type) => type !== type.toUpperCase()), []);
  });
});
