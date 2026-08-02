/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EntityTableBuilder,
  IfcTypeEnum,
  RelationshipGraphBuilder,
  RelationshipType,
  StringTable,
} from '@ifc-lite/data';
import { rebuildSpatialHierarchy, rebuildOnDemandMaps, registerAuthoredElement, buildSpatialAncestryIndex, collectSpatialContainerNames } from './spatialHierarchy';

describe('registerAuthoredElement', () => {
  function baseHierarchy() {
    const strings = new StringTable();
    const entities = new EntityTableBuilder(4, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCSITE', 's0', 'Site', '', '');
    entities.add(3, 'IFCBUILDING', 'b0', 'Building', '', '');
    entities.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    rels.addEdge(3, 4, RelationshipType.Aggregates, 102);
    const h = rebuildSpatialHierarchy(entities.build(), rels.build());
    assert.ok(h);
    return h;
  }
  const storeyNodeOf = (h: NonNullable<ReturnType<typeof rebuildSpatialHierarchy>>) =>
    h.project.children[0].children[0].children[0];

  it('adds an authored IfcSpace as a storey child node with a storey assignment', () => {
    const h = baseHierarchy();
    registerAuthoredElement(h, 4, 50, 'IFCSPACE', 'Kitchen');
    assert.equal(h.elementToStorey.get(50), 4, 'space resolves its storey');
    assert.ok(h.bySpace.has(50), 'space registered in bySpace');
    const space = storeyNodeOf(h).children.find((c) => c.expressId === 50);
    assert.ok(space, 'space is a child node of the storey');
    assert.equal(space.type, IfcTypeEnum.IfcSpace);
    assert.equal(space.name, 'Kitchen');
  });

  it('adds an authored contained element (slab) to the storey element list', () => {
    const h = baseHierarchy();
    registerAuthoredElement(h, 4, 60, 'IFCSLAB', 'Floor');
    assert.equal(h.elementToStorey.get(60), 4);
    assert.deepEqual(h.getStoreyElements(4), [60], 'slab joins the storey contained list');
  });

  it('is idempotent for repeated registration', () => {
    const h = baseHierarchy();
    registerAuthoredElement(h, 4, 50, 'IFCSPACE', 'Kitchen');
    registerAuthoredElement(h, 4, 50, 'IFCSPACE', 'Kitchen');
    registerAuthoredElement(h, 4, 60, 'IFCSLAB', 'Floor');
    registerAuthoredElement(h, 4, 60, 'IFCSLAB', 'Floor');
    assert.equal(storeyNodeOf(h).children.filter((c) => c.expressId === 50).length, 1);
    assert.deepEqual(h.getStoreyElements(4), [60]);
  });

  it('falls back to a type name when no name is given', () => {
    const h = baseHierarchy();
    registerAuthoredElement(h, 4, 51, 'IFCSPACE', '');
    const space = storeyNodeOf(h).children.find((c) => c.expressId === 51);
    assert.equal(space?.name, 'IfcSpace');
  });
});

describe('rebuildSpatialHierarchy', () => {
  it('preserves IFC4.3 facility-part trees during cache rebuilds', () => {
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

    const hierarchy = rebuildSpatialHierarchy(entities.build(), relationships.build());
    assert.ok(hierarchy);
    assert.equal(hierarchy.project.children[0].type, IfcTypeEnum.IfcBridge);
    assert.equal(hierarchy.project.children[0].children[0].type, IfcTypeEnum.IfcBridgePart);
    assert.deepEqual(hierarchy.project.children[0].children[0].elements, [4]);
    assert.equal(hierarchy.elementToStorey.get(4), undefined);
    assert.deepEqual(hierarchy.getPath(4).map((node) => node.expressId), [1, 2, 3]);
  });

  it('propagates storey assignment to aggregated descendants of wall parts (Revit multilayer walls)', () => {
    // Scenario: Revit-exported wall with three IfcBuildingElementPart aggregate
    // children. The wall is directly contained in the storey via
    // IfcRelContainedInSpatialStructure; the parts are reachable only through
    // IfcRelAggregates. Pre-fix, the parts had no `elementToStorey` entry and
    // clicking a part returned "no storey". The fix walks aggregate descendants
    // of every storey-contained element and inherits the storey assignment.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(8, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCSITE', 's0', 'Site', '', '');
    entities.add(3, 'IFCBUILDING', 'b0', 'Building', '', '');
    entities.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    entities.add(5, 'IFCWALL', 'w0', 'Multilayer Wall', '', '', true);
    entities.add(6, 'IFCBUILDINGELEMENTPART', 'part-a', 'Layer A', '', '', true);
    entities.add(7, 'IFCBUILDINGELEMENTPART', 'part-b', 'Layer B', '', '', true);
    entities.add(8, 'IFCBUILDINGELEMENTPART', 'part-c', 'Layer C', '', '', true);

    const relationships = new RelationshipGraphBuilder();
    // Spatial decomposition.
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 101);
    relationships.addEdge(3, 4, RelationshipType.Aggregates, 102);
    // Wall is directly contained in the storey.
    relationships.addEdge(4, 5, RelationshipType.ContainsElements, 103);
    // Parts are aggregated into the wall (NOT directly contained in the storey).
    relationships.addEdge(5, 6, RelationshipType.Aggregates, 104);
    relationships.addEdge(5, 7, RelationshipType.Aggregates, 105);
    relationships.addEdge(5, 8, RelationshipType.Aggregates, 106);

    const hierarchy = rebuildSpatialHierarchy(entities.build(), relationships.build());
    assert.ok(hierarchy);

    // The wall itself is in elementToStorey (direct containment).
    assert.equal(hierarchy.elementToStorey.get(5), 4);

    // Each aggregated part now inherits the wall's storey assignment.
    assert.equal(hierarchy.elementToStorey.get(6), 4);
    assert.equal(hierarchy.elementToStorey.get(7), 4);
    assert.equal(hierarchy.elementToStorey.get(8), 4);

    // getStoreyElements keeps its contract: only directly-contained elements.
    // Parts are intentionally NOT in this list — tree views rely on this.
    assert.deepEqual(hierarchy.getStoreyElements(4), [5]);
  });

  it('preserves direct storey containment when a part is also aggregated under another element', () => {
    // Edge case: a part is directly contained in storey A via
    // IfcRelContainedInSpatialStructure AND aggregated under a wall in storey B.
    // The direct containment must win (set first; descendant walk uses
    // `if (!elementToStorey.has(...))` to avoid clobbering).
    const strings = new StringTable();
    const entities = new EntityTableBuilder(6, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCBUILDING', 'b0', 'Building', '', '');
    entities.add(3, 'IFCBUILDINGSTOREY', 'st-a', 'Storey A', '', '');
    entities.add(4, 'IFCBUILDINGSTOREY', 'st-b', 'Storey B', '', '');
    entities.add(5, 'IFCWALL', 'w0', 'Wall (Storey B)', '', '', true);
    entities.add(6, 'IFCBUILDINGELEMENTPART', 'part-x', 'Shared Part', '', '', true);

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 200);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 201);
    relationships.addEdge(2, 4, RelationshipType.Aggregates, 202);
    // Part is directly contained in storey A.
    relationships.addEdge(3, 6, RelationshipType.ContainsElements, 203);
    // Wall is contained in storey B.
    relationships.addEdge(4, 5, RelationshipType.ContainsElements, 204);
    // Wall aggregates the same part (rare but legal).
    relationships.addEdge(5, 6, RelationshipType.Aggregates, 205);

    const hierarchy = rebuildSpatialHierarchy(entities.build(), relationships.build());
    assert.ok(hierarchy);
    // Direct containment in storey A wins. The descendant walk from storey B's
    // wall must NOT overwrite this.
    assert.equal(hierarchy.elementToStorey.get(6), 3);
    assert.equal(hierarchy.elementToStorey.get(5), 4);
  });

  it('promotes spaces/zones contained via IfcRelContainedInSpatialStructure to tree nodes (#1075)', () => {
    // Revit Family geometry authored via Dynamo attaches IfcSpace / IfcSpatialZone
    // to the storey with IfcRelContainedInSpatialStructure instead of
    // IfcRelAggregates. Pre-fix these were filtered out of containedElements (they
    // are spatial-structure types) and, lacking an aggregate link, vanished from
    // the tree. They must be promoted to spatial child nodes, get a space→storey
    // mapping, and stay out of the storey's flat element list.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(7, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCSITE', 's0', 'Site', '', '');
    entities.add(3, 'IFCBUILDING', 'b0', 'Building', '', '');
    entities.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    entities.add(5, 'IFCSPACE', 'sp-agg', 'Room 101', '', '', true);    // normal aggregated room
    entities.add(6, 'IFCSPACE', 'sp-con', 'Family Space', '', '', true); // contained (Dynamo)
    entities.add(7, 'IFCSPATIALZONE', 'sz-con', 'GFA Apt', '', '', true); // contained GFA zone

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 100);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 101);
    relationships.addEdge(3, 4, RelationshipType.Aggregates, 102);
    relationships.addEdge(4, 5, RelationshipType.Aggregates, 103);        // room aggregated
    relationships.addEdge(4, 6, RelationshipType.ContainsElements, 104);  // family space contained
    relationships.addEdge(4, 7, RelationshipType.ContainsElements, 105);  // GFA zone contained

    const hierarchy = rebuildSpatialHierarchy(entities.build(), relationships.build());
    assert.ok(hierarchy);

    const storey = hierarchy.project.children[0].children[0].children[0];
    assert.equal(storey.type, IfcTypeEnum.IfcBuildingStorey);

    // All three spatial elements are child nodes of the storey (aggregated + contained).
    const childIds = storey.children.map((n) => n.expressId).sort((a, b) => a - b);
    assert.deepEqual(childIds, [5, 6, 7]);
    assert.equal(storey.children.find((n) => n.expressId === 7)?.type, IfcTypeEnum.IfcSpatialZone);

    // Contained spaces/zones are NOT also listed as flat storey elements.
    assert.deepEqual(hierarchy.getStoreyElements(4), []);

    // Every space/zone resolves "which storey it's on" (properties panel lookup).
    assert.equal(hierarchy.elementToStorey.get(5), 4);
    assert.equal(hierarchy.elementToStorey.get(6), 4);
    assert.equal(hierarchy.elementToStorey.get(7), 4);
  });

  it('terminates in bounded time on malformed aggregate cycles', () => {
    // Cycle guard: part references back to wall via IfcRelAggregates. Without
    // the `seen` set, the descendant walk would infinite-loop.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(6, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCBUILDING', 'b0', 'Building', '', '');
    entities.add(3, 'IFCBUILDINGSTOREY', 'st0', 'Storey', '', '');
    entities.add(4, 'IFCWALL', 'w0', 'Wall', '', '', true);
    entities.add(5, 'IFCBUILDINGELEMENTPART', 'part-a', 'Part A', '', '', true);
    entities.add(6, 'IFCBUILDINGELEMENTPART', 'part-b', 'Part B', '', '', true);

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 300);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 301);
    relationships.addEdge(3, 4, RelationshipType.ContainsElements, 302);
    relationships.addEdge(4, 5, RelationshipType.Aggregates, 303);
    relationships.addEdge(5, 6, RelationshipType.Aggregates, 304);
    // Malformed back-edges forming a cycle: part-b -> wall, part-a -> wall.
    relationships.addEdge(6, 4, RelationshipType.Aggregates, 305);
    relationships.addEdge(5, 4, RelationshipType.Aggregates, 306);

    const start = Date.now();
    const hierarchy = rebuildSpatialHierarchy(entities.build(), relationships.build());
    const elapsedMs = Date.now() - start;

    assert.ok(hierarchy);
    // Must finish quickly; without cycle guard this would never terminate.
    // Generous bound for slow CI runners.
    assert.ok(elapsedMs < 1000, `expected fast termination, took ${elapsedMs}ms`);

    // All entities still get correct storey assignment despite the cycle.
    assert.equal(hierarchy.elementToStorey.get(4), 3);
    assert.equal(hierarchy.elementToStorey.get(5), 3);
    assert.equal(hierarchy.elementToStorey.get(6), 3);
  });
});

