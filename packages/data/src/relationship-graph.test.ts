/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  RelationshipGraphBuilder,
  relationshipGraphFromColumns,
  relationshipGraphToColumns,
} from './relationship-graph.js';
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
});
