/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  RelationshipGraphBuilder,
  relationshipGraphFromColumns,
  relationshipGraphToColumns,
} from './relationship-graph.js';
import { flattenRelationshipEdges } from './relationship-graph-helpers.js';
import { RelationshipType } from './types.js';

function buildSampleGraph() {
  const builder = new RelationshipGraphBuilder();
  // Project 100 contains storey 200; storey 200 aggregates walls 301, 302
  builder.addEdge(100, 200, RelationshipType.Aggregates, 1);
  builder.addEdge(200, 301, RelationshipType.ContainsElements, 2);
  builder.addEdge(200, 302, RelationshipType.ContainsElements, 2);
  // Pset 400 defines walls 301 and 302
  builder.addEdge(400, 301, RelationshipType.DefinesByProperties, 3);
  builder.addEdge(400, 302, RelationshipType.DefinesByProperties, 3);
  return builder.build();
}

describe('RelationshipGraph', () => {
  it('exposes forward and inverse traversal', () => {
    const g = buildSampleGraph();
    expect(g.getRelated(200, RelationshipType.ContainsElements, 'forward').sort())
      .toEqual([301, 302]);
    expect(g.getRelated(301, RelationshipType.ContainsElements, 'inverse'))
      .toEqual([200]);
    expect(g.getRelated(301, RelationshipType.DefinesByProperties, 'inverse'))
      .toEqual([400]);
  });

  it('detects existing and missing relationships', () => {
    const g = buildSampleGraph();
    expect(g.hasRelationship(200, 301, RelationshipType.ContainsElements)).toBe(true);
    expect(g.hasRelationship(200, 999)).toBe(false);
  });

  it('returns relationship metadata between two entities', () => {
    const g = buildSampleGraph();
    const rels = g.getRelationshipsBetween(200, 301);
    expect(rels).toHaveLength(1);
    expect(rels[0].type).toBe(RelationshipType.ContainsElements);
    expect(rels[0].typeName).toBe('IfcRelContainedInSpatialStructure');
  });

  // The suite above only ever exercises one `RelationshipType` -> IFC entity
  // name mapping (ContainsElements), so a swap between two other entries in
  // the internal `RelationshipTypeToString` lookup table (e.g. AssignsToGroup
  // <-> AssignsToProduct, which are adjacent numeric values 60/61) is
  // invisible to every existing test. This pins every type -> name pair so
  // such a swap fails here.
  it('maps every RelationshipType to its correct IFC entity name', () => {
    const expected: Record<RelationshipType, string> = {
      [RelationshipType.ContainsElements]: 'IfcRelContainedInSpatialStructure',
      [RelationshipType.Aggregates]: 'IfcRelAggregates',
      [RelationshipType.DefinesByProperties]: 'IfcRelDefinesByProperties',
      [RelationshipType.DefinesByType]: 'IfcRelDefinesByType',
      [RelationshipType.AssociatesMaterial]: 'IfcRelAssociatesMaterial',
      [RelationshipType.AssociatesClassification]: 'IfcRelAssociatesClassification',
      [RelationshipType.AssociatesDocument]: 'IfcRelAssociatesDocument',
      [RelationshipType.VoidsElement]: 'IfcRelVoidsElement',
      [RelationshipType.FillsElement]: 'IfcRelFillsElement',
      [RelationshipType.ConnectsPathElements]: 'IfcRelConnectsPathElements',
      [RelationshipType.ConnectsElements]: 'IfcRelConnectsElements',
      [RelationshipType.ConnectsPortToElement]: 'IfcRelConnectsPortToElement',
      [RelationshipType.ConnectsPorts]: 'IfcRelConnectsPorts',
      [RelationshipType.SpaceBoundary]: 'IfcRelSpaceBoundary',
      [RelationshipType.AssignsToGroup]: 'IfcRelAssignsToGroup',
      [RelationshipType.AssignsToProduct]: 'IfcRelAssignsToProduct',
      [RelationshipType.ReferencedInSpatialStructure]: 'IfcRelReferencedInSpatialStructure',
    };

    let relId = 1000;
    for (const [typeStr, typeName] of Object.entries(expected)) {
      const type = Number(typeStr) as RelationshipType;
      const builder = new RelationshipGraphBuilder();
      builder.addEdge(1, 2, type, relId++);
      const g = builder.build();
      const rels = g.getRelationshipsBetween(1, 2);
      expect(rels).toHaveLength(1);
      expect(rels[0].typeName).toBe(typeName);
    }
  });
});

