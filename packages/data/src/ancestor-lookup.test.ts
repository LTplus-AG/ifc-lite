/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { collectSpatialAncestors, type AncestorRelationships } from './ancestor-lookup.js';
import { RelationshipType } from './relationship-type.js';

/** A tiny in-memory graph, built from `(child, parent, edgeKind)` triples,
 *  satisfying {@link AncestorRelationships}. `edgeKind` is which relation
 *  the child->parent edge is recorded under — `ContainsElements` for
 *  `IfcRelContainedInSpatialStructure`, `Aggregates` for `IfcRelAggregates`. */
function graph(edges: ReadonlyArray<readonly [number, number, RelationshipType]>): AncestorRelationships {
  return {
    getRelated(entityId, relType, direction) {
      if (direction === 'inverse') {
        // Parents of entityId via relType: edges where entityId is the child.
        return edges.filter(([child, , t]) => child === entityId && t === relType).map(([, parent]) => parent);
      }
      // Children of entityId via relType: edges where entityId is the parent.
      return edges.filter(([, parent, t]) => parent === entityId && t === relType).map(([child]) => child);
    },
  };
}

describe('collectSpatialAncestors', () => {
  it('walks a single containment hop', () => {
    const g = graph([[10, 1, RelationshipType.ContainsElements]]);
    expect(collectSpatialAncestors(g, 10)).toEqual([1]);
  });

  it('walks a single aggregation hop', () => {
    const g = graph([[10, 1, RelationshipType.Aggregates]]);
    expect(collectSpatialAncestors(g, 10)).toEqual([1]);
  });

  it('reaches a grandparent through BOTH edge kinds mixed in one walk', () => {
    // element(10) --contains--> storey(2) --aggregates--> building(1)
    const g = graph([
      [10, 2, RelationshipType.ContainsElements],
      [2, 1, RelationshipType.Aggregates],
    ]);
    expect(collectSpatialAncestors(g, 10)).toEqual([2, 1]);
  });

  it('reaches any depth, not just a fixed hop count', () => {
    // part(40) --aggregates--> assembly(30) --contains--> storey(20) --aggregates--> building(10) --aggregates--> site(1)
    const g = graph([
      [40, 30, RelationshipType.Aggregates],
      [30, 20, RelationshipType.ContainsElements],
      [20, 10, RelationshipType.Aggregates],
      [10, 1, RelationshipType.Aggregates],
    ]);
    expect(collectSpatialAncestors(g, 40)).toEqual([30, 20, 10, 1]);
  });

  it('an element with no upward edges has no ancestors — empty, not absent', () => {
    const g = graph([]);
    expect(collectSpatialAncestors(g, 99)).toEqual([]);
  });

  it('a mutual cycle terminates instead of hanging or overflowing the stack', () => {
    // 57 <-> 58 aggregate each other; 59 is aggregated under 57.
    const g = graph([
      [59, 57, RelationshipType.Aggregates],
      [57, 58, RelationshipType.Aggregates],
      [58, 57, RelationshipType.Aggregates],
    ]);
    const ancestors = collectSpatialAncestors(g, 59);
    expect(ancestors.slice().sort((a, b) => a - b)).toEqual([57, 58]);
  });

  it('a self-referencing edge terminates', () => {
    const g = graph([[5, 5, RelationshipType.Aggregates]]);
    expect(collectSpatialAncestors(g, 5)).toEqual([]);
  });

  it('a long chain (1000 hops) does not stack-overflow', () => {
    const edges: Array<[number, number, RelationshipType]> = [];
    for (let i = 0; i < 1000; i++) edges.push([i, i + 1, RelationshipType.ContainsElements]);
    const g = graph(edges);
    const ancestors = collectSpatialAncestors(g, 0);
    expect(ancestors.length).toBe(1000);
    expect(ancestors[ancestors.length - 1]).toBe(1000);
  });

  it('undefined relationships (no graph) yields no ancestors', () => {
    expect(collectSpatialAncestors(undefined, 1)).toEqual([]);
  });
});