describe('buildSpatialAncestryIndex', () => {
  it('resolves project / site / building names for a contained element', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(5, strings);
    eb.add(1, 'IFCPROJECT', 'p0', 'My Project', '', '');
    eb.add(2, 'IFCSITE', 's0', 'North Site', '', '');
    eb.add(3, 'IFCBUILDING', 'b0', 'Tower A', '', '');
    eb.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    eb.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    rels.addEdge(3, 4, RelationshipType.Aggregates, 102);
    rels.addEdge(4, 5, RelationshipType.ContainsElements, 103);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id));
    assert.equal(idx.projectName, 'My Project');
    assert.equal(idx.siteOf(5), 'North Site');
    assert.equal(idx.buildingOf(5), 'Tower A');
    // A container queried by its own id resolves self-inclusively.
    assert.equal(idx.siteOf(2), 'North Site');
    assert.equal(idx.buildingOf(3), 'Tower A');
  });

  it('resolves IFC4X3 facilities (IfcBridge) at the building level', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(4, strings);
    eb.add(1, 'IFCPROJECT', '0', 'Infra Project', '', '');
    eb.add(2, 'IFCBRIDGE', '1', 'Bridge A', '', '');
    eb.add(3, 'IFCBRIDGEPART', '2', 'Deck', '', '');
    eb.add(4, 'IFCWALL', '3', 'Barrier', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 10);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 11);
    rels.addEdge(3, 4, RelationshipType.ContainsElements, 12);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id));
    assert.equal(idx.buildingOf(4), 'Bridge A');
    assert.equal(idx.siteOf(4), ''); // no IfcSite in this tree
  });

  it('returns "" for an unnamed container and an unplaced element', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(5, strings);
    eb.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    eb.add(2, 'IFCSITE', 's0', 'Site', '', '');
    eb.add(3, 'IFCBUILDING', 'b0', '', '', ''); // unnamed building
    eb.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    eb.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    rels.addEdge(3, 4, RelationshipType.Aggregates, 102);
    rels.addEdge(4, 5, RelationshipType.ContainsElements, 103);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id));
    // Unnamed IfcBuilding resolves to '' (not the `Entity #N` node placeholder).
    assert.equal(idx.buildingOf(5), '');
    assert.equal(idx.siteOf(5), 'Site');
    // An element the hierarchy doesn't place resolves to ''.
    assert.equal(idx.siteOf(9999), '');
    assert.equal(idx.buildingOf(9999), '');
  });

  it('resolves parts reachable only through the storey reverse index', () => {
    // A wall part is aggregated under the wall (not directly contained); it
    // inherits the wall's storey, so ancestry resolves via elementToStorey.
    const strings = new StringTable();
    const eb = new EntityTableBuilder(6, strings);
    eb.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    eb.add(2, 'IFCSITE', 's0', 'Site', '', '');
    eb.add(3, 'IFCBUILDING', 'b0', 'Building', '', '');
    eb.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    eb.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);
    eb.add(6, 'IFCBUILDINGELEMENTPART', 'part', 'Layer A', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    rels.addEdge(3, 4, RelationshipType.Aggregates, 102);
    rels.addEdge(4, 5, RelationshipType.ContainsElements, 103);
    rels.addEdge(5, 6, RelationshipType.Aggregates, 104);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id));
    assert.equal(idx.buildingOf(6), 'Building');
    assert.equal(idx.siteOf(6), 'Site');
  });

  // Nested same-type containers (IfcSite within IfcSite). The element's nearest
  // site is the INNER site; an unnamed inner site must NOT inherit the outer
  // site's name (it is a different, unnamed site), so it resolves to ''.
  it('does not inherit an ancestor site name across same-type nesting', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(6, strings);
    eb.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    eb.add(2, 'IFCSITE', 's-outer', 'Environment', '', '');
    eb.add(3, 'IFCSITE', 's-inner', '', '', ''); // unnamed nested site
    eb.add(4, 'IFCBUILDING', 'b0', 'House', '', '');
    eb.add(5, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    eb.add(6, 'IFCWALL', 'w0', 'Wall', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101); // site within site
    rels.addEdge(3, 4, RelationshipType.Aggregates, 102);
    rels.addEdge(4, 5, RelationshipType.Aggregates, 103);
    rels.addEdge(5, 6, RelationshipType.ContainsElements, 104);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id));
    assert.equal(idx.siteOf(6), ''); // NOT 'Environment'
    assert.equal(idx.buildingOf(6), 'House');
  });

  // #1591 follow-up: `containerOf` resolves the element's IMMEDIATE container
  // (the direct IfcRelContainedInSpatialStructure parent), at whatever level —
  // a non-storey IfcBridgePart here — with the container's IFC class as the
  // fallback when it is unnamed, and '' for an unplaced element.
  it('containerOf resolves the immediate non-storey container, class fallback when unnamed', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(6, strings);
    eb.add(1, 'IFCPROJECT', 'p0', 'Infra Project', '', '');
    eb.add(2, 'IFCBRIDGE', 'br', 'Bridge A', '', '');
    eb.add(3, 'IFCBRIDGEPART', 'deck', 'Deck', '', '');
    eb.add(4, 'IFCBRIDGEPART', 'pier', '', '', ''); // unnamed part
    eb.add(5, 'IFCWALL', 'w0', 'Barrier', '', '', true);
    eb.add(6, 'IFCWALL', 'w1', 'Parapet', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    rels.addEdge(2, 4, RelationshipType.Aggregates, 102);
    rels.addEdge(3, 5, RelationshipType.ContainsElements, 103);
    rels.addEdge(4, 6, RelationshipType.ContainsElements, 104);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id), (id) => et.getTypeName(id));
    // The immediate container, NOT the bridge/facility above it.
    assert.equal(idx.containerOf(5), 'Deck');
    // Unnamed container falls back to its IFC class.
    assert.equal(idx.containerOf(6), 'IfcBridgePart');
    // An element the hierarchy doesn't place resolves to ''.
    assert.equal(idx.containerOf(9999), '');
  });

  it('containerOf resolves the storey for storey-contained elements and aggregated parts', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(6, strings);
    eb.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    eb.add(2, 'IFCSITE', 's0', 'Site', '', '');
    eb.add(3, 'IFCBUILDING', 'b0', 'Building', '', '');
    eb.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    eb.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);
    eb.add(6, 'IFCBUILDINGELEMENTPART', 'part', 'Layer A', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    rels.addEdge(3, 4, RelationshipType.Aggregates, 102);
    rels.addEdge(4, 5, RelationshipType.ContainsElements, 103);
    rels.addEdge(5, 6, RelationshipType.Aggregates, 104); // part: aggregated, not contained
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id), (id) => et.getTypeName(id));
    assert.equal(idx.containerOf(5), 'Level 1');
    // Aggregated part: not directly contained, falls back to its storey.
    assert.equal(idx.containerOf(6), 'Level 1');
  });

  it('uses the nearest named site when a nested inner site IS named', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(5, strings);
    eb.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    eb.add(2, 'IFCSITE', 's-outer', 'Environment', '', '');
    eb.add(3, 'IFCSITE', 's-inner', 'House Site', '', ''); // named nested site
    eb.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', '');
    eb.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    rels.addEdge(3, 4, RelationshipType.Aggregates, 102);
    rels.addEdge(4, 5, RelationshipType.ContainsElements, 103);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const idx = buildSpatialAncestryIndex(h, (id) => et.getName(id));
    assert.equal(idx.siteOf(5), 'House Site');
  });
});

