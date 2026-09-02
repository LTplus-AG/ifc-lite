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

  it('does not fabricate ObjectType from the IFC class code', () => {
    // objectType used to be filled with the entity's own class code, so
    // every IFCX-sourced wall reported ObjectType 'IfcWall' — a
    // plausible-looking value no source attribute backs, indistinguishable
    // from an authored one to every consumer that reads it (CSV/Parquet
    // export, the query engine's ObjectType column, IDS's `getObjectType`,
    // the lens summary line). With no ObjectType on the node the field must
    // stay '', the STEP parser's own default (`addEntityBatch` in
    // packages/parser/src/columnar-parser.ts).
    const wall = createNode('wall');
    wall.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));
    wall.attributes.set('bsi::ifc::prop::Name', 'Wall-01');

    const strings = new StringTable();
    const { entities, pathToId } = extractEntities(new Map([[wall.path, wall]]), strings);

    const wallId = pathToId.get(wall.path);
    assert.ok(wallId !== undefined);
    // Control: Name is a real attribute on this node and DOES round-trip,
    // isolating the failure to objectType.
    assert.strictEqual(entities.getName(wallId), 'Wall-01');
    assert.strictEqual(entities.getObjectType(wallId), '');
  });

  it('reads back bsi::ifc::prop::ObjectType when the source carries it', () => {
    // buildingSMART's v5a `prop` schema defines no ObjectType, but ifc-lite's
    // own collab seed writes the key: apps/viewer/src/lib/collab/step-seed.ts
    // emits `bsi::ifc::prop::ObjectType` for every STEP entity that has one,
    // and that snapshot comes back through `extractEntities`
    // (`snapshotToIfcx` → `parseIfcxViewerModel`). This node is the shape
    // step-seed.ts produces for a typed wall. The expected value matches
    // neither the class code nor '', so it separates reading the attribute
    // from both the old fabrication and a blanket ''.
    const wall = createNode('wall');
    wall.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));
    wall.attributes.set('bsi::ifc::prop::Name', 'Wall-01');
    wall.attributes.set('bsi::ifc::prop::ObjectType', 'Basic Wall:Generic 200mm');

    const strings = new StringTable();
    const { entities, pathToId } = extractEntities(new Map([[wall.path, wall]]), strings);

    const wallId = pathToId.get(wall.path);
    assert.ok(wallId !== undefined);
    assert.strictEqual(entities.getName(wallId), 'Wall-01');
    assert.strictEqual(entities.getObjectType(wallId), 'Basic Wall:Generic 200mm');
  });

  it('does not fabricate Name from the node path when the source has none', () => {
    // `extractName` returning null (no bsi::ifc::name / prop::Name /
    // prop::TypeName / prop::ObjectName, and no usable incoming edge name)
    // used to fall back to `node.path.slice(0, 8)` — an 8-char slice of the
    // IFCX path that reads as a plausible short name/code no source
    // attribute backs, indistinguishable from an authored one. Worse: it
    // pre-empts the viewer's own "Name absent" convention
    // (`getName(id) || '${typeName} #${expressId}'` in treeDataBuilder.ts),
    // which never fires because getName() no longer returns '' here. Name
    // must stay '' — the STEP parser's own convention for a missing Name
    // (`columnar-parser.ts`) — like ObjectType/Description above.
    const wall = createNode('4f9c1a3e-unnamed-wall-node-path');
    wall.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));

    const strings = new StringTable();
    const { entities, pathToId } = extractEntities(new Map([[wall.path, wall]]), strings);

    const wallId = pathToId.get(wall.path);
    assert.ok(wallId !== undefined);
    assert.strictEqual(entities.getName(wallId), '');
  });
});