describe('relationshipGraphToColumns / relationshipGraphFromColumns round-trip', () => {
  it('preserves all traversal results', () => {
    const original = buildSampleGraph();
    const columns = relationshipGraphToColumns(original);
    const rebuilt = relationshipGraphFromColumns(columns);

    for (const id of [100, 200, 301, 302, 400]) {
      for (const dir of ['forward', 'inverse'] as const) {
        for (const type of [
          RelationshipType.Aggregates,
          RelationshipType.ContainsElements,
          RelationshipType.DefinesByProperties,
        ]) {
          expect(rebuilt.getRelated(id, type, dir).sort()).toEqual(
            original.getRelated(id, type, dir).sort(),
          );
        }
      }
    }
  });

  it('aliases the underlying CSR typed-array buffers', () => {
    const original = buildSampleGraph();
    const columns = relationshipGraphToColumns(original);
    expect(columns.forward.edgeTargets.buffer).toBe(original.forward.edgeTargets.buffer);
    expect(columns.inverse.edgeRelIds.buffer).toBe(original.inverse.edgeRelIds.buffer);
  });

  it('handles empty graphs', () => {
    const empty = new RelationshipGraphBuilder().build();
    const rebuilt = relationshipGraphFromColumns(relationshipGraphToColumns(empty));
    expect(rebuilt.getRelated(1, RelationshipType.Aggregates, 'forward')).toEqual([]);
    expect(rebuilt.hasRelationship(1, 2)).toBe(false);
    expect(rebuilt.forward.edgeTargets.length).toBe(0);
  });
});

