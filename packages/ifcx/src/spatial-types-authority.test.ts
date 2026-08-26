/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which IFC classes this package treats as spatial structure.
 *
 * `SPATIAL_TYPES` is the gate in `hierarchy-builder.ts`: a class it does not
 * carry is not recursed into as a level of the spatial tree, and — because
 * `collectElementIds` uses the same set as its stop condition — is instead
 * flattened into its parent's *element* list along with everything beneath it.
 * So an IFC4.3 infrastructure file (`IfcSite / IfcRoad / IfcRoadPart / ...`)
 * lost every level below the site and listed the road itself as a piece of
 * furniture would have been listed.
 *
 * `@ifc-lite/data`'s `SPATIAL_STRUCTURE_TYPE_ENUMS` is this repo's single
 * answer to "is this entity part of the spatial tree" — the parser, the
 * viewer's hierarchy tree and the visibility adapters all read it. This file
 * pins that the IFCX path answers the same question the same way, in BOTH
 * directions, so the two cannot drift apart again.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  RelationshipType,
  SPATIAL_STRUCTURE_TYPE_ENUMS,
  IfcTypeEnumToString,
  isSpatialStructureTypeName,
} from '@ifc-lite/data';
import { buildHierarchy } from './hierarchy-builder.js';
import { parseIfcx } from './index.js';
import { ATTR, SPATIAL_TYPES } from './types.js';
import type { ComposedNode } from './types.js';
import type { SpatialNode } from '@ifc-lite/data';

function node(path: string, classCode?: string): ComposedNode {
  const attributes = new Map<string, unknown>();
  if (classCode) {
    attributes.set(ATTR.CLASS, { code: classCode, uri: `urn:${classCode}` });
  }
  return { path, attributes, children: new Map() };
}

function link(parent: ComposedNode, ...children: ComposedNode[]): void {
  for (const child of children) parent.children.set(child.path, child);
}

describe('SPATIAL_TYPES agrees with the shared spatial-structure authority', () => {
  it('carries exactly the authority names, neither more nor fewer', () => {
    const authority = SPATIAL_STRUCTURE_TYPE_ENUMS.map((t) => IfcTypeEnumToString(t));
    // Anti-vacuity: a truncated authority would make the set comparison below
    // pass against an equally truncated SPATIAL_TYPES.
    assert.ok(
      authority.length >= 17,
      `expected the full spatial vocabulary from @ifc-lite/data, got ${authority.length}`,
    );
    assert.ok(
      authority.every((name) => name !== 'Unknown'),
      `authority must not contain the enum miss sentinel: ${authority.join(', ')}`,
    );

    const missing = authority.filter((name) => !SPATIAL_TYPES.has(name));
    const extra = [...SPATIAL_TYPES].filter((name) => !authority.includes(name));
    assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] });
  });

  it('carries the IFC4.3 facilities and their parts by name', () => {
    // Named, not counted: a size floor of 5 was met by the old list while
    // every one of these was absent.
    for (const name of [
      'IfcProject',
      'IfcSite',
      'IfcBuilding',
      'IfcBuildingStorey',
      'IfcSpace',
      'IfcSpatialZone',
      'IfcFacility',
      'IfcFacilityPart',
      'IfcFacilityPartCommon',
      'IfcBridge',
      'IfcBridgePart',
      'IfcRoad',
      'IfcRoadPart',
      'IfcRailway',
      'IfcRailwayPart',
      'IfcMarineFacility',
      'IfcMarinePart',
    ]) {
      assert.ok(SPATIAL_TYPES.has(name), `${name} missing from SPATIAL_TYPES`);
      assert.ok(isSpatialStructureTypeName(name), `${name} missing from the authority`);
    }
  });

  it('does not swallow a physical element', () => {
    // Negative control: the set is a gate, so a class wrongly inside it stops
    // being collected as an element at all.
    for (const name of ['IfcWall', 'IfcSlab', 'IfcRoof', 'IfcZone', 'IfcGroup']) {
      assert.ok(!SPATIAL_TYPES.has(name), `${name} must not be treated as spatial structure`);
    }
  });
});

