/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A model loaded from the server must export its relationships, and must
 * answer for a repeated IfcRel exactly as a locally parsed one does (#3827).
 *
 * `buildRelationships` used to hand-roll a `RelationshipEdges` facade whose
 * `offsets`, `counts` and `edge*` arrays were empty, with the real edges
 * hidden behind the `getEdges` closure. Every consumer that walks a CSR half
 * through `offsets` -- the Parquet `Relationships` table here, the DuckDB
 * `relationships` table in `@ifc-lite/query` -- therefore saw a graph with no
 * edges at all and silently emitted zero rows. The facade also collected
 * edges itself, so any repeated-edge handling in `RelationshipGraphBuilder`
 * never reached the server path.
 *
 * The fixture repeats one IfcRel line, which is schema-legal: nothing in
 * EXPRESS forbids two `IfcRel*` instances naming the same (relating, related)
 * pair. The parity assertion pins the server graph against the same edges fed
 * through `RelationshipGraphBuilder` directly, which is the WASM path's own
 * construction -- so whatever the builder does with a repeat, both paths do
 * the same thing, and they cannot drift apart again.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import { RelationshipGraphBuilder, RelationshipType } from '@ifc-lite/data';
import { ParquetExporter } from '@ifc-lite/export';
// `apps/viewer/src/apache-arrow.d.ts` declares this module with `export =`,
// so the named import the packages/export tests use does not type-check here.
import * as arrow from 'apache-arrow';
import { readParquet } from 'parquet-wasm';
import { convertServerDataModel, type ServerParseResult } from './serverDataModel';

const parseResult: ServerParseResult = {
  cache_key: 'relationships',
  metadata: { schema_version: 'IFC4' },
  stats: { total_time_ms: 1, parse_time_ms: 1, geometry_time_ms: 0, total_vertices: 0, total_triangles: 0 },
};

const PROJECT = 1;
const STOREY = 2;
const WALL = 3;

/**
 * Two distinct relationships, plus a verbatim repeat of the second. The
 * repeat is what a redundant `IfcRelContainedInSpatialStructure` record in the
 * source file looks like once the server has flattened it into rows.
 */
const RELATIONSHIPS = [
  { rel_type: 'IFCRELAGGREGATES', relating_id: PROJECT, related_id: STOREY },
  { rel_type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', relating_id: STOREY, related_id: WALL },
  { rel_type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', relating_id: STOREY, related_id: WALL },
] as const;

/** The same edges, in the same order, through the locally-parsed path's builder. */
function referenceGraph() {
  const builder = new RelationshipGraphBuilder();
  builder.addEdge(PROJECT, STOREY, RelationshipType.Aggregates, 0);
  builder.addEdge(STOREY, WALL, RelationshipType.ContainsElements, 0);
  builder.addEdge(STOREY, WALL, RelationshipType.ContainsElements, 0);
  return builder.build();
}

function dataModel(): DataModel {
  return {
    entities: ServerEntityIndex.fromRows([
      { entity_id: PROJECT, type_name: 'IFCPROJECT', global_id: 'G0'.padEnd(22, 'x'), name: 'Project', has_geometry: false },
      { entity_id: STOREY, type_name: 'IFCBUILDINGSTOREY', global_id: 'G1'.padEnd(22, 'x'), name: 'Level 0', has_geometry: false },
      { entity_id: WALL, type_name: 'IFCWALL', global_id: 'G2'.padEnd(22, 'x'), name: 'Wall', has_geometry: false },
    ]),
    propertySets: new Map(),
    quantitySets: new Map(),
    relationships: [...RELATIONSHIPS],
    classifications: [],
    materials: [],
    documents: [],
    spatialHierarchy: {
      nodes: [
        {
          entity_id: PROJECT,
          parent_id: 0,
          level: 0,
          path: 'Project',
          type_name: 'IFCPROJECT',
          name: 'Project',
          children_ids: [STOREY],
          element_ids: [],
        },
        {
          entity_id: STOREY,
          parent_id: PROJECT,
          level: 1,
          path: 'Project/Level 0',
          type_name: 'IFCBUILDINGSTOREY',
          name: 'Level 0',
          children_ids: [],
          element_ids: [WALL],
        },
      ],
      project_id: PROJECT,
      element_to_storey: new Map([[WALL, STOREY]]),
      element_to_building: new Map(),
      element_to_site: new Map(),
      element_to_space: new Map(),
    },
  } as unknown as DataModel;
}

function store() {
  return convertServerDataModel(dataModel(), parseResult, { size: 1 }, []);
}

function decode(bytes: Uint8Array): Record<string, unknown>[] {
  const table = arrow.tableFromIPC(readParquet(bytes).intoIPCStream());
  return (table.toArray() as { toJSON(): Record<string, unknown> }[]).map((row) => row.toJSON());
}

/** Every (source, target, type) triple a CSR half holds, as sortable strings. */
function csrTriples(edges: {
  offsets: Map<number, number>;
  counts: Map<number, number>;
  edgeTargets: Uint32Array;
  edgeTypes: Uint16Array;
}): string[] {
  const out: string[] = [];
  for (const [source, offset] of edges.offsets) {
    const count = edges.counts.get(source)!;
    for (let i = offset; i < offset + count; i++) {
      out.push(`${source}->${edges.edgeTargets[i]}:${edges.edgeTypes[i]}`);
    }
  }
  return out.sort();
}

/** The `SourceId->TargetId:RelType` of every row in a store's Parquet Relationships table. */
async function exportRelationships(s: ReturnType<typeof store>): Promise<string[]> {
  const rows = decode(await new ParquetExporter(s).exportTable('relationships'));
  return rows.map((r) => `${Number(r.SourceId)}->${Number(r.TargetId)}:${String(r.RelType)}`);
}

describe('server-path relationship graph', () => {
  it('anti-vacuity: the fixture really does repeat one relationship verbatim', () => {
    const seen = RELATIONSHIPS.map((r) => `${r.rel_type}:${r.relating_id}:${r.related_id}`);
    assert.equal(new Set(seen).size, seen.length - 1, 'fixture must contain exactly one repeat');
  });

  it('materialises real CSR columns, not an empty-offsets facade', () => {
    const { relationships } = store();

    // The defect: offsets/counts/edge arrays were all empty while getEdges
    // answered correctly, so nothing that walks the columns saw an edge.
    assert.ok(relationships.forward.offsets.size > 0, 'forward offsets must be populated');
    assert.ok(relationships.inverse.offsets.size > 0, 'inverse offsets must be populated');
    assert.ok(relationships.forward.edgeTargets.length > 0, 'forward edge array must be populated');
    assert.ok(relationships.inverse.edgeTargets.length > 0, 'inverse edge array must be populated');

    // And the columns agree with the closure, in both directions.
    assert.deepEqual(
      csrTriples(relationships.forward).length,
      relationships.forward.edgeTargets.length,
      'every forward edge must be reachable through offsets',
    );
    assert.deepEqual(
      relationships.forward.getTargets(STOREY, RelationshipType.ContainsElements),
      Array.from(
        { length: relationships.forward.counts.get(STOREY)! },
        (_, i) => relationships.forward.edgeTargets[relationships.forward.offsets.get(STOREY)! + i],
      ),
    );
  });

  it('answers a repeated IfcRel exactly as the locally-parsed path does', () => {
    const server = store().relationships;
    const local = referenceGraph();

    assert.deepEqual(csrTriples(server.forward), csrTriples(local.forward), 'forward half must match');
    assert.deepEqual(csrTriples(server.inverse), csrTriples(local.inverse), 'inverse half must match');

    // The traversal the ~90 spatial call sites actually use.
    assert.deepEqual(
      server.getRelated(STOREY, RelationshipType.ContainsElements, 'forward'),
      local.getRelated(STOREY, RelationshipType.ContainsElements, 'forward'),
      'getRelated must not count the repeat differently from the local path',
    );
  });

  it('exports the relationships to Parquet instead of an empty table', async () => {
    const server = store();
    const rows = await exportRelationships(server);

    // One row per IfcRel record in the fixture. Named, not merely counted: a
    // count alone cannot tell a lost row from a swapped one.
    assert.equal(rows.length, RELATIONSHIPS.length, 'the Parquet Relationships table must not be empty');
    assert.deepEqual(rows.sort(), [
      `${PROJECT}->${STOREY}:IfcRelAggregates`,
      `${STOREY}->${WALL}:IfcRelContainedInSpatialStructure`,
      `${STOREY}->${WALL}:IfcRelContainedInSpatialStructure`,
    ]);

    // Parity again, this time through the exporter: the same edges built by
    // the locally-parsed path must export identically. Stated as a comparison
    // rather than a fixed shape so it stays true whatever the exporter decides
    // a repeated IfcRel is worth.
    assert.deepEqual(
      rows,
      (await exportRelationships({ ...server, relationships: referenceGraph() })).sort(),
    );
  });
});