describe('buildCSR determinism and edge presence', () => {
  // The sample fixture above adds edges in already-ascending source order
  // (100, 200, 200, 400, 400), which makes the `uniqueKeys.sort()` in
  // buildCSR an identity — and every assertion in it calls `.sort()` on the
  // result, so CSR ordering could not be observed either way. These build
  // the graph in DESCENDING key order and read the raw CSR columns.
  function descendingGraph() {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(400, 41, RelationshipType.Aggregates, 1);
    builder.addEdge(200, 21, RelationshipType.Aggregates, 2);
    builder.addEdge(300, 31, RelationshipType.Aggregates, 3);
    builder.addEdge(200, 22, RelationshipType.Aggregates, 4);
    builder.addEdge(100, 11, RelationshipType.Aggregates, 5);
    return builder.build();
  }

  it('lays edges out in ascending key order regardless of insertion order', () => {
    const g = descendingGraph();
    // Offsets must be assigned by ascending key, not by first-seen order.
    expect([...g.forward.offsets.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [100, 0],
      [200, 1],
      [300, 3],
      [400, 4],
    ]);
    // ... and the scattered edge column follows that layout.
    expect([...g.forward.edgeTargets]).toEqual([11, 21, 22, 31, 41]);
  });

  it('produces byte-identical CSR columns for two different insertion orders', () => {
    const ascending = new RelationshipGraphBuilder();
    ascending.addEdge(100, 11, RelationshipType.Aggregates, 5);
    ascending.addEdge(200, 21, RelationshipType.Aggregates, 2);
    ascending.addEdge(200, 22, RelationshipType.Aggregates, 4);
    ascending.addEdge(300, 31, RelationshipType.Aggregates, 3);
    ascending.addEdge(400, 41, RelationshipType.Aggregates, 1);
    const a = ascending.build();
    const d = descendingGraph();
    expect([...d.forward.edgeTargets]).toEqual([...a.forward.edgeTargets]);
    expect([...d.forward.edgeRelIds]).toEqual([...a.forward.edgeRelIds]);
    expect([...d.forward.offsets.entries()].sort((x, y) => x[0] - y[0])).toEqual(
      [...a.forward.offsets.entries()].sort((x, y) => x[0] - y[0]),
    );
  });

  // `edgeRelIds` is the express id of the IfcRel* entity, and NOTHING pinned
  // it to a value: the round-trip test compares the column against another
  // build of the same data (self-consistent either way), and the metadata test
  // asserts only `type`/`typeName`. Scattering `keys[i]` (the SOURCE entity id)
  // into `edgeRelIds` instead of `relIds[i]` passed the whole suite. These ids
  // are deliberately disjoint from every source and target id in the fixture,
  // so no substitution can look correct.
  it('scatters the relationship express id, not the source or target id', () => {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(400, 41, RelationshipType.Aggregates, 7001);
    builder.addEdge(200, 21, RelationshipType.Aggregates, 7002);
    builder.addEdge(200, 22, RelationshipType.ContainsElements, 7003);
    const g = builder.build();

    expect(g.forward.getEdges(200)).toEqual([
      { target: 21, type: RelationshipType.Aggregates, relationshipId: 7002 },
      { target: 22, type: RelationshipType.ContainsElements, relationshipId: 7003 },
    ]);
    expect(g.forward.getEdges(400)).toEqual([
      { target: 41, type: RelationshipType.Aggregates, relationshipId: 7001 },
    ]);
    // The inverse half carries the same relationship ids, keyed by target.
    expect(g.inverse.getEdges(21)).toEqual([
      { target: 200, type: RelationshipType.Aggregates, relationshipId: 7002 },
    ]);
    expect(g.getRelationshipsBetween(200, 22)).toEqual([
      {
        relationshipId: 7003,
        type: RelationshipType.ContainsElements,
        typeName: 'IfcRelContainedInSpatialStructure',
      },
    ]);
  });

  it('records the per-key edge count', () => {
    const g = descendingGraph();
    expect(g.forward.counts.get(200)).toBe(2);
    expect(g.forward.counts.get(100)).toBe(1);
    expect(g.forward.counts.get(999)).toBeUndefined();
  });

  it('hasAnyEdges distinguishes entities with edges from those without', () => {
    const g = buildSampleGraph();
    expect(g.forward.hasAnyEdges(200)).toBe(true); // storey has children
    expect(g.forward.hasAnyEdges(301)).toBe(false); // leaf wall: no forward edges
    expect(g.inverse.hasAnyEdges(301)).toBe(true); // ... but it has parents
    expect(g.forward.hasAnyEdges(999)).toBe(false); // unknown entity
  });

  it('hasAnyEdges is false for every entity in an empty graph', () => {
    const empty = new RelationshipGraphBuilder().build();
    expect(empty.forward.hasAnyEdges(1)).toBe(false);
    expect(empty.inverse.hasAnyEdges(1)).toBe(false);
  });

  it('getTargets returns just the target ids, filtered by type', () => {
    const g = buildSampleGraph();
    expect(g.forward.getTargets(200, RelationshipType.ContainsElements).sort()).toEqual([301, 302]);
    expect(g.forward.getTargets(200, RelationshipType.Aggregates)).toEqual([]);
    expect(g.forward.getTargets(200).sort()).toEqual([301, 302]);
  });
  // Two schema-legal IfcRel* instances may name the same (relating, related)
  // pair — nothing in EXPRESS forbids it (see #3760). Before the dedupe the
  // builder pushed both, so every consumer that walks the raw edge list
  // (spatial hierarchy, schedules, Parquet, property/classification reads)
  // counted the element twice.
  it('collapses a repeated (source, target, type) edge to one', () => {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5001);
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5002); // redundant IfcRel
    const g = builder.build();

    expect(g.getRelated(200, RelationshipType.ContainsElements, 'forward')).toEqual([301]);
    expect(g.getRelated(301, RelationshipType.ContainsElements, 'inverse')).toEqual([200]);
    expect(g.forward.counts.get(200)).toBe(1);
    // The first relationship instance wins, so the surviving edge keeps a
    // real IfcRel express id rather than a synthesised one; the second is
    // kept on shadowedRelationshipIds rather than dropped (#3782 review).
    expect(g.forward.getEdges(200)).toEqual([
      {
        target: 301,
        type: RelationshipType.ContainsElements,
        relationshipId: 5001,
        shadowedRelationshipIds: [5002],
      },
    ]);
    expect(g.getRelationshipsBetween(200, 301)).toHaveLength(1);
  });

  // A deduped edge keeps every collapsed IfcRel id in
  // `shadowedRelationshipIds`, not just the survivor, so a consumer that
  // filters by "is this specific IfcRel deleted" can still tell the
  // connection survives while a sibling instance exists (#3782 review).
  it('keeps every collapsed IfcRel id, not just the survivor', () => {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5001);
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5002); // redundant IfcRel
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5003); // and a third
    const g = builder.build();

    expect(g.forward.getEdges(200)).toEqual([
      {
        target: 301,
        type: RelationshipType.ContainsElements,
        relationshipId: 5001,
        shadowedRelationshipIds: [5002, 5003],
      },
    ]);
    // Inverse direction carries the same shadowed ids.
    expect(g.inverse.getEdges(301)[0].shadowedRelationshipIds).toEqual([5002, 5003]);

    // Round-trips through the columnar transport representation.
    const roundTripped = relationshipGraphFromColumns(relationshipGraphToColumns(g));
    expect(roundTripped.forward.getEdges(200)[0].shadowedRelationshipIds).toEqual([5002, 5003]);
  });

  it('keeps edges that differ only by type, target, or source', () => {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 1);
    builder.addEdge(200, 301, RelationshipType.Aggregates, 2); // same pair, other type
    builder.addEdge(200, 302, RelationshipType.ContainsElements, 3); // other target
    builder.addEdge(201, 301, RelationshipType.ContainsElements, 4); // other source
    const g = builder.build();

    expect(g.forward.getEdges(200)).toHaveLength(3);
    expect(g.forward.getTargets(200, RelationshipType.ContainsElements)).toEqual([301, 302]);
    expect(g.inverse.getTargets(301, RelationshipType.ContainsElements).sort()).toEqual([200, 201]);
  });
});