describe('buildHierarchy nests an IFC4.3 facility', () => {
  it('recurses through IfcRoad / IfcRoadPart instead of flattening them into the site', () => {
    const project = node('project', 'IfcProject');
    const site = node('site', 'IfcSite');
    const road = node('road', 'IfcRoad');
    const roadPart = node('roadpart', 'IfcRoadPart');
    const wall = node('wall', 'IfcWall');
    link(project, site);
    link(site, road);
    link(road, roadPart);
    link(roadPart, wall);

    const composed = new Map<string, ComposedNode>();
    for (const n of [project, site, road, roadPart, wall]) composed.set(n.path, n);
    const pathToId = new Map<string, number>([
      ['project', 1],
      ['site', 2],
      ['road', 3],
      ['roadpart', 4],
      ['wall', 10],
    ]);

    const hierarchy = buildHierarchy(composed, pathToId);
    const siteNode = hierarchy.project.children[0] as SpatialNode | undefined;
    assert.ok(siteNode, 'expected the site under the project');

    // The road and its part are LEVELS, not contents: before the fix the site
    // reported elements [3, 4, 10] and had no spatial children at all.
    assert.deepStrictEqual(siteNode.elements, []);
    const roadNode = siteNode.children[0] as SpatialNode | undefined;
    assert.ok(roadNode, 'expected IfcRoad as a spatial child of the site');
    assert.strictEqual(roadNode.expressId, 3);
    const roadPartNode = roadNode.children[0] as SpatialNode | undefined;
    assert.ok(roadPartNode, 'expected IfcRoadPart as a spatial child of the road');
    assert.strictEqual(roadPartNode.expressId, 4);

    // The wall is the only element, and it hangs off the road part.
    assert.deepStrictEqual(roadPartNode.elements, [10]);
    // It stays reachable from the site it sits under.
    assert.deepStrictEqual(hierarchy.bySite.get(2), [10]);
  });
});

describe('parseIfcx classifies a facility edge as decomposition', () => {
  /**
   * `determineRelationshipType` asks the same "is this spatial" question as
   * the tree builder and used to answer it from its own copy of the list.
   * A spatial-to-spatial edge is an AGGREGATION (IfcRelAggregates); only a
   * spatial-to-element edge is containment. With the facilities missing, an
   * `IfcSite -> IfcRoad` edge came back ContainsElements — the road filed as
   * a piece of equipment standing in the site.
   */
  it('reports IfcSite -> IfcRoad as Aggregates, not ContainsElements', async () => {
    const ifcClass = (code: string) => ({
      code,
      uri: `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${code}`,
    });
    const doc = {
      header: { id: 'test/facility-edges.ifcx', ifcxVersion: 'ifcx_alpha', dataVersion: '1.0.0' },
      imports: [],
      schemas: {},
      data: [
        {
          path: 'project-1',
          attributes: { [ATTR.CLASS]: ifcClass('IfcProject') },
          children: { site: 'site-1' },
        },
        {
          path: 'site-1',
          attributes: { [ATTR.CLASS]: ifcClass('IfcSite') },
          children: { road: 'road-1' },
        },
        {
          path: 'road-1',
          attributes: { [ATTR.CLASS]: ifcClass('IfcRoad') },
          children: { pavement: 'pavement-1' },
        },
        { path: 'pavement-1', attributes: { [ATTR.CLASS]: ifcClass('IfcPavement') } },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;

    const result = await parseIfcx(buffer);
    const siteId = result.pathToId.get('site-1');
    const roadId = result.pathToId.get('road-1');
    const pavementId = result.pathToId.get('pavement-1');
    // Anti-vacuity: an empty getRelated() would satisfy nothing below if the
    // nodes never became entities in the first place.
    assert.ok(siteId !== undefined && roadId !== undefined && pavementId !== undefined);

    assert.deepStrictEqual(
      result.relationships.getRelated(siteId, RelationshipType.Aggregates, 'forward'),
      [roadId],
    );
    assert.deepStrictEqual(
      result.relationships.getRelated(siteId, RelationshipType.ContainsElements, 'forward'),
      [],
    );
    // Negative control, the other direction of the same rule: a spatial ->
    // physical-element edge must STAY containment.
    assert.deepStrictEqual(
      result.relationships.getRelated(roadId, RelationshipType.ContainsElements, 'forward'),
      [pavementId],
    );
    assert.deepStrictEqual(
      result.relationships.getRelated(roadId, RelationshipType.Aggregates, 'forward'),
      [],
    );
  });
});
