/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-package parity for duplicate direct storey containment (#4248).
 *
 * `SpatialHierarchyBuilder.build()` (packages/parser) computes
 * `elementToStorey`, a flat map. `EntityNode.containedIn()` (this package)
 * separately walks the same relationship graph's inverse ContainsElements
 * edges. Before the #4248 fix these two answered a duplicate-containment
 * query differently for the same element in the same file, with no way for
 * a caller to detect the disagreement. The maintainer's ruling was
 * first-declared wins, on BOTH paths - this file builds ONE
 * `RelationshipGraph` (via the same `RelationshipGraphBuilder` both
 * production code paths use) from a single edge list and feeds it into both
 * implementations, so a real disagreement between the two live
 * implementations - not a re-statement of either one - would fail here.
 */
import { EntityNode } from '../src/entity-node.js';
import { createMockStore, RelationshipType } from './mock-store.js';
import { SpatialHierarchyBuilder } from '@ifc-lite/parser';
import { EntityTableBuilder, RelationshipGraphBuilder, StringTable } from '@ifc-lite/data';

type Order = 'A-declared-first' | 'B-declared-first';

function buildRelationships(order: Order) {
  // #1 Project, #2 Storey A, #3 Storey B, #10 Wall (duplicate-contained by
  // both storeys directly).
  const first: [number, number] = order === 'A-declared-first' ? [2, 3] : [3, 2];
  const [firstStorey, secondStorey] = first;
  return [
    { source: 1, target: 2, type: RelationshipType.Aggregates, relId: 100 },
    { source: 1, target: 3, type: RelationshipType.Aggregates, relId: 101 },
    { source: firstStorey, target: 10, type: RelationshipType.ContainsElements, relId: 200 },
    { source: secondStorey, target: 10, type: RelationshipType.ContainsElements, relId: 201 },
  ];
}

describe('elementToStorey / containedIn() parity on duplicate direct containment (#4248)', () => {
  it.each<[Order, number]>([
    ['A-declared-first', 2],
    ['B-declared-first', 3],
  ])('%s: elementToStorey and containedIn() both resolve to storey #%i', (order, expectedStoreyId) => {
    const relationships = buildRelationships(order);

    // Path 1: packages/parser's SpatialHierarchyBuilder -> elementToStorey.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(10, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCBUILDINGSTOREY', 'st0', 'Storey A', '', '');
    entities.add(3, 'IFCBUILDINGSTOREY', 'st1', 'Storey B', '', '');
    entities.add(10, 'IFCWALL', 'w0', 'Wall', '', '', true);
    const relBuilder = new RelationshipGraphBuilder();
    for (const r of relationships) relBuilder.addEdge(r.source, r.target, r.type, r.relId);
    const hierarchy = new SpatialHierarchyBuilder().build(
      entities.build(),
      relBuilder.build(),
      strings,
      new Uint8Array(),
      { byId: { get: () => undefined } },
    );

    // Path 2: packages/query's EntityNode.containedIn(), over an
    // independently-built but IDENTICALLY-ORDERED RelationshipGraph (same
    // RelationshipGraphBuilder, same edge list, same declaration order).
    const store = createMockStore({
      entities: [
        { expressId: 1, type: 'IFCPROJECT', globalId: 'p0', name: 'Project' },
        { expressId: 2, type: 'IFCBUILDINGSTOREY', globalId: 'st0', name: 'Storey A' },
        { expressId: 3, type: 'IFCBUILDINGSTOREY', globalId: 'st1', name: 'Storey B' },
        { expressId: 10, type: 'IFCWALL', globalId: 'w0', name: 'Wall' },
      ],
      relationships,
    });
    const wallNode = new EntityNode(store, 10);

    expect(hierarchy.elementToStorey.get(10)).toBe(expectedStoreyId);
    expect(wallNode.containedIn()?.expressId).toBe(expectedStoreyId);
    // The actual parity assertion: both live implementations agree with
    // EACH OTHER, not just with the expected constant.
    expect(hierarchy.elementToStorey.get(10)).toBe(wallNode.containedIn()?.expressId);
  });
});
