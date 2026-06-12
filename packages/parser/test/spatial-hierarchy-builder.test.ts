/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  EntityTableBuilder,
  IfcTypeEnum,
  RelationshipGraphBuilder,
  RelationshipType,
  StringTable,
} from '@ifc-lite/data';
import { SpatialHierarchyBuilder } from '../src/spatial-hierarchy-builder.js';

describe('SpatialHierarchyBuilder', () => {
  it('builds IFC4.3 facility hierarchies and expands elements through facility parts', () => {
    const strings = new StringTable();
    const entities = new EntityTableBuilder(4, strings);
    entities.add(1, 'IFCPROJECT', '0', 'Infra Project', '', '');
    entities.add(2, 'IFCBRIDGE', '1', 'Bridge A', '', '');
    entities.add(3, 'IFCBRIDGEPART', '2', 'Deck', '', '');
    entities.add(4, 'IFCWALL', '3', 'Barrier', '', '', true);

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 10);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 11);
    relationships.addEdge(3, 4, RelationshipType.ContainsElements, 12);

    const hierarchy = new SpatialHierarchyBuilder().build(
      entities.build(),
      relationships.build(),
      strings,
      new Uint8Array(),
      { byId: { get: () => undefined } },
    );

    expect(hierarchy.project.children).toHaveLength(1);
    expect(hierarchy.project.children[0].type).toBe(IfcTypeEnum.IfcBridge);
    expect(hierarchy.project.children[0].children[0].type).toBe(IfcTypeEnum.IfcBridgePart);
    expect(hierarchy.project.children[0].children[0].elements).toEqual([4]);
    expect(hierarchy.elementToStorey.get(4)).toBeUndefined();
    expect(hierarchy.getPath(4).map((node) => node.expressId)).toEqual([1, 2, 3]);
    expect(hierarchy.byBuilding.get(2)).toEqual([]);
  });

  it('keeps contained elements whose type was not categorized into the EntityTable', () => {
    // Reporter scenario: linear-placement-of-signal.ifc has an IfcRailway whose
    // IfcRelContainedInSpatialStructure names 26 IfcReferent / IfcSignal /
    // IfcAlignment children. Before the fix, the parser categorized those
    // IFC4x3 leaves as CAT_SKIP — they never entered the EntityTable, so
    // entityTypeMap.get(id) returned undefined and the contained-elements
    // filter silently dropped every child. The hierarchy panel rendered
    // "Default Railway Name" with zero elements even though the underlying
    // relationship graph had all 26 edges.
    //
    // This test simulates that exact shape: parent in the table, children
    // referenced only by the relationship graph. The hierarchy must surface
    // them so downstream panels can render them by expressId even when their
    // type was not pre-registered.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(2, strings);
    entities.add(1, 'IFCPROJECT', '0', 'Stationing', '', '');
    entities.add(2273, 'IFCRAILWAY', '1', 'Default Railway Name', '', '');

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2273, RelationshipType.Aggregates, 3043);
    // 26 children — none of these expressIds are added to the entity table.
    const referentIds = [
      2698, 2712, 2726, 2740, 2754, 2768, 2782, 2796, 2810, 2824,
      2838, 2852, 2866, 2880, 2894, 2908, 2922, 2936, 2950, 2964,
      2978, 2992, 3006,
    ];
    const signalIds = [3020, 3031];
    const alignmentId = 2278;
    for (const id of [alignmentId, ...referentIds, ...signalIds]) {
      relationships.addEdge(2273, id, RelationshipType.ContainsElements, 3042);
    }

    const hierarchy = new SpatialHierarchyBuilder().build(
      entities.build(),
      relationships.build(),
      strings,
      new Uint8Array(),
      { byId: { get: () => undefined } },
    );

    const railway = hierarchy.project.children[0];
    expect(railway.type).toBe(IfcTypeEnum.IfcRailway);
    expect(railway.elements).toHaveLength(1 + referentIds.length + signalIds.length);
    expect(railway.elements).toContain(alignmentId);
    expect(railway.elements).toContain(referentIds[0]);
    expect(railway.elements).toContain(signalIds[0]);
    // byBuilding aliases facility-like containers; the railway entry should
    // reflect the full element list, not the post-filter empty list.
    expect(hierarchy.byBuilding.get(2273)).toHaveLength(1 + referentIds.length + signalIds.length);
  });

  it('promotes spaces/zones contained via IfcRelContainedInSpatialStructure to tree nodes (#1075)', () => {
    // Fresh-parse path (this builder is what ColumnarParser uses). Revit Family
    // geometry authored via Dynamo attaches IfcSpace / IfcSpatialZone to a storey
    // with IfcRelContainedInSpatialStructure instead of IfcRelAggregates. Such a
    // space was filtered out of containedElements (it is a spatial-structure type)
    // and, lacking an aggregate link, vanished from the tree. It must be promoted
    // to a spatial child node, get a space→storey mapping, and stay out of the
    // storey's flat element list.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(7, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCSITE', 's0', 'Site', '', '');
    entities.add(3, 'IFCBUILDING', 'b0', 'Building', '', '');
    entities.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    entities.add(5, 'IFCSPACE', 'sp-agg', 'Room 101', '', '', true);    // aggregated room
    entities.add(6, 'IFCSPACE', 'sp-con', 'Family Space', '', '', true); // contained (Dynamo)
    entities.add(7, 'IFCSPATIALZONE', 'sz-con', 'GFA Apt', '', '', true); // contained GFA zone

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 101);
    relationships.addEdge(3, 4, RelationshipType.Aggregates, 102);
    relationships.addEdge(4, 5, RelationshipType.Aggregates, 103);
    relationships.addEdge(4, 6, RelationshipType.ContainsElements, 104);
    relationships.addEdge(4, 7, RelationshipType.ContainsElements, 105);

    const hierarchy = new SpatialHierarchyBuilder().build(
      entities.build(),
      relationships.build(),
      strings,
      new Uint8Array(),
      { byId: { get: () => undefined } },
    );

    const storey = hierarchy.project.children[0].children[0].children[0];
    expect(storey.type).toBe(IfcTypeEnum.IfcBuildingStorey);

    const childIds = storey.children.map((n) => n.expressId).sort((a, b) => a - b);
    expect(childIds).toEqual([5, 6, 7]);
    expect(storey.children.find((n) => n.expressId === 7)?.type).toBe(IfcTypeEnum.IfcSpatialZone);

    // Contained spaces/zones are not also listed as flat storey elements.
    expect(hierarchy.getStoreyElements(4)).toEqual([]);

    // Every space/zone resolves which storey it's on (properties panel lookup).
    expect(hierarchy.elementToStorey.get(5)).toBe(4);
    expect(hierarchy.elementToStorey.get(6)).toBe(4);
    expect(hierarchy.elementToStorey.get(7)).toBe(4);
  });
});
