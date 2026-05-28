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
import { rebuildSpatialHierarchy } from './spatialHierarchy';

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

  it('terminates without stack overflow on cyclic spatial aggregation (issue #841)', () => {
    // Regression for the House.ifc failure mode: a malformed
    // IfcRelAggregates edge points a spatial-structure entity back at
    // an ancestor. Pre-fix the recursive `buildNode` recursed
    // indefinitely along the cycle and tripped V8's "Maximum call
    // stack size exceeded" before any geometry showed.
    const strings = new StringTable();
    const entities = new EntityTableBuilder(4, strings);
    entities.add(1, 'IFCPROJECT', 'p0', 'Project', '', '');
    entities.add(2, 'IFCSITE', 's0', 'Site', '', '');
    entities.add(3, 'IFCBUILDING', 'b0', 'Building', '', '');
    entities.add(4, 'IFCBUILDINGSTOREY', 'st0', 'Storey', '', '');

    const relationships = new RelationshipGraphBuilder();
    relationships.addEdge(1, 2, RelationshipType.Aggregates, 400);
    relationships.addEdge(2, 3, RelationshipType.Aggregates, 401);
    relationships.addEdge(3, 4, RelationshipType.Aggregates, 402);
    // Cycle: storey aggregates back to the building.
    relationships.addEdge(4, 3, RelationshipType.Aggregates, 403);

    const hierarchy = rebuildSpatialHierarchy(entities.build(), relationships.build());
    assert.ok(hierarchy);
    // First-visit wins: building appears once under site, storey once
    // under building; the cycle edge is skipped.
    assert.equal(hierarchy.project.children[0].type, IfcTypeEnum.IfcSite);
    assert.equal(hierarchy.project.children[0].children[0].type, IfcTypeEnum.IfcBuilding);
    assert.equal(
      hierarchy.project.children[0].children[0].children[0].type,
      IfcTypeEnum.IfcBuildingStorey,
    );
    // The cycle back-edge yielded no extra child.
    assert.equal(
      hierarchy.project.children[0].children[0].children[0].children.length,
      0,
    );
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
