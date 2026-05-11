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
