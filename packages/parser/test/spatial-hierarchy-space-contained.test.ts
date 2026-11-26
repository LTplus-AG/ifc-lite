/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { EntityTableBuilder, RelationshipGraphBuilder, RelationshipType, StringTable } from '@ifc-lite/data';
import { SpatialHierarchyBuilder } from '../src/spatial-hierarchy-builder.js';

type Edge = [from: number, to: number, type: RelationshipType];

function build(types: Array<[id: number, type: string]>, edges: Edge[]) {
  const strings = new StringTable();
  const entities = new EntityTableBuilder(types.length, strings);
  for (const [id, type] of types) entities.add(id, type, String(id), `n${id}`, '', '');
  const relationships = new RelationshipGraphBuilder();
  edges.forEach(([from, to, type], i) => relationships.addEdge(from, to, type, 100 + i));
  return new SpatialHierarchyBuilder().build(
    entities.build(), relationships.build(), strings, new Uint8Array(), { byId: { get: () => undefined } },
  );
}

const SPATIAL: Array<[number, string]> = [
  [1, 'IFCPROJECT'], [2, 'IFCSITE'], [3, 'IFCBUILDING'], [4, 'IFCBUILDINGSTOREY'], [5, 'IFCBUILDINGSTOREY'],
];
const SPATIAL_EDGES: Edge[] = [
  [1, 2, RelationshipType.Aggregates], [2, 3, RelationshipType.Aggregates],
  [3, 4, RelationshipType.Aggregates], [3, 5, RelationshipType.Aggregates],
];

describe('elementToStorey for elements a storey reaches only through an IfcSpace', () => {
  it('names the storey of an element contained in a space the storey aggregates, and of its parts', () => {
    const hierarchy = build(
      [...SPATIAL, [6, 'IFCSPACE'], [7, 'IFCFURNISHINGELEMENT'], [8, 'IFCBUILDINGELEMENTPART']],
      [...SPATIAL_EDGES,
        [4, 6, RelationshipType.Aggregates], [6, 7, RelationshipType.ContainsElements], [7, 8, RelationshipType.Aggregates]],
    );
    expect(hierarchy.elementToStorey.get(6)).toBe(4); // the space itself (already true)
    expect(hierarchy.elementToStorey.get(7)).toBe(4);
    expect(hierarchy.elementToStorey.get(8)).toBe(4);
    // The tree is unchanged: the element is still listed under its space, not the storey.
    expect(hierarchy.byStorey.get(4)).toEqual([]);
    expect(hierarchy.bySpace.get(6)).toEqual([7]);
  });

  it('reaches through a space nested in another space', () => {
    const hierarchy = build(
      [...SPATIAL, [6, 'IFCSPACE'], [9, 'IFCSPACE'], [7, 'IFCFURNISHINGELEMENT']],
      [...SPATIAL_EDGES,
        [4, 6, RelationshipType.Aggregates], [6, 9, RelationshipType.Aggregates], [9, 7, RelationshipType.ContainsElements]],
    );
    expect(hierarchy.elementToStorey.get(7)).toBe(4);
  });

  it('lets direct storey containment win over a space on another storey', () => {
    const hierarchy = build(
      [...SPATIAL, [6, 'IFCSPACE'], [7, 'IFCFURNISHINGELEMENT']],
      [...SPATIAL_EDGES,
        [4, 6, RelationshipType.Aggregates], [6, 7, RelationshipType.ContainsElements], [5, 7, RelationshipType.ContainsElements]],
    );
    expect(hierarchy.elementToStorey.get(7)).toBe(5);
  });

  it('keeps the parts of a directly contained element on its storey, whatever order the storeys are visited', () => {
    // Storey 4 aggregates a space containing E (with part P); storey 5 contains E directly.
    const hierarchy = build(
      [...SPATIAL, [6, 'IFCSPACE'], [7, 'IFCFURNISHINGELEMENT'], [8, 'IFCBUILDINGELEMENTPART']],
      [...SPATIAL_EDGES,
        [4, 6, RelationshipType.Aggregates], [6, 7, RelationshipType.ContainsElements],
        [5, 7, RelationshipType.ContainsElements], [7, 8, RelationshipType.Aggregates]],
    );
    expect(hierarchy.elementToStorey.get(7)).toBe(5);
    expect(hierarchy.elementToStorey.get(8)).toBe(5);
  });

  it('resolves an element reached through spaces on two storeys to the lowest storey id, whatever the declaration order', () => {
    // Malformed: E (#7) is contained in space #6 on storey 5 and in space #9 on storey 4.
    // Storey 5 is aggregated first, so it is visited first; the lowest id still wins,
    // matching rust/processing `claim_through_spaces` (same model in data_model/tests.rs).
    const hierarchy = build(
      [...SPATIAL, [6, 'IFCSPACE'], [9, 'IFCSPACE'], [7, 'IFCFURNISHINGELEMENT'], [8, 'IFCBUILDINGELEMENTPART']],
      [[1, 2, RelationshipType.Aggregates], [2, 3, RelationshipType.Aggregates],
        [3, 5, RelationshipType.Aggregates], [3, 4, RelationshipType.Aggregates],
        [5, 6, RelationshipType.Aggregates], [4, 9, RelationshipType.Aggregates],
        [6, 7, RelationshipType.ContainsElements], [9, 7, RelationshipType.ContainsElements],
        [7, 8, RelationshipType.Aggregates]],
    );
    expect(hierarchy.elementToStorey.get(7)).toBe(4);
    expect(hierarchy.elementToStorey.get(8)).toBe(4);
  });
});
