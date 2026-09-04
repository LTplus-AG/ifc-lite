/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A server-loaded model must carry the real `IfcRel*` express id on every
 * relationship edge (issue #3860).
 *
 * The server payload gained a `rel_id` column; before it, the viewer's server
 * path fed the relationship graph a hard-coded 0, so `RelId` in a Parquet or
 * DuckDB export of a server-loaded model was 0 on every row while a locally
 * parsed model of the same file carried the real id. `RelId` is read from the
 * graph's `edgeRelIds`, which is exactly what the assertions below read
 * through, so this pins the value the export writes.
 *
 * The fixture's rel ids (900/901/902) are disjoint from every relating and
 * related id, so a copy of a neighbouring column fails as loudly as the old
 * constant 0.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import { RelationshipType } from '@ifc-lite/data';
import { convertServerDataModel, type ServerParseResult } from './serverDataModel';

const parseResult: ServerParseResult = {
  cache_key: 'rel-id',
  metadata: { schema_version: 'IFC4' },
  stats: { total_time_ms: 1, parse_time_ms: 1, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
};

/** relating -> related, and the express id of the IfcRel that declared it. */
const EDGES = [
  { rel_type: 'IFCRELAGGREGATES', relating_id: 1, related_id: 2, rel_id: 900 },
  { rel_type: 'IFCRELAGGREGATES', relating_id: 2, related_id: 3, rel_id: 901 },
  { rel_type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', relating_id: 3, related_id: 4, rel_id: 902 },
] as const;

function dataModel(relationships: DataModel['relationships']): DataModel {
  return {
    entities: ServerEntityIndex.fromRows([
      { entity_id: 1, type_name: 'IFCPROJECT', global_id: '0', name: 'P', has_geometry: false },
      { entity_id: 2, type_name: 'IFCBUILDING', global_id: '1', name: 'B', has_geometry: false },
      { entity_id: 3, type_name: 'IFCBUILDINGSTOREY', global_id: '2', name: 'S', has_geometry: false },
      { entity_id: 4, type_name: 'IFCWALL', global_id: '3', name: 'W', has_geometry: true },
    ]),
    propertySets: new Map(),
    quantitySets: new Map(),
    relationships,
    classifications: [],
    materials: [],
    documents: [],
    spatialHierarchy: {
      nodes: [
        {
          entity_id: 1,
          parent_id: 0,
          level: 0,
          path: 'P',
          type_name: 'IFCPROJECT',
          name: 'P',
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
  } as unknown as DataModel;
}

function store(relationships: DataModel['relationships']) {
  return convertServerDataModel(dataModel(relationships), parseResult, { size: 1 }, []);
}

describe('server-loaded relationship ids', () => {
  it('carries the IfcRel express id on every edge, in both directions', () => {
    const { relationships } = store([...EDGES]);

    for (const edge of EDGES) {
      const between = relationships.getRelationshipsBetween(edge.relating_id, edge.related_id);
      assert.equal(between.length, 1, `one edge ${edge.relating_id} -> ${edge.related_id}`);
      assert.equal(
        between[0].relationshipId,
        edge.rel_id,
        `RelId for ${edge.rel_type} ${edge.relating_id} -> ${edge.related_id}`,
      );

      const forward = relationships.forward
        .getEdges(edge.relating_id)
        .filter((e) => e.target === edge.related_id);
      assert.equal(forward.length, 1, 'one forward edge');
      assert.equal(forward[0].relationshipId, edge.rel_id, 'forward edge relationshipId');

      const inverse = relationships.inverse
        .getEdges(edge.related_id)
        .filter((e) => e.target === edge.relating_id);
      assert.equal(inverse.length, 1, 'one inverse edge');
      assert.equal(inverse[0].relationshipId, edge.rel_id, 'inverse edge relationshipId');
    }

    // Anti-vacuity: the ids really are distinct from each other, so a single
    // constant cannot pass. (They are disjoint from every endpoint id by
    // construction — `as const` makes TS prove it, so no assertion here.)
    const ids = EDGES.map((e) => e.rel_id);
    assert.equal(new Set(ids).size, ids.length, 'rel ids must be distinct');
    // And the edges really did map to graph types (an unmapped rel_type is
    // dropped before it reaches an edge, which would make the loop vacuous).
    assert.equal(relationships.forward.getEdges(1)[0].type, RelationshipType.Aggregates);
  });

  it('falls back to 0 when the server sends no rel_id (older payload)', () => {
    // An older server omits the column, so `rel_id` is absent. The edge must
    // still be built; it just has no id to name.
    const older = EDGES.map(({ rel_type, relating_id, related_id }) => ({ rel_type, relating_id, related_id }));
    const { relationships } = store(older);

    const between = relationships.getRelationshipsBetween(1, 2);
    assert.equal(between.length, 1, 'edge must still exist without a rel_id');
    assert.equal(between[0].relationshipId, 0, 'absent rel_id reads as 0');
  });
});
