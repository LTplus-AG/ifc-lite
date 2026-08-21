/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Synthetic (non-fixture) coverage for hierarchy-builder.ts.
 *
 * hierarchy-builder.test.ts only runs against
 * tests/models/ifc5/Hello_Wall_hello-wall.ifcx, which is fetched by
 * `pnpm fixtures` and is absent from a fresh checkout. When absent, that
 * suite reports 0 tests run wrapped in a `SKIP`-annotated `ok` — a green
 * result that is not evidence anything executed. These tests build
 * ComposedNode trees directly so they run everywhere, always, with no
 * fixture dependency.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildHierarchy } from './hierarchy-builder.js';
import { ATTR } from './types.js';
import type { ComposedNode } from './types.js';

function node(path: string, classCode?: string, attrs?: Record<string, unknown>): ComposedNode {
  const attributes = new Map<string, unknown>();
  if (classCode) {
    attributes.set(ATTR.CLASS, { code: classCode, uri: `urn:${classCode}` });
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    attributes.set(k, v);
  }
  return { path, attributes, children: new Map() };
}

function link(parent: ComposedNode, ...children: ComposedNode[]): void {
  for (const child of children) {
    parent.children.set(child.path, child);
  }
}

/**
 * Build a small building: Project -> Site -> Building -> Storey -> Space,
 * with:
 *  - wall1: a plain element directly inside the space (normal collectElementIds path)
 *  - wall2: a plain element directly inside the storey, outside the space
 *  - rel1: an IfcRelSpaceBoundary2ndLevel child of the space, carrying the
 *    space-boundary attribute pointing at door1 (the PRIMARY boundary path)
 *  - fallback1: a child of the space with NO bsi::ifc::class attribute at
 *    all, but carrying the space-boundary attribute pointing at window1
 *    (the candidate FALLBACK path under scrutiny)
 *
 * door1/window1 are never composed-tree children of anything reachable by
 * normal traversal — they only exist as pathToId entries, so the only way
 * either can appear in the output is via collectSpaceBoundaryElementIds.
 */
function buildFixture() {
  const project = node('project', 'IfcProject');
  const site = node('site', 'IfcSite');
  const building = node('building', 'IfcBuilding');
  const storey = node('storey', 'IfcBuildingStorey', { 'bsi::ifc::prop::Elevation': 3 });
  const space = node('space', 'IfcSpace');

  const wall1 = node('wall1', 'IfcWall');
  const wall2 = node('wall2', 'IfcWall');
  const rel1 = node('rel1', 'IfcRelSpaceBoundary2ndLevel', {
    [ATTR.SPACE_BOUNDARY]: { relatedelement: { ref: 'door1' } },
  });
  const fallback1 = node('fallback1', undefined, {
    [ATTR.SPACE_BOUNDARY]: { relatedelement: { ref: 'window1' } },
  });

  link(project, site);
  link(site, building);
  link(building, storey);
  link(storey, space, wall2);
  link(space, wall1, rel1, fallback1);

  const composed = new Map<string, ComposedNode>();
  for (const n of [project, site, building, storey, space, wall1, wall2, rel1, fallback1]) {
    composed.set(n.path, n);
  }

  const pathToId = new Map<string, number>([
    ['project', 1],
    ['site', 2],
    ['building', 3],
    ['storey', 4],
    ['space', 5],
    ['wall1', 10],
    ['wall2', 11],
    ['door1', 12],
    ['window1', 13],
  ]);

  return { composed, pathToId };
}

