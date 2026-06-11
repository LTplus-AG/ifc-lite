/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractGeometry } from './geometry-extractor.js';
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

describe('extractGeometry', () => {
  it('traverses disconnected cycle components even when other roots exist', () => {
    const root = createNode('root');
    root.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));
    root.attributes.set(ATTR.MESH, createMesh());

    const cycleA = createNode('cycle-a');
    cycleA.attributes.set(ATTR.CLASS, ifcClass('IfcWindow'));

    const cycleB = createNode('cycle-b');
    cycleB.attributes.set(ATTR.CLASS, ifcClass('IfcWindow'));
    cycleB.attributes.set(ATTR.MESH, createMesh());

    attachChild(cycleA, cycleB, 'b');
    attachChild(cycleB, cycleA, 'a');

    const composed = new Map<string, ComposedNode>([
      [root.path, root],
      [cycleA.path, cycleA],
      [cycleB.path, cycleB],
    ]);
    const pathToId = new Map([
      [root.path, 1],
      [cycleA.path, 2],
      [cycleB.path, 3],
    ]);

    const meshes = extractGeometry(composed, pathToId);

    assert.strictEqual(meshes.length, 2);
    assert.deepStrictEqual(meshes.map((mesh) => mesh.expressId).sort((a, b) => a - b), [1, 3]);
  });

  it('keeps geometry for entity ids whose class object has no code', () => {
    const entity = createNode('entity');
    entity.attributes.set(ATTR.CLASS, {});

    const body = createNode('entity/body');
    body.attributes.set(ATTR.MESH, createMesh());
    attachChild(entity, body, 'Body');

    const composed = new Map<string, ComposedNode>([
      [entity.path, entity],
      [body.path, body],
    ]);
    const pathToId = new Map([[entity.path, 7]]);

    const meshes = extractGeometry(composed, pathToId);

    assert.strictEqual(meshes.length, 1);
    assert.strictEqual(meshes[0].expressId, 7);
    assert.strictEqual(meshes[0].ifcType, undefined);
  });

  it('emits shared inherited mesh geometry for each non-type instance context', () => {
    const root = createNode('root');
    root.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));

    const typeDefinition = createNode('window-type');
    typeDefinition.attributes.set(ATTR.CLASS, ifcClass('IfcWindowType'));
    typeDefinition.attributes.set('customdata', {
      originalStepInstance: '#10=IFCWINDOWTYPE()',
    });

    const windowA = createNode('window-a');
    windowA.attributes.set(ATTR.CLASS, ifcClass('IfcWindow'));

    const windowB = createNode('window-b');
    windowB.attributes.set(ATTR.CLASS, ifcClass('IfcWindow'));

    const sharedBody = createNode('window-body');
    sharedBody.attributes.set(ATTR.MESH, createMesh());

    attachChild(root, typeDefinition, 'Type');
    attachChild(typeDefinition, sharedBody, 'Body');
    attachChild(root, windowA, 'WindowA');
    attachChild(root, windowB, 'WindowB');
    windowA.children.set('Body', sharedBody);
    windowB.children.set('Body', sharedBody);

    const composed = new Map<string, ComposedNode>([
      [root.path, root],
      [typeDefinition.path, typeDefinition],
      [windowA.path, windowA],
      [windowB.path, windowB],
      [sharedBody.path, sharedBody],
    ]);
    const pathToId = new Map([
      [root.path, 1],
      [typeDefinition.path, 10],
      [windowA.path, 11],
      [windowB.path, 12],
    ]);

    const meshes = extractGeometry(composed, pathToId);

    assert.strictEqual(meshes.length, 2);
    assert.deepStrictEqual(meshes.map((mesh) => mesh.expressId).sort((a, b) => a - b), [11, 12]);
    assert.deepStrictEqual(meshes.map((mesh) => mesh.ifcType).sort(), ['IfcWindow', 'IfcWindow']);
  });

  it('emits a multi-parent entity mesh once (aliased containment edges, PR #1041 round-trip ×4)', () => {
    // Hello Wall shape: the wall hangs under BOTH the storey (containment)
    // and the space (boundary) — same entity, same placement. The exporter
    // legitimately materialises both edges; extraction must not duplicate
    // the wall's triangles per incoming edge.
    const storey = createNode('storey');
    storey.attributes.set(ATTR.CLASS, ifcClass('IfcBuildingStorey'));

    const space = createNode('space');
    space.attributes.set(ATTR.CLASS, ifcClass('IfcSpace'));

    const wall = createNode('wall');
    wall.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));
    wall.attributes.set(ATTR.MESH, createMesh());

    attachChild(storey, space, 'Space');
    attachChild(storey, wall, 'Wall');
    attachChild(space, wall, 'Wall');

    const composed = new Map<string, ComposedNode>([
      [storey.path, storey],
      [space.path, space],
      [wall.path, wall],
    ]);
    const pathToId = new Map([
      [storey.path, 1],
      [space.path, 2],
      [wall.path, 3],
    ]);

    const meshes = extractGeometry(composed, pathToId);

    assert.strictEqual(meshes.length, 1, 'wall mesh must emit once, not once per incoming edge');
    assert.strictEqual(meshes[0].expressId, 3);
  });

  it('dedupes an alias path with an explicit identity xformop against a bare path', () => {
    // "No transform" and an explicit identity usd::xformop produce
    // identical world geometry — the dedupe key must canonicalize them.
    const storey = createNode('storey');
    storey.attributes.set(ATTR.CLASS, ifcClass('IfcBuildingStorey'));

    const space = createNode('space');
    space.attributes.set(ATTR.CLASS, ifcClass('IfcSpace'));
    space.attributes.set(ATTR.TRANSFORM, {
      transform: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    });

    const wall = createNode('wall');
    wall.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));
    wall.attributes.set(ATTR.MESH, createMesh());

    attachChild(storey, space, 'Space');
    attachChild(storey, wall, 'Wall');
    attachChild(space, wall, 'Wall');

    const composed = new Map<string, ComposedNode>([
      [storey.path, storey],
      [space.path, space],
      [wall.path, wall],
    ]);
    const pathToId = new Map([
      [storey.path, 1],
      [space.path, 2],
      [wall.path, 3],
    ]);

    const meshes = extractGeometry(composed, pathToId);
    assert.strictEqual(meshes.length, 1, 'identity xformop alias must still dedupe');
  });

  it('keeps both emissions when alias lineages resolve different presentation', () => {
    // Two parents styling the same shared body differently produce
    // genuinely different MeshData — dedupe must NOT collapse them.
    const root = createNode('root');
    root.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));

    const redGroup = createNode('red-group');
    redGroup.attributes.set(ATTR.DIFFUSE_COLOR, [1, 0, 0]);

    const blueGroup = createNode('blue-group');
    blueGroup.attributes.set(ATTR.DIFFUSE_COLOR, [0, 0, 1]);

    const body = createNode('body');
    body.attributes.set(ATTR.MESH, createMesh());

    attachChild(root, redGroup, 'Red');
    attachChild(root, blueGroup, 'Blue');
    attachChild(redGroup, body, 'Body');
    attachChild(blueGroup, body, 'Body');

    const composed = new Map<string, ComposedNode>([
      [root.path, root],
      [redGroup.path, redGroup],
      [blueGroup.path, blueGroup],
      [body.path, body],
    ]);
    const pathToId = new Map([[root.path, 1]]);

    const meshes = extractGeometry(composed, pathToId);
    assert.strictEqual(meshes.length, 2, 'differently styled lineages must both emit');
    assert.deepStrictEqual(
      meshes.map((m) => m.color.slice(0, 3)).sort((a, b) => a[0] - b[0]),
      [[0, 0, 1], [1, 0, 0]],
    );
  });

  it('preserves inherited type-definition state through classed helper descendants', () => {
    const root = createNode('root');
    root.attributes.set(ATTR.CLASS, ifcClass('IfcWall'));

    const typeDefinition = createNode('window-type');
    typeDefinition.attributes.set(ATTR.CLASS, ifcClass('IfcWindowType'));
    typeDefinition.attributes.set('customdata', {
      originalStepInstance: '#10=IFCWINDOWTYPE()',
    });

    const helper = createNode('representation');
    helper.attributes.set(ATTR.CLASS, ifcClass('IfcRepresentation'));

    const meshNode = createNode('mesh');
    meshNode.attributes.set(ATTR.MESH, createMesh());

    const instance = createNode('window-instance');
    instance.attributes.set(ATTR.CLASS, ifcClass('IfcWindow'));

    attachChild(root, typeDefinition, 'Type');
    attachChild(root, instance, 'Window');
    attachChild(typeDefinition, helper, 'Representation');
    attachChild(helper, meshNode, 'Body');
    instance.children.set('Representation', helper);

    const composed = new Map<string, ComposedNode>([
      [root.path, root],
      [typeDefinition.path, typeDefinition],
      [instance.path, instance],
      [helper.path, helper],
      [meshNode.path, meshNode],
    ]);
    const pathToId = new Map([
      [root.path, 1],
      [typeDefinition.path, 10],
      [helper.path, 20],
      [instance.path, 11],
    ]);

    const meshes = extractGeometry(composed, pathToId);

    assert.strictEqual(meshes.length, 1);
    assert.strictEqual(meshes[0].expressId, 20);
    assert.strictEqual(meshes[0].ifcType, 'IfcRepresentation');
  });
});
