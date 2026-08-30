/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { StringTable } from '@ifc-lite/data';
import { extractEntities } from './entity-extractor.js';
import { ATTR, type ComposedNode, type UsdMesh } from './types.js';

function createNode(path: string): ComposedNode {
  return {
    path,
    attributes: new Map(),
    children: new Map(),
  };
}

function attachChild(parent: ComposedNode, child: ComposedNode, key: string): void {
  parent.children.set(key, child);
}

function ifcClass(code: string) {
  return {
    code,
    uri: `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${code}`,
  };
}

function createMesh(): UsdMesh {
  return {
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ],
    faceVertexIndices: [0, 1, 2],
  };
}

describe('extractEntities', () => {
  it('uses incoming edge names without relying on a single parent pointer', () => {
    const storey = createNode('storey');
    storey.attributes.set(ATTR.CLASS, ifcClass('IfcBuildingStorey'));

    const wall = createNode('wall');
    wall.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));

    const window = createNode('window');
    window.attributes.set(ATTR.CLASS, ifcClass('IfcWindow'));

    attachChild(storey, wall, 'Wall');
    wall.children.set('Kitchen Window', window);

    const strings = new StringTable();
    const { entities, pathToId } = extractEntities(new Map([
      [storey.path, storey],
      [wall.path, wall],
      [window.path, window],
    ]), strings);

    const windowId = pathToId.get(window.path);
    assert.ok(windowId !== undefined);
    assert.strictEqual(entities.getName(windowId), 'Kitchen Window');
    assert.strictEqual(entities.getTypeName(windowId), 'IfcWindow');
  });

  it('retains entity ids and geometry flags when class objects have no code', () => {
    const entity = createNode('entity');
    entity.attributes.set(ATTR.CLASS, {});

    const body = createNode('body');
    body.attributes.set(ATTR.MESH, createMesh());
    attachChild(entity, body, 'Body');

    const strings = new StringTable();
    const { entities, pathToId } = extractEntities(new Map([
      [entity.path, entity],
      [body.path, body],
    ]), strings);

    const expressId = pathToId.get(entity.path);
    assert.ok(expressId !== undefined);
    assert.strictEqual(entities.hasGeometry(expressId), true);
    assert.strictEqual(entities.getTypeName(expressId), 'Unknown');
  });

  it('does not fabricate ObjectType from the IFC class code', () => {
    // IFCX has no `bsi::ifc::prop::ObjectType` (or equivalent) attribute — the
    // official v5a prop schema (packages/export/src/__fixtures__/schemas/prop@v5a.ifcx)
    // defines Name, Description, UsageType, TypeName, etc. but no ObjectType.
    // The STEP parser's own default for an entity with no real ObjectType
    // attribute is '' (packages/parser/src/columnar-parser.ts's addEntityBatch),
    // never the class name. Filling it with the class code here silently
    // invents plausible-looking but wrong data for every IFCX-sourced entity
    // (e.g. getObjectType() returning 'IfcWall' for every wall), corrupting
    // any consumer that reads ObjectType (CSV/Parquet export, the query
    // engine, the lens summary line, IDS `getObjectType`).
    const wall = createNode('wall');
    wall.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));
    wall.attributes.set('bsi::ifc::prop::Name', 'Wall-01');

    const strings = new StringTable();
    const { entities, pathToId } = extractEntities(new Map([
      [wall.path, wall],
    ]), strings);

    const wallId = pathToId.get(wall.path);
    assert.ok(wallId !== undefined);
    // Control: Name is a real attribute on this node and DOES round-trip.
    assert.strictEqual(entities.getName(wallId), 'Wall-01');
    // ObjectType has no source attribute on this node, so it must stay
    // empty rather than being fabricated from the class code.
    assert.strictEqual(entities.getObjectType(wallId), '');
  });
});