describe('flattenRelationshipEdges', () => {
  // The Parquet and DuckDB exporters both walk the raw CSR columns instead
  // of `getEdges()` for throughput, and both share this helper so they
  // can't independently forget the shadowed-id case (#3782 review): one row
  // per `IfcRel*` STEP record, not one row per deduped edge.
  it('emits one row per shadowed IfcRel id, not just the survivor', () => {
    const builder = new RelationshipGraphBuilder();
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5001);
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5002); // redundant IfcRel
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 5003); // and a third
    builder.addEdge(200, 302, RelationshipType.ContainsElements, 6001); // an untouched edge
    const g = builder.build();

    const rows = flattenRelationshipEdges(g.forward);
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.sourceId === 200 && r.targetId === 301).map((r) => r.relationshipId).sort())
      .toEqual([5001, 5002, 5003]);
    expect(rows.filter((r) => r.sourceId === 200 && r.targetId === 302).map((r) => r.relationshipId))
      .toEqual([6001]);
  });

  it('returns nothing for an empty graph', () => {
    const empty = new RelationshipGraphBuilder().build();
    expect(flattenRelationshipEdges(empty.forward)).toEqual([]);
  });
});

// Every shadowed-id test above uses exactly ONE deduped edge per CSR half —
// buildShadowedColumns's sort, the per-group cursor advance in
// flattenRelationshipEdges/getEdges, the shadowedGroupOffsets[g+1] boundary
// between two groups, and a binarySearchU32 over more than one entry are
// all no-ops with a single group (#3782 round 3 review). This exercises all
// four with three sources feeding the SAME target, each with its own
// shadowed group of a DIFFERENT size (1, 2, 1), added in an order that
// interleaves across sources so insertion order and final CSR-sorted
// position order disagree in both directions.
describe('multiple shadowed groups on one RelationshipGraph', () => {
  function buildInterleavedGraph() {
    const builder = new RelationshipGraphBuilder();
    // Source 200's group (size 2) and source 300's group (size 1) and
    // source 100's group (size 1), inserted out of source order and with
    // each source's own edges non-contiguous, so buildShadowedColumns must
    // actually sort by final scatter position rather than insertion order.
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 10); // survivor, source 200
    builder.addEdge(300, 301, RelationshipType.ContainsElements, 1); // survivor, source 300
    builder.addEdge(100, 301, RelationshipType.ContainsElements, 20); // survivor, source 100
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 11); // shadow of 10
    builder.addEdge(300, 301, RelationshipType.ContainsElements, 2); // shadow of 1
    builder.addEdge(100, 301, RelationshipType.ContainsElements, 21); // shadow of 20
    builder.addEdge(200, 301, RelationshipType.ContainsElements, 12); // second shadow of 10
    return builder.build();
  }

  it('forward: each source keeps its own group, sorted into ascending source order', () => {
    const g = buildInterleavedGraph();
    // Ascending source order (100, 200, 300), per buildCSR's key sort.
    expect(g.forward.getEdges(100, RelationshipType.ContainsElements)).toEqual([
      { target: 301, type: RelationshipType.ContainsElements, relationshipId: 20, shadowedRelationshipIds: [21] },
    ]);
    expect(g.forward.getEdges(200, RelationshipType.ContainsElements)).toEqual([
      { target: 301, type: RelationshipType.ContainsElements, relationshipId: 10, shadowedRelationshipIds: [11, 12] },
    ]);
    expect(g.forward.getEdges(300, RelationshipType.ContainsElements)).toEqual([
      { target: 301, type: RelationshipType.ContainsElements, relationshipId: 1, shadowedRelationshipIds: [2] },
    ]);
  });

  it('inverse: three groups of different sizes land under ONE key (301), exercising the multi-group binary search', () => {
    const g = buildInterleavedGraph();
    const edges = g.inverse.getEdges(301, RelationshipType.ContainsElements);
    expect(edges).toHaveLength(3);
    const bySurvivor = new Map(edges.map((e) => [e.relationshipId, e.shadowedRelationshipIds]));
    expect(bySurvivor.get(20)).toEqual([21]);
    expect(bySurvivor.get(10)).toEqual([11, 12]);
    expect(bySurvivor.get(1)).toEqual([2]);
  });

  it('flattenRelationshipEdges: one row per IfcRel id across all three groups, both directions', () => {
    const g = buildInterleavedGraph();
    const forwardIds = flattenRelationshipEdges(g.forward).map((r) => r.relationshipId).sort((a, b) => a - b);
    expect(forwardIds).toEqual([1, 2, 10, 11, 12, 20, 21]);
    // Inverse walks the same 7 IfcRel* records from the other direction.
    const inverseIds = flattenRelationshipEdges(g.inverse).map((r) => r.relationshipId).sort((a, b) => a - b);
    expect(inverseIds).toEqual([1, 2, 10, 11, 12, 20, 21]);
  });
});