describe('buildHierarchy — synthetic (no fixture required)', () => {
  it('returns an empty hierarchy when no IfcProject node exists', () => {
    const composed = new Map<string, ComposedNode>();
    const pathToId = new Map<string, number>();
    const hierarchy = buildHierarchy(composed, pathToId);

    assert.strictEqual(hierarchy.project.name, 'Unknown Project');
    assert.strictEqual(hierarchy.byStorey.size, 0);
    assert.deepStrictEqual(hierarchy.getPath(1), []);
    assert.strictEqual(hierarchy.getStoreyByElevation(0), null);
  });

  it('collects the direct element, the primary space-boundary element, and the fallback space-boundary element into the space', () => {
    const { composed, pathToId } = buildFixture();
    const hierarchy = buildHierarchy(composed, pathToId);

    const spaceElements = hierarchy.bySpace.get(5) ?? [];
    assert.deepStrictEqual(
      [...spaceElements].sort((a, b) => a - b),
      [10, 12, 13],
      'wall1 (direct), door1 (primary boundary rel), window1 (fallback) all present'
    );
    assert.strictEqual(hierarchy.getContainingSpace(10), 5);
    assert.strictEqual(hierarchy.getContainingSpace(12), 5);
    assert.strictEqual(hierarchy.getContainingSpace(13), 5);
  });

  it('propagates space elements up through storey/building/site containment', () => {
    const { composed, pathToId } = buildFixture();
    const hierarchy = buildHierarchy(composed, pathToId);

    const storeyElements = hierarchy.byStorey.get(4) ?? [];
    assert.deepStrictEqual(
      [...storeyElements].sort((a, b) => a - b),
      [10, 11, 12, 13],
      'wall2 (direct storey element) plus everything the space contains'
    );
    assert.strictEqual(hierarchy.elementToStorey.get(10), 4);
    assert.strictEqual(hierarchy.elementToStorey.get(13), 4);

    const buildingElements = hierarchy.byBuilding.get(3) ?? [];
    assert.deepStrictEqual([...buildingElements].sort((a, b) => a - b), [10, 11, 12, 13]);

    const siteElements = hierarchy.bySite.get(2) ?? [];
    assert.deepStrictEqual([...siteElements].sort((a, b) => a - b), [10, 11, 12, 13]);
  });

  it('records storey elevation and resolves it by z-coordinate', () => {
    const { composed, pathToId } = buildFixture();
    const hierarchy = buildHierarchy(composed, pathToId);

    assert.strictEqual(hierarchy.storeyElevations.get(4), 3);
    assert.strictEqual(hierarchy.getStoreyByElevation(3), 4);
  });

  it('getPath returns the root-to-node chain in root-first order for a nested element', () => {
    const { composed, pathToId } = buildFixture();
    const hierarchy = buildHierarchy(composed, pathToId);

    const path = hierarchy.getPath(10); // wall1, inside space
    assert.deepStrictEqual(
      path.map((n) => n.expressId),
      [1, 2, 3, 4, 5],
      'project -> site -> building -> storey -> space, root first'
    );
  });

  it('getPath returns the chain up to (and including) the storey for an element that only reaches the storey directly', () => {
    const { composed, pathToId } = buildFixture();
    const hierarchy = buildHierarchy(composed, pathToId);

    const path = hierarchy.getPath(11); // wall2, direct storey child
    assert.deepStrictEqual(path.map((n) => n.expressId), [1, 2, 3, 4]);
  });

  it('getPath returns an empty array for an element id that is not in the hierarchy', () => {
    const { composed, pathToId } = buildFixture();
    const hierarchy = buildHierarchy(composed, pathToId);

    assert.deepStrictEqual(hierarchy.getPath(999), []);
  });

  it('pushUnique de-duplicates an element two sibling spaces both contribute to the shared storey', () => {
    // A door shared between two adjoining rooms shows up as a space-boundary
    // element of BOTH spaces. Each space's own `elements` Set only dedupes
    // within that one space, so the door legitimately appears once in each
    // of bySpace(space1) and bySpace(space2). The interesting map is
    // byStorey: populateMaps folds elements from both spaces into the SAME
    // storey key, and pushUnique is what stops the door being counted twice
    // there.
    const project = node('project', 'IfcProject');
    const storey = node('storey', 'IfcBuildingStorey');
    const space1 = node('space1', 'IfcSpace');
    const space2 = node('space2', 'IfcSpace');
    const rel1 = node('rel1', 'IfcRelSpaceBoundary', {
      [ATTR.SPACE_BOUNDARY]: { relatedelement: { ref: 'door' } },
    });
    const rel2 = node('rel2', 'IfcRelSpaceBoundary', {
      [ATTR.SPACE_BOUNDARY]: { relatedelement: { ref: 'door' } },
    });

    link(project, storey);
    link(storey, space1, space2);
    link(space1, rel1);
    link(space2, rel2);

    const composed = new Map<string, ComposedNode>([
      ['project', project],
      ['storey', storey],
      ['space1', space1],
      ['space2', space2],
      ['rel1', rel1],
      ['rel2', rel2],
    ]);
    const pathToId = new Map<string, number>([
      ['project', 1],
      ['storey', 2],
      ['space1', 3],
      ['space2', 4],
      ['door', 5],
    ]);

    const hierarchy = buildHierarchy(composed, pathToId);
    assert.deepStrictEqual(hierarchy.bySpace.get(3), [5], 'door counted for space1');
    assert.deepStrictEqual(hierarchy.bySpace.get(4), [5], 'door counted for space2');
    assert.deepStrictEqual(
      hierarchy.byStorey.get(2),
      [5],
      'door counted exactly once at the storey level despite being contributed by two spaces'
    );
  });

  describe('spatial-node construction (name/longName extraction)', () => {
    it('prefers bsi::ifc::name over Name/TypeName/LongName', () => {
      const project = node('project', 'IfcProject', {
        'bsi::ifc::name': 'Direct Name',
        'bsi::ifc::prop::Name': 'Prop Name',
        'bsi::ifc::prop::TypeName': 'Type Name',
        'bsi::ifc::prop::LongName': 'Long Name',
      });
      const composed = new Map([['project', project]]);
      const pathToId = new Map([['project', 1]]);
      const hierarchy = buildHierarchy(composed, pathToId);
      assert.strictEqual(hierarchy.project.name, 'Direct Name');
    });

    it('falls back to prop::Name, then TypeName, then LongName in priority order', () => {
      const withoutDirect = node('p2', 'IfcProject', {
        'bsi::ifc::prop::Name': 'Prop Name',
        'bsi::ifc::prop::TypeName': 'Type Name',
      });
      let hierarchy = buildHierarchy(new Map([['p2', withoutDirect]]), new Map([['p2', 1]]));
      assert.strictEqual(hierarchy.project.name, 'Prop Name');

      const typeOnly = node('p3', 'IfcProject', {
        'bsi::ifc::prop::TypeName': 'Type Name',
        'bsi::ifc::prop::LongName': 'Long Name',
      });
      hierarchy = buildHierarchy(new Map([['p3', typeOnly]]), new Map([['p3', 1]]));
      assert.strictEqual(hierarchy.project.name, 'Type Name');
    });

    it('keeps LongName as a distinct descriptor when it differs from the resolved name', () => {
      const project = node('project', 'IfcProject', {
        'bsi::ifc::prop::Name': '01',
        'bsi::ifc::prop::LongName': 'Main Residence',
      });
      const hierarchy = buildHierarchy(new Map([['project', project]]), new Map([['project', 1]]));
      assert.strictEqual(hierarchy.project.name, '01');
      assert.strictEqual(hierarchy.project.longName, 'Main Residence');
    });

    it('drops LongName when it duplicates the resolved name', () => {
      const project = node('project', 'IfcProject', {
        'bsi::ifc::prop::Name': 'Main Residence',
        'bsi::ifc::prop::LongName': 'Main Residence',
      });
      const hierarchy = buildHierarchy(new Map([['project', project]]), new Map([['project', 1]]));
      assert.strictEqual(hierarchy.project.longName, undefined);
    });
  });
});
