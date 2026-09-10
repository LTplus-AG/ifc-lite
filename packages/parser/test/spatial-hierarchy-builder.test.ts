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
import type { EntityRef } from '../src/types.js';

/** Assemble a STEP source buffer + byId index from raw records, so the builder
 *  can read LongName off the bytes the way the real fresh-parse path does. All
 *  records are ASCII, so byte length equals string length. */
function buildStepSource(records: string[]): {
  source: Uint8Array;
  entityIndex: { byId: { get(expressId: number): EntityRef | undefined } };
} {
  const encoder = new TextEncoder();
  const byId = new Map<number, EntityRef>();
  let text = '';
  for (const record of records) {
    const expressId = Number(record.match(/^#(\d+)/)![1]);
    const type = record.match(/=\s*(\w+)/)![1];
    const byteOffset = encoder.encode(text).length;
    byId.set(expressId, {
      expressId,
      type,
      byteOffset,
      byteLength: encoder.encode(record).length,
      lineNumber: 0,
    });
    text += `${record}\n`;
  }
  return { source: encoder.encode(text), entityIndex: { byId } };
}

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

  it('builds an IFC4.3 marine facility down through its IfcMarinePart berths', () => {
    // `IfcMarineFacility` was a recognised spatial structure type while
    // `IfcMarinePart` — its only part type, the exact counterpart of
    // IfcBridgePart above — was not. `addSpatialChild` recurses only into a
    // child `isSpatialStructureType` accepts, so the berth node and the
    // mooring device it contained were dropped from the tree entirely: the
    // Hierarchy panel showed the facility with nothing under it.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(4, strings);
    entities.add(1, 'IFCPROJECT', '0', 'Port Project', '', '');
    entities.add(2, 'IFCMARINEFACILITY', '1', 'Harbour', '', '');
    entities.add(3, 'IFCMARINEPART', '2', 'Berth 4', '', '');
    entities.add(4, 'IFCMOORINGDEVICE', '3', 'Bollard', '', '', true);

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

    const facility = hierarchy.project.children[0];
    expect(facility.type).toBe(IfcTypeEnum.IfcMarineFacility);
    expect(facility.children.map((c) => c.type)).toEqual([IfcTypeEnum.IfcMarinePart]);
    expect(facility.children[0].elements).toEqual([4]);
    expect(hierarchy.getPath(4).map((node) => node.expressId)).toEqual([1, 2, 3]);
  });

  it('builds a generic IFC4.3 facility down through its IfcFacilityPartCommon segments', () => {
    // Same drop, the other missing IfcFacilityPart subtype. `IfcFacilityPart`
    // itself is ABSTRACT in IFC4X3, so a real file never carries one — the
    // concrete leaf is what has to be recognised.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(4, strings);
    entities.add(1, 'IFCPROJECT', '0', 'Campus Project', '', '');
    entities.add(2, 'IFCFACILITY', '1', 'Terminal', '', '');
    entities.add(3, 'IFCFACILITYPARTCOMMON', '2', 'Segment A', '', '');
    entities.add(4, 'IFCWALL', '3', 'Partition', '', '', true);

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

    const facility = hierarchy.project.children[0];
    expect(facility.children.map((c) => c.type)).toEqual([IfcTypeEnum.IfcFacilityPartCommon]);
    expect(facility.children[0].elements).toEqual([4]);
    expect(hierarchy.getPath(4).map((node) => node.expressId)).toEqual([1, 2, 3]);
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

  it('reads LongName off the source for spatial nodes, by schema attribute name (#1634)', () => {
    // ISO 19650: authors put a short code in Name ("01") and the descriptive
    // label in LongName ("Main Residence"). LongName sits at attribute index 7
    // for IfcSpatialStructureElement subtypes but at index 5 for IfcProject, so
    // the builder must resolve it by schema attribute NAME, not a fixed index.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(5, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCSITE', 's0', 'Site', '', '');
    entities.add(3, 'IFCBUILDING', 'b0', '01', '', '');
    entities.add(4, 'IFCBUILDING', 'b1', 'Garage', '', '');
    entities.add(5, 'IFCSPACE', 'sp0', '', '', '', true); // Name empty, label in LongName

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 101);
    relationships.addEdge(2, 4, RelationshipType.Aggregates, 102);
    relationships.addEdge(3, 5, RelationshipType.Aggregates, 103);

    const { source, entityIndex } = buildStepSource([
      // IfcProject: LongName at index 5 (GlobalId, OwnerHistory, Name,
      // Description, ObjectType, LongName, Phase, RepresentationContexts, Units).
      `#1=IFCPROJECT('p0',$,'Project',$,$,'Project Long',$,$,$);`,
      // IfcSite/IfcBuilding/IfcSpace: LongName at index 7.
      `#2=IFCSITE('s0',$,'Site',$,$,$,$,'The Whole Site',.ELEMENT.);`,
      `#3=IFCBUILDING('b0',$,'01',$,$,$,$,'Main Residence',.ELEMENT.);`,
      // LongName duplicates Name -> should be dropped (no redundant secondary).
      `#4=IFCBUILDING('b1',$,'Garage',$,$,$,$,'Garage',.ELEMENT.);`,
      // Empty Name -> LongName becomes the primary label, so no secondary.
      `#5=IFCSPACE('sp0',$,$,$,$,$,$,'Living Room',.ELEMENT.);`,
    ]);

    const hierarchy = new SpatialHierarchyBuilder().build(
      entities.build(),
      relationships.build(),
      strings,
      source,
      entityIndex,
    );

    const project = hierarchy.project;
    expect(project.name).toBe('Project');
    expect(project.longName).toBe('Project Long');

    const site = project.children[0];
    expect(site.name).toBe('Site');
    expect(site.longName).toBe('The Whole Site');

    const residence = site.children.find((n) => n.expressId === 3)!;
    expect(residence.name).toBe('01');
    expect(residence.longName).toBe('Main Residence');

    const garage = site.children.find((n) => n.expressId === 4)!;
    expect(garage.name).toBe('Garage');
    expect(garage.longName).toBeUndefined(); // duplicate of Name is dropped

    const space = residence.children[0];
    expect(space.expressId).toBe(5);
    expect(space.name).toBe('Living Room'); // fell back to LongName
    expect(space.longName).toBeUndefined(); // not duplicated into the secondary slot
  });

  it('resolves LongName for IFC4.3 facility/infra containers outside the IFC4 codegen pin (#1634)', () => {
    // IfcBridge / IfcBridgePart live only in the IFC4X3 schema, which the parser's
    // IFC4-pinned attribute registry does not carry. The name-by-index lookup must
    // fall back to the bundled schema union so LongName (index 7 for every
    // IfcSpatialStructureElement subtype) still resolves for infra models.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(3, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Infra Project', '', '');
    entities.add(2, 'IFCBRIDGE', 'br0', 'BR-01', '', '');
    entities.add(3, 'IFCBRIDGEPART', 'bp0', 'DECK', '', '');

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 10);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 11);

    const { source, entityIndex } = buildStepSource([
      `#1=IFCPROJECT('p0',$,'Infra Project',$,$,$,$,$,$);`,
      `#2=IFCBRIDGE('br0',$,'BR-01',$,$,$,$,'North Approach Bridge',.ELEMENT.,$);`,
      `#3=IFCBRIDGEPART('bp0',$,'DECK',$,$,$,$,'Bridge Deck',.PARTIAL.,$);`,
    ]);

    const hierarchy = new SpatialHierarchyBuilder().build(
      entities.build(),
      relationships.build(),
      strings,
      source,
      entityIndex,
    );

    const bridge = hierarchy.project.children[0];
    expect(bridge.type).toBe(IfcTypeEnum.IfcBridge);
    expect(bridge.name).toBe('BR-01');
    expect(bridge.longName).toBe('North Approach Bridge');

    const deck = bridge.children[0];
    expect(deck.type).toBe(IfcTypeEnum.IfcBridgePart);
    expect(deck.longName).toBe('Bridge Deck');
  });

  describe('cross-linked space (aggregated under one storey, contained under another) (#4095)', () => {
    // Malformed-but-real authoring pattern: StoreyA aggregates the space via
    // IfcRelAggregates, StoreyB merely contains it via
    // IfcRelContainedInSpatialStructure. The Rust server (apps/server, #3973)
    // resolves this with a canonical-parent pass: aggregation always wins,
    // computed from ALL IfcRelAggregates edges before any containment is
    // considered, so the result is independent of traversal/file order. This
    // builder must agree - both on which storey wins AND that the losing
    // storey retains no phantom reference to the node.
    //
    // #6 (IfcFurniture, contained IN the space) makes a real node
    // distinguishable from an empty stub: only the storey that gets the real
    // node has [6] flow through to its elements list via the space's subtree
    // (checked indirectly via elementToStorey/elementToContainer would need a
    // deeper walk - here we assert directly on children_ids-equivalent
    // (`storey.children`) and the space's own `elements`).
    function buildCrossLinkedFixture(order: 'A,B' | 'B,A') {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(6, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 'stA', 'Storey A', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'stB', 'Storey B', '', '');
      entities.add(5, 'IFCSPACE', 'sp0', 'Room', '', '', true);
      entities.add(6, 'IFCFURNITURE', 'fu0', 'Chair', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      if (order === 'A,B') {
        relationships.addEdge(1, 2, RelationshipType.Aggregates, 10);
        relationships.addEdge(1, 3, RelationshipType.Aggregates, 11);
      } else {
        relationships.addEdge(1, 3, RelationshipType.Aggregates, 11);
        relationships.addEdge(1, 2, RelationshipType.Aggregates, 10);
      }
      // StoreyA aggregates the space (canonical parent, per the Rust rule).
      relationships.addEdge(2, 5, RelationshipType.Aggregates, 20);
      // StoreyB merely contains the same space (loses the tie).
      relationships.addEdge(3, 5, RelationshipType.ContainsElements, 21);
      relationships.addEdge(5, 6, RelationshipType.ContainsElements, 22);

      return new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );
    }

    it.each([['A,B'], ['B,A']] as const)('resolves storey A as the canonical parent regardless of order (%s)', (order) => {
      const hierarchy = buildCrossLinkedFixture(order);
      const storeyA = hierarchy.project.children.find((n) => n.expressId === 2)!;
      const storeyB = hierarchy.project.children.find((n) => n.expressId === 3)!;

      // Defect 1: the aggregating storey must win regardless of DFS order.
      const spaceInA = storeyA.children.find((n) => n.expressId === 5);
      expect(spaceInA).toBeDefined();
      expect(spaceInA!.elements).toEqual([6]); // real node, not an empty stub

      // Defect 2: the merely-containing storey must NOT retain a phantom
      // reference to the id at all - asserting only the winner (defect 1)
      // would miss this; that is how it survived.
      expect(storeyB.children.map((n) => n.expressId)).not.toContain(5);
      expect(storeyB.children).toEqual([]);
    });

    it('produces an identical hierarchy shape for both orderings (order independence)', () => {
      const shape = (h: ReturnType<typeof buildCrossLinkedFixture>) => {
        const storeyA = h.project.children.find((n) => n.expressId === 2)!;
        const storeyB = h.project.children.find((n) => n.expressId === 3)!;
        return {
          storeyAChildren: storeyA.children.map((n) => n.expressId),
          storeyBChildren: storeyB.children.map((n) => n.expressId),
          spaceElements: storeyA.children.find((n) => n.expressId === 5)?.elements ?? [],
        };
      };
      expect(shape(buildCrossLinkedFixture('A,B'))).toEqual(shape(buildCrossLinkedFixture('B,A')));
    });

    it('breaks a same-precedence tie by first declaration order, not lowest express id (matches apps/server spatial.rs)', () => {
      // STEP does not require express ids to ascend with declaration
      // position. Storey A's IfcRelAggregates is declared FIRST but carries
      // a HIGH express id (#9999); Storey B's is declared SECOND with a LOW
      // id (#1). apps/server's canonical_parent (spatial.rs) does
      // `entry(...).or_insert(...)` while iterating relationships in the
      // Vec order `extract_relationships` scans the file in - i.e. first
      // occurrence wins, independent of numeric id. A lowest-express-id
      // tie-break (the bug) would instead pick Storey B here.
      const strings = new StringTable();
      const entities = new EntityTableBuilder(6, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 'stA', 'Storey A', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'stB', 'Storey B', '', '');
      entities.add(5, 'IFCSPACE', 'sp0', 'Room', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
      relationships.addEdge(1, 3, RelationshipType.Aggregates, 101);
      // Declared first, high express id.
      relationships.addEdge(2, 5, RelationshipType.Aggregates, 9999);
      // Declared second, low express id.
      relationships.addEdge(3, 5, RelationshipType.Aggregates, 1);

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      const storeyA = hierarchy.project.children.find((n) => n.expressId === 2)!;
      const storeyB = hierarchy.project.children.find((n) => n.expressId === 3)!;

      expect(storeyA.children.map((n) => n.expressId)).toContain(5);
      expect(storeyB.children.map((n) => n.expressId)).not.toContain(5);
    });
  });

  describe('spurious mutual aggregation back-edge (#4246)', () => {
    // Authoring-tool mistake: a parent/child aggregation pair declared in
    // BOTH directions. #1 Project, #2 Building, #3 Storey, #4 Wall (contained
    // in the storey). #2<->#3 is the mutual pair (#2->#3 real, #3->#2
    // spurious); #1->#2 is the real anchor to IfcProject. Order controls
    // whether the spurious back-edge is declared before or after the real
    // anchor edge - only declaration order should ever matter for a TIE, and
    // ties must never let a back-edge win.
    function buildFixture(order: 'spurious-first' | 'legit-first') {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(4, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDING', 'b0', 'Building', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'st0', 'Storey', '', '');
      entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      if (order === 'spurious-first') {
        relationships.addEdge(2, 3, RelationshipType.Aggregates, 10); // Building -> Storey (real)
        relationships.addEdge(3, 2, RelationshipType.Aggregates, 11); // Storey -> Building (spurious back-edge)
        relationships.addEdge(1, 2, RelationshipType.Aggregates, 12); // Project -> Building (real anchor, declared LAST)
      } else {
        relationships.addEdge(1, 2, RelationshipType.Aggregates, 10); // Project -> Building (real anchor, declared FIRST)
        relationships.addEdge(2, 3, RelationshipType.Aggregates, 11); // Building -> Storey (real)
        relationships.addEdge(3, 2, RelationshipType.Aggregates, 12); // Storey -> Building (spurious back-edge)
      }
      relationships.addEdge(3, 4, RelationshipType.ContainsElements, 20); // Storey contains Wall

      return new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );
    }

    it('survives the subtree and keeps the wall reachable when the back-edge is declared FIRST', () => {
      const hierarchy = buildFixture('spurious-first');

      expect(hierarchy.project.children.map((n) => n.expressId)).toEqual([2]);
      const building = hierarchy.project.children[0];
      expect(building.type).toBe(IfcTypeEnum.IfcBuilding);
      expect(building.children.map((n) => n.expressId)).toEqual([3]);
      expect(hierarchy.byStorey.get(3)).toEqual([4]);
      expect(hierarchy.byBuilding.size).toBeGreaterThan(0);
      expect(hierarchy.elementToStorey.get(4)).toBe(3);
    });

    it('is unchanged when the real anchor edge is declared first (self-healing baseline)', () => {
      const hierarchy = buildFixture('legit-first');

      expect(hierarchy.project.children.map((n) => n.expressId)).toEqual([2]);
      expect(hierarchy.byStorey.get(3)).toEqual([4]);
      expect(hierarchy.elementToStorey.get(4)).toBe(3);
    });

    it('produces an identical hierarchy shape regardless of back-edge declaration order', () => {
      const shape = (h: ReturnType<typeof buildFixture>) => ({
        projectChildren: h.project.children.map((n) => n.expressId),
        byStorey: [...h.byStorey.entries()],
        elementToStorey4: h.elementToStorey.get(4) ?? null,
      });
      expect(shape(buildFixture('spurious-first'))).toEqual(shape(buildFixture('legit-first')));
    });

    it('breaks a longer indirect aggregation back-edge cycle (A -> B -> C -> A) the same way', () => {
      // Same defect shape, one hop longer: #2 -> #3 -> #4 -> #2 forms a
      // 3-node cycle instead of a direct mutual pair. The direct "does the
      // child forward-aggregate this candidate" check would miss this; the
      // fix must walk the raw aggregation graph, not just direct children.
      const strings = new StringTable();
      const entities = new EntityTableBuilder(5, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDING', 'b0', 'Building', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'st0', 'Storey', '', '');
      entities.add(4, 'IFCBUILDINGSTOREY', 'st1', 'Mezzanine', '', '');
      entities.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(2, 3, RelationshipType.Aggregates, 10); // Building -> Storey (real)
      relationships.addEdge(3, 4, RelationshipType.Aggregates, 11); // Storey -> Mezzanine (real)
      relationships.addEdge(4, 2, RelationshipType.Aggregates, 12); // Mezzanine -> Building (spurious, closes the cycle)
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 13); // Project -> Building (real anchor, declared LAST)
      relationships.addEdge(4, 5, RelationshipType.ContainsElements, 20); // Mezzanine contains Wall

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      expect(hierarchy.project.children.map((n) => n.expressId)).toEqual([2]);
      expect(hierarchy.elementToStorey.get(5)).toBe(4);
      expect(hierarchy.byStorey.get(4)).toEqual([5]);
    });
  });

  describe('duplicate direct storey containment resolves first-declared, matching containedIn() (#4248)', () => {
    // Malformed-but-real: an element named as the target of TWO
    // IfcRelContainedInSpatialStructure edges, from two different storeys.
    // #1 Project, #2 Storey A, #3 Storey B, #4 Wall. Maintainer ruling on
    // #4248: first-declared ContainsElements edge wins, matching
    // packages/query's `containedIn()` (`getRelated(ContainsElements,
    // 'inverse')[0]`, which reads `relationships.inverse.getEdges(...)[0]` -
    // the same first-declared-by-construction CSR order
    // spatial-hierarchy-canonical-parent.ts documents and relies on).
    it('storey A declared/visited first: wall resolves to storey A', () => {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(4, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 'st0', 'Storey A', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'st1', 'Storey B', '', '');
      entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 10); // Project -> Storey A
      relationships.addEdge(1, 3, RelationshipType.Aggregates, 11); // Project -> Storey B
      relationships.addEdge(2, 4, RelationshipType.ContainsElements, 20); // Storey A contains Wall (first-declared)
      relationships.addEdge(3, 4, RelationshipType.ContainsElements, 21); // Storey B contains Wall (second-declared)

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      expect(hierarchy.elementToStorey.get(4)).toBe(2);
    });

    // Mirror image: the ContainsElements edges are declared in the OPPOSITE
    // order (storey B first). Must resolve to storey B - swapping which edge
    // is first-declared flips the answer. A fixture that "commutes" (gives
    // the same answer regardless of which edge is declared first) would not
    // actually be testing the tie-break at all.
    it('storey B declared first: wall resolves to storey B', () => {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(4, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 'st0', 'Storey A', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'st1', 'Storey B', '', '');
      entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 10); // Project -> Storey A
      relationships.addEdge(1, 3, RelationshipType.Aggregates, 11); // Project -> Storey B
      relationships.addEdge(3, 4, RelationshipType.ContainsElements, 20); // Storey B contains Wall (first-declared)
      relationships.addEdge(2, 4, RelationshipType.ContainsElements, 21); // Storey A contains Wall (second-declared)

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      expect(hierarchy.elementToStorey.get(4)).toBe(3);
    });

    // The critical case: buildNode visits storeys in AGGREGATES order
    // (Storey A is Project's first aggregated child, so buildNode reaches it
    // before Storey B), but the WALL's first-declared ContainsElements edge
    // names Storey B. A naive "first write during traversal wins" fix would
    // let Storey A win here (visited first), which disagrees with
    // containedIn() (first-declared inverse CSR edge = Storey B). The
    // resolution must be keyed off ContainsElements declaration order for
    // the element itself, independent of which storey the tree walk reaches
    // first - the same global, order-of-visits-independent approach
    // computeCanonicalParent uses for spatial-structure children.
    it('resolves by ContainsElements order even when it disagrees with storey traversal order', () => {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(4, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 'st0', 'Storey A', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'st1', 'Storey B', '', '');
      entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      // Storey B is visited FIRST in the tree (first aggregated child of
      // Project) - the opposite of its ContainsElements declaration order
      // below. A "whichever storey the tree walk reaches first/last wins"
      // implementation (either direction) would disagree with the correct
      // answer here; only resolving off ContainsElements declaration order
      // for the element itself gets this right regardless of traversal order.
      relationships.addEdge(1, 3, RelationshipType.Aggregates, 10); // Project -> Storey B
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 11); // Project -> Storey A
      // But the Wall's ContainsElements edges are declared with Storey A FIRST.
      relationships.addEdge(2, 4, RelationshipType.ContainsElements, 20); // Storey A contains Wall (first-declared)
      relationships.addEdge(3, 4, RelationshipType.ContainsElements, 21); // Storey B contains Wall (second-declared)

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      // Must be Storey A (2), the first-declared ContainsElements edge - NOT
      // Storey B (3), which is merely visited first in the spatial tree walk
      // (and would win under either a "first write during traversal" or a
      // "last write during traversal" naive fix, since traversal visits B
      // before A here).
      expect(hierarchy.elementToStorey.get(4)).toBe(2);
    });

    // Composed with #4246's cycle guard: Storey A is itself the child of a
    // spurious mutual aggregation back-edge (Building <-> Storey A), the
    // exact shape #4246 fixed. #4246's cycle-skip only ever changes which
    // BUILDING is picked as Storey A's Aggregates parent - Storey A is still
    // reached and visited either way (the fix's whole point is that the
    // child is never orphaned). It has no reach into ContainsElements
    // resolution at all (the cycle-skip branch in computeCanonicalParent is
    // gated on `relType === RelationshipType.Aggregates`). This fixture
    // proves the two fixes compose: the wall still resolves to Storey A (the
    // first-declared ContainsElements edge), independent of which building
    // parents Storey A or in what order that gets resolved.
    it('composes with the #4246 aggregation back-edge cycle guard', () => {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(5, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDING', 'b0', 'Building', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'st0', 'Storey A', '', '');
      entities.add(4, 'IFCBUILDINGSTOREY', 'st1', 'Storey B', '', '');
      entities.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      // Spurious mutual back-edge between Building and Storey A (#4246 shape),
      // back-edge declared FIRST so the cycle guard must actually engage.
      relationships.addEdge(2, 3, RelationshipType.Aggregates, 10); // Building -> Storey A (real)
      relationships.addEdge(3, 2, RelationshipType.Aggregates, 11); // Storey A -> Building (spurious back-edge)
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 12); // Project -> Building (real anchor)
      relationships.addEdge(1, 4, RelationshipType.Aggregates, 13); // Project -> Storey B is unreachable here;
      // route Storey B through Building instead so both storeys are siblings:
      relationships.addEdge(2, 4, RelationshipType.Aggregates, 14); // Building -> Storey B
      // Wall's first-declared ContainsElements edge names Storey A.
      relationships.addEdge(3, 5, RelationshipType.ContainsElements, 20); // Storey A contains Wall (first-declared)
      relationships.addEdge(4, 5, RelationshipType.ContainsElements, 21); // Storey B contains Wall (second-declared)

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      // Storey A must still be reachable (the #4246 fix's guarantee) and the
      // wall must still resolve to it (the #4248 fix's guarantee).
      expect(hierarchy.byBuilding.size).toBeGreaterThan(0);
      expect(hierarchy.byStorey.get(3)).toEqual([5]);
      expect(hierarchy.elementToStorey.get(5)).toBe(3);
    });

    // Regression for a corruption an adversarial review caught in this PR
    // itself (#4310): Storey A is named by the wall's first-declared
    // ContainsElements edge but has NO IfcRelAggregates edge at all - a
    // malformed/orphan spatial node, unreachable from IfcProject, so
    // buildNode never visits it and its own storey-assignment branch never
    // runs. A first-declared check that only looks at "is this edge's target
    // THIS storey" with no reachability notion drops the element entirely
    // (elementToStorey has no entry) instead of falling through to the
    // reachable, later-declared Storey B - silently losing data that the
    // pre-#4248 code assigned correctly. First-declared must mean first
    // among VIABLE (reachable) candidates, not first globally.
    it('falls through to the reachable later-declared storey when the first-declared one is unreachable (#4310)', () => {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(4, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 'st0', 'Storey A', '', ''); // orphan: no Aggregates edge from anywhere
      entities.add(3, 'IFCBUILDINGSTOREY', 'st1', 'Storey B', '', ''); // reachable
      entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      // Only Storey B is ever aggregated under Project - Storey A has no
      // IfcRelAggregates edge to anything, so it is never visited.
      relationships.addEdge(1, 3, RelationshipType.Aggregates, 10); // Project -> Storey B
      relationships.addEdge(2, 4, RelationshipType.ContainsElements, 20); // Storey A contains Wall (first-declared, unreachable)
      relationships.addEdge(3, 4, RelationshipType.ContainsElements, 21); // Storey B contains Wall (second-declared, reachable)

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      // Storey A was never visited, so it has no entry in byStorey at all.
      expect(hierarchy.byStorey.has(2)).toBe(false);
      // The wall must NOT be dropped - it must fall through to the reachable
      // Storey B, matching pre-#4248 behavior for this shape and NOT
      // matching containedIn() (see the packages/query parity test for the
      // documented remaining divergence in this exact unreachable-storey case).
      expect(hierarchy.byStorey.get(3)).toEqual([4]);
      expect(hierarchy.elementToStorey.get(4)).toBe(3);
    });
  });

  it('leaves longName undefined on the source-less cache-restore path', () => {
    const strings = new StringTable();
    const entities = new EntityTableBuilder(2, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCBUILDING', 'b0', '01', '', '');

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);

    const hierarchy = new SpatialHierarchyBuilder().buildFromCache(
      entities.build(),
      relationships.build(),
    )!;

    expect(hierarchy.project.children[0].name).toBe('01');
    expect(hierarchy.project.children[0].longName).toBeUndefined();
  });

  describe('ambiguousStorey (#4311)', () => {
    it('flags an element with two direct ContainsElements edges naming different storeys', () => {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(4, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 's0', 'Storey A', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 's1', 'Storey B', '', '');
      entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
      relationships.addEdge(1, 3, RelationshipType.Aggregates, 101);
      // Two DIFFERENT storeys both directly contain the same wall — genuinely
      // ambiguous, unlike a repeated declaration of the same edge.
      relationships.addEdge(2, 4, RelationshipType.ContainsElements, 200);
      relationships.addEdge(3, 4, RelationshipType.ContainsElements, 201);

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      // elementToStorey still resolves to exactly one storey (tie-break
      // unchanged by this issue) - the new part is that the ambiguity itself
      // is now visible.
      expect(hierarchy.elementToStorey.get(4)).toBeDefined();
      expect(hierarchy.ambiguousStorey).toBeDefined();
      expect(hierarchy.ambiguousStorey!.has(4)).toBe(true);
    });

    it('does NOT flag an element directly contained by only one storey (the ordinary case)', () => {
      // The important half of this pair: a signal that fires on an everyday,
      // unambiguous model is worse than no signal at all.
      const strings = new StringTable();
      const entities = new EntityTableBuilder(4, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 's0', 'Storey A', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 's1', 'Storey B', '', '');
      entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
      relationships.addEdge(1, 3, RelationshipType.Aggregates, 101);
      relationships.addEdge(2, 4, RelationshipType.ContainsElements, 200);

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      expect(hierarchy.elementToStorey.get(4)).toBe(2);
      expect(hierarchy.ambiguousStorey).toBeDefined();
      expect(hierarchy.ambiguousStorey!.has(4)).toBe(false);
      expect(hierarchy.ambiguousStorey!.size).toBe(0);
    });

    it('does NOT flag an element whose only duplicate is the SAME storey declared twice', () => {
      // Two IfcRelContainedInSpatialStructure instances naming the identical
      // (storey, element) pair collapse to one edge before this ever runs
      // (RelationshipGraphBuilder's source/target/type dedupe) - so this
      // fixture also proves the dedupe, not just the flag.
      const strings = new StringTable();
      const entities = new EntityTableBuilder(3, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 's0', 'Storey A', '', '');
      entities.add(3, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
      relationships.addEdge(2, 3, RelationshipType.ContainsElements, 200);
      relationships.addEdge(2, 3, RelationshipType.ContainsElements, 201); // redundant IfcRel

      const hierarchy = new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );

      expect(hierarchy.byStorey.get(2)).toEqual([3]);
      expect(hierarchy.ambiguousStorey!.has(3)).toBe(false);
    });

    it('flags on the cache-restore path too (no source buffer needed)', () => {
      const strings = new StringTable();
      const entities = new EntityTableBuilder(4, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
      entities.add(2, 'IFCBUILDINGSTOREY', 's0', 'Storey A', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 's1', 'Storey B', '', '');
      entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
      relationships.addEdge(1, 3, RelationshipType.Aggregates, 101);
      relationships.addEdge(2, 4, RelationshipType.ContainsElements, 200);
      relationships.addEdge(3, 4, RelationshipType.ContainsElements, 201);

      const hierarchy = new SpatialHierarchyBuilder().buildFromCache(
        entities.build(),
        relationships.build(),
      )!;

      expect(hierarchy.ambiguousStorey!.has(4)).toBe(true);
    });

    it('flags the same element as ambiguous regardless of which storey elementToStorey resolves to', () => {
      // spatial-hierarchy-ambiguity.ts's doc claims computeAmbiguousStorey() is
      // agnostic to the elementToStorey tie-break. Prove it: two fixtures with
      // IDENTICAL IfcRelAggregates order but REVERSED IfcRelContainedInSpatialStructure
      // declaration order. Post-#4310, declaration order (not aggregation order)
      // is what elementToStorey's tie-break follows - first-declared reachable
      // container wins, matching containedIn() (#4248) - so reversing which
      // storey's containment edge is declared first is what now flips the
      // winner. ambiguousStorey must report `true` for the wall in BOTH
      // fixtures even though the winner differs between them.
      const build = (containsOrder: readonly [number, number]) => {
        const strings = new StringTable();
        const entities = new EntityTableBuilder(4, strings);
        entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
        entities.add(2, 'IFCBUILDINGSTOREY', 's0', 'Storey A', '', '');
        entities.add(3, 'IFCBUILDINGSTOREY', 's1', 'Storey B', '', '');
        entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);

        const relationships = new RelationshipGraphBuilder();
        // Aggregation order held constant across both fixtures: post-#4310 it
        // no longer determines the elementToStorey winner.
        relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
        relationships.addEdge(1, 3, RelationshipType.Aggregates, 101);
        const [first, second] = containsOrder;
        relationships.addEdge(first, 4, RelationshipType.ContainsElements, 200);
        relationships.addEdge(second, 4, RelationshipType.ContainsElements, 201);

        return new SpatialHierarchyBuilder().build(
          entities.build(),
          relationships.build(),
          strings,
          new Uint8Array(),
          { byId: { get: () => undefined } },
        );
      };

      const storeyAFirst = build([2, 3]);
      const storeyBFirst = build([3, 2]);

      // The winner differs between the two fixtures (proving the tie-break is
      // declaration-order dependent, per #4248/#4310)...
      expect(storeyAFirst.elementToStorey.get(4)).not.toBe(
        storeyBFirst.elementToStorey.get(4),
      );
      // ...but the ambiguity signal itself does not.
      expect(storeyAFirst.ambiguousStorey!.has(4)).toBe(true);
      expect(storeyBFirst.ambiguousStorey!.has(4)).toBe(true);
    });
  });

  // ONE fixture, byte-identical in shape to the apps/server Rust fixture
  // added for parity verification (Project #1 -> Building #2 -> [Storey A
  // #3, Storey B #4], Wall #5 declared contained in both storeys). Proves
  // the TS parser path and the Rust server path agree: first-declared wins
  // on both sides, independent of which order the two containment edges
  // appear in.
  describe('cross-language parity with apps/server Rust fixture (#4310 investigation)', () => {
    function buildFixture(firstStorey: 3 | 4) {
      const secondStorey = firstStorey === 3 ? 4 : 3;
      const strings = new StringTable();
      const entities = new EntityTableBuilder(5, strings);
      entities.add(1, 'IFCPROJECT', 'p0', 'MyProject', '', '');
      entities.add(2, 'IFCBUILDING', 'b0', 'MyBuilding', '', '');
      entities.add(3, 'IFCBUILDINGSTOREY', 'st0', 'StoreyA', '', '');
      entities.add(4, 'IFCBUILDINGSTOREY', 'st1', 'StoreyB', '', '');
      entities.add(5, 'IFCWALL', 'w0', 'W1', '', '', true);

      const relationships = new RelationshipGraphBuilder();
      relationships.addEdge(1, 2, RelationshipType.Aggregates, 100); // Project -> Building
      relationships.addEdge(2, 3, RelationshipType.Aggregates, 101); // Building -> Storey A
      relationships.addEdge(2, 4, RelationshipType.Aggregates, 102); // Building -> Storey B
      relationships.addEdge(firstStorey, 5, RelationshipType.ContainsElements, 110);
      relationships.addEdge(secondStorey, 5, RelationshipType.ContainsElements, 111);

      return new SpatialHierarchyBuilder().build(
        entities.build(),
        relationships.build(),
        strings,
        new Uint8Array(),
        { byId: { get: () => undefined } },
      );
    }

    it('order A (Storey A #3 declared first): wall resolves to #3, matching the Rust fixture', () => {
      const hierarchy = buildFixture(3);
      // Rust: apps/server duplicate_storey_containment_resolves_first_declared_order_a
      // asserts sh.element_to_storey resolves element 5 to storey 3. Same
      // fixture, same winner.
      expect(hierarchy.elementToStorey.get(5)).toBe(3);
    });

    it('order B (Storey B #4 declared first): wall resolves to #4, matching the Rust fixture', () => {
      const hierarchy = buildFixture(4);
      // Rust: apps/server duplicate_storey_containment_resolves_first_declared_order_b
      // asserts sh.element_to_storey resolves element 5 to storey 4. Same
      // fixture, same winner.
      expect(hierarchy.elementToStorey.get(5)).toBe(4);
    });
  });
});