describe('collectSpatialContainerNames', () => {
  it('collects distinct named site / building / project names, skipping unnamed', () => {
    const strings = new StringTable();
    const eb = new EntityTableBuilder(6, strings);
    eb.add(1, 'IFCPROJECT', 'p0', 'My Project', '', '');
    eb.add(2, 'IFCSITE', 's0', 'North Site', '', '');
    eb.add(3, 'IFCBRIDGE', 'br', 'Bridge A', '', ''); // building-like (IFC4X3)
    eb.add(4, 'IFCBUILDING', 'b0', '', '', ''); // unnamed building -> skipped
    eb.add(5, 'IFCBUILDINGSTOREY', 'st0', 'Level 1', '', ''); // storey -> not a level
    eb.add(6, 'IFCWALL', 'w0', 'Wall', '', '', true);
    const rels = new RelationshipGraphBuilder();
    rels.addEdge(1, 2, RelationshipType.Aggregates, 100);
    rels.addEdge(2, 3, RelationshipType.Aggregates, 101);
    rels.addEdge(2, 4, RelationshipType.Aggregates, 102);
    rels.addEdge(4, 5, RelationshipType.Aggregates, 103);
    rels.addEdge(5, 6, RelationshipType.ContainsElements, 104);
    const et = eb.build();
    const h = rebuildSpatialHierarchy(et, rels.build());
    assert.ok(h);
    const names = collectSpatialContainerNames(h, (id) => et.getName(id));
    assert.deepEqual(names.projects, ['My Project']);
    assert.deepEqual(names.sites, ['North Site']);
    assert.deepEqual(names.buildings, ['Bridge A']); // facility included; unnamed building skipped
  });
});

