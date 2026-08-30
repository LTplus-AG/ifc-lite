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

  it('reads back bsi::ifc::prop::Description written by the writer, mirroring Name', () => {
    // writer.ts's writeEntities emits `bsi::ifc::prop::Description` (and
    // `bsi::ifc::prop::Name`) from `EntityTable.description`/`.name` — see
    // its comment "IFC5 uses bsi::ifc::prop:: namespace for name/description".
    // `extractName` above already reads `bsi::ifc::prop::Name` back; this
    // pins that `Description` gets the same treatment rather than being
    // hardcoded to `''` on every read.
    const wall = createNode('wall');
    wall.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));
    wall.attributes.set('bsi::ifc::prop::Name', 'Wall-A');
    wall.attributes.set('bsi::ifc::prop::Description', 'Exterior load-bearing wall');

    const strings = new StringTable();
    const { entities, pathToId } = extractEntities(new Map([[wall.path, wall]]), strings);

    const wallId = pathToId.get(wall.path);
    assert.ok(wallId !== undefined);
    // Control: the sibling field (Name) already reaches the output via the
    // same attribute-map channel — proves the extractor and this test setup
    // both work, isolating the failure to Description specifically.
    assert.strictEqual(entities.getName(wallId), 'Wall-A');
    assert.strictEqual(entities.getDescription(wallId), 'Exterior load-bearing wall');
  });
});