describe('rebuildOnDemandMaps', () => {
  const makeEntityIndex = (byType: Map<string, number[]>) => ({
    byId: { get: () => undefined, has: () => false, size: 0 },
    byType,
  });

  it('rebuilds onDemandMaterialMap from AssociatesMaterial edges (cache parity)', () => {
    const strings = new StringTable();
    const entities = new EntityTableBuilder(2, strings);
    entities.add(5, 'IFCBEAM', 'b0', 'Beam', '', '', true);
    entities.add(10, 'IFCMATERIAL', 'm0', 'Concrete', '', '');

    const builder = new RelationshipGraphBuilder();
    // material(10) -> element(5) forward, matching the columnar parser.
    builder.addEdge(10, 5, RelationshipType.AssociatesMaterial, 100);
    // pset(20) -> element(5), so the property map still rebuilds too.
    builder.addEdge(20, 5, RelationshipType.DefinesByProperties, 101);

    const entityIndex = makeEntityIndex(new Map<string, number[]>([
      ['IFCMATERIAL', [10]],
      ['IFCPROPERTYSET', [20]],
    ]));

    const { onDemandMaterialMap, onDemandPropertyMap } = rebuildOnDemandMaps(
      entities.build(),
      builder.build(),
      entityIndex,
    );

    assert.equal(onDemandMaterialMap.size, 1);
    assert.deepEqual(onDemandMaterialMap.get(5), [10]);
    assert.deepEqual(onDemandPropertyMap.get(5), [20]);
  });

  it('matches material definitions case-insensitively (mixed-case byType keys)', () => {
    const strings = new StringTable();
    const entities = new EntityTableBuilder(2, strings);
    entities.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);
    entities.add(40, 'IFCMATERIALLAYERSET', 'ls0', 'Buildup', '', '');

    const builder = new RelationshipGraphBuilder();
    builder.addEdge(40, 5, RelationshipType.AssociatesMaterial, 100);

    const entityIndex = makeEntityIndex(new Map<string, number[]>([
      ['IfcMaterialLayerSet', [40]], // mixed-case, as some cache writers emit
    ]));

    const { onDemandMaterialMap } = rebuildOnDemandMaps(entities.build(), builder.build(), entityIndex);
    assert.deepEqual(onDemandMaterialMap.get(5), [40]);
  });

  it('picks the LOWEST rel express id when an element has multiple associations (parse parity)', () => {
    // The columnar parser's winner rule is "lowest IfcRelAssociatesMaterial
    // express id". The rebuild iterates byType buckets — a DIFFERENT order —
    // so it must decide by edge relationshipId, not encounter order. Bucket
    // order here is adversarial: the losing material (#41, via later rel #200)
    // is enumerated FIRST.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(3, strings);
    entities.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);
    entities.add(40, 'IFCMATERIALLAYERSET', 'ls0', 'Buildup', '', '');
    entities.add(41, 'IFCMATERIAL', 'm0', 'Fallback', '', '');

    const builder = new RelationshipGraphBuilder();
    builder.addEdge(41, 5, RelationshipType.AssociatesMaterial, 200); // later rel
    builder.addEdge(40, 5, RelationshipType.AssociatesMaterial, 100); // earlier rel → winner

    const entityIndex = makeEntityIndex(new Map<string, number[]>([
      ['IFCMATERIAL', [41]],          // losing def enumerated first
      ['IFCMATERIALLAYERSET', [40]],
    ]));

    const { onDemandMaterialMap } = rebuildOnDemandMaps(entities.build(), builder.build(), entityIndex);
    assert.deepEqual(onDemandMaterialMap.get(5), [40, 41], 'list[0] = RelatingMaterial of the lowest rel express id');
  });

  it('recognises IFC4 material subtypes as RelatingMaterial (cache parity)', () => {
    // IfcMaterialLayerWithOffsets / IfcMaterialProfileWithOffsets /
    // IfcMaterialProfileSetUsageTapering are legal IfcMaterialSelect members;
    // a fresh parse maps them, so the cache rebuild must too.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(6, strings);
    entities.add(5, 'IFCWALL', 'w0', 'Wall', '', '', true);
    entities.add(6, 'IFCCOLUMN', 'c0', 'Column', '', '', true);
    entities.add(7, 'IFCBEAM', 'b0', 'Beam', '', '', true);
    entities.add(60, 'IFCMATERIALLAYERWITHOFFSETS', 'lo0', 'Layer', '', '');
    entities.add(61, 'IFCMATERIALPROFILEWITHOFFSETS', 'po0', 'Profile', '', '');
    entities.add(62, 'IFCMATERIALPROFILESETUSAGETAPERING', 'pt0', 'Taper', '', '');

    const builder = new RelationshipGraphBuilder();
    builder.addEdge(60, 5, RelationshipType.AssociatesMaterial, 100);
    builder.addEdge(61, 6, RelationshipType.AssociatesMaterial, 101);
    builder.addEdge(62, 7, RelationshipType.AssociatesMaterial, 102);

    const entityIndex = makeEntityIndex(new Map<string, number[]>([
      ['IFCMATERIALLAYERWITHOFFSETS', [60]],
      ['IFCMATERIALPROFILEWITHOFFSETS', [61]],
      ['IFCMATERIALPROFILESETUSAGETAPERING', [62]],
    ]));

    const { onDemandMaterialMap } = rebuildOnDemandMaps(entities.build(), builder.build(), entityIndex);
    assert.deepEqual(onDemandMaterialMap.get(5), [60]);
    assert.deepEqual(onDemandMaterialMap.get(6), [61]);
    assert.deepEqual(onDemandMaterialMap.get(7), [62]);
  });
});
