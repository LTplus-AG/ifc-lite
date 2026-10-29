/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `hello-wall.ifcx` (the committed sample the viewer opens) read the way hello-wall.ifc is: its window
 * type is a type, its materials are materials related to what is made of them, its space is named alike in the
 * entity table and in the spatial tree, and its storey holds its space. Each assertion has the IFC counterpart in
 * hello-wall.ifc beside it in the sample folder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IfcTypeEnum, RelationshipType } from '@ifc-lite/data';
import { IFCX_LENGTH_UNIT_SCALE, parseFederatedIfcx, parseIfcx } from './index.js';
import { typeDefinitions } from './definitions.js';
import { exportToIfcx } from './writer.js';
import type { ComposedNode } from './types.js';

const SAMPLE = fileURLToPath(new URL('../../../apps/viewer/public/samples/hello-wall.ifcx', import.meta.url));
const TYPE = '25503984-6605-43a1-8597-eae657ff5bea';
const WALL = '93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b';
const WINDOWS = ['2c2d549f-f9fe-4e22-8590-562fda81a690', '592504dc-469a-44d6-9ae8-c801b591679b'];
const SPACE = 'e3035b71-bd9f-4cdc-86fd-b56e2f4605b6';
const STOREY = '44af358b-3160-4063-8a89-a868335ff3b5';
const CONCRETE = '7a187a90-3dcf-58cc-b3a6-51a9a407c55a';
const WOOD = '4549bada-a37e-5044-bb70-456516cca5a8';
const GLASS = 'd10e4eb4-6a35-5fbe-9491-7a6fb93f1691';

async function parseSample() {
  const bytes = readFileSync(SAMPLE);
  return parseIfcx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

describe('hello-wall.ifcx is read as hello-wall.ifc is', () => {
  it('states its length unit: metres, the unit the format defines', async () => {
    assert.equal((await parseSample()).lengthUnitScale, IFCX_LENGTH_UNIT_SCALE);
    assert.equal(IFCX_LENGTH_UNIT_SCALE, 1);
  });

  it('reads the window type as an IfcWindowType, not a fourth IfcWindow with no storey', async () => {
    const r = await parseSample();
    const type = r.pathToId.get(TYPE)!;
    assert.equal(r.entities.getTypeName(type), 'IfcWindowType');
    assert.equal(r.entities.getName(type), 'WT01');
    for (const path of WINDOWS) assert.equal(r.entities.getTypeName(r.pathToId.get(path)!), 'IfcWindow');
    assert.deepEqual(r.relationships.getRelated(type, RelationshipType.DefinesByType, 'forward').sort(), WINDOWS.map((p) => r.pathToId.get(p)!).sort());
  });

  it('reads the three materials as IfcMaterial named by their class code, and relates them to what is made of them', async () => {
    const r = await parseSample();
    const named = (path: string) => [r.entities.getTypeName(r.pathToId.get(path)!), r.entities.getName(r.pathToId.get(path)!)];
    assert.deepEqual(named(CONCRETE), ['IfcMaterial', 'CONCRETE']);
    assert.deepEqual(named(WOOD), ['IfcMaterial', 'WOOD']);
    assert.deepEqual(named(GLASS), ['IfcMaterial', 'GLASS']);
    const of = (material: string) => r.relationships.getRelated(r.pathToId.get(material)!, RelationshipType.AssociatesMaterial, 'forward');
    // The wall is made of concrete; WOOD and GLASS are the window TYPE's (as in the IFC), not repeated on each window.
    assert.deepEqual(of(CONCRETE), [r.pathToId.get(WALL)]);
    assert.deepEqual(of(WOOD), [r.pathToId.get(TYPE)]);
    assert.deepEqual(of(GLASS), [r.pathToId.get(TYPE)]);
  });

  it('names the space alike in the entity table and in the spatial tree', async () => {
    const r = await parseSample();
    const id = r.pathToId.get(SPACE)!;
    const node = r.spatialHierarchy.project.children[0].children[0].children[0].children.find((c) => c.expressId === id);
    assert.equal(r.entities.getName(id), 'My_Space');
    assert.equal(node?.name, 'My_Space');
  });

  it('puts every element, and the space, on the storey', async () => {
    const r = await parseSample();
    const storey = r.pathToId.get(STOREY)!;
    for (const path of [WALL, SPACE, ...WINDOWS]) assert.equal(r.spatialHierarchy.elementToStorey.get(r.pathToId.get(path)!), storey, path);
    assert.equal(r.spatialHierarchy.elementToStorey.has(r.pathToId.get(TYPE)!), false, 'the type is no element');
    assert.equal(r.entities.getTypeEnum(r.pathToId.get(TYPE)!), IfcTypeEnum.IfcWindowType);
  });
});

describe('which edge makes a node a type', () => {
  const node = (path: string, code: string, inherits?: Record<string, string>): ComposedNode =>
    ({ path, attributes: new Map([['bsi::ifc::class', { code }]]), children: new Map(), ...(inherits ? { inherits } : {}) });

  it('takes the class\'s own `<class>Type` edge, as the sample writes it', () => {
    const composed = new Map([['t', node('t', 'IfcWindow')], ['w', node('w', 'IfcWindow', { windowType: 't' })]]);
    assert.deepEqual([...typeDefinitions(composed)], [['t', 'IfcWindowType']]);
  });

  it('does not retype the target of an edge that merely ends in "type"', () => {
    const composed = new Map([['t', node('t', 'IfcWindow')], ['w', node('w', 'IfcWindow', { prototype: 't' })], ['x', node('x', 'IfcWall', { windowType: 't' })]]);
    assert.deepEqual([...typeDefinitions(composed)], []);
  });
});

describe('the IFCX writer writes the classes the file states, not the ones the reader derived', () => {
  it('writes the window type as the IfcWindow the file calls it, and no material rows', async () => {
    const r = await parseSample();
    const out = JSON.parse(exportToIfcx({
      entities: r.entities,
      derivedEntities: r.derivedEntities,
      properties: r.properties,
      spatialHierarchy: r.spatialHierarchy,
      strings: r.strings,
      idToPath: r.idToPath,
    })) as { data: { path: string; attributes?: Record<string, { code?: string }> }[] };
    const classes = new Map(out.data.map((n) => [n.path, n.attributes?.['bsi::ifc::class']?.code]));
    assert.equal(classes.get(TYPE), 'IfcWindow');
    for (const material of [CONCRETE, WOOD, GLASS]) assert.equal(classes.get(material), undefined, material);
  });
});

describe('the sample\'s storey sits where the IFC puts it', () => {
  it('has an elevation (0: no Elevation, no placement offset), not none', async () => {
    const r = await parseSample();
    assert.equal(r.spatialHierarchy.storeyElevations.get(r.pathToId.get(STOREY)!), 0);
  });
});

describe('the federated reader derives the same as the single-file one', () => {
  it('reads hello-wall.ifcx as one federated layer: type, materials, names, unit', async () => {
    const bytes = readFileSync(SAMPLE);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const r = await parseFederatedIfcx([{ buffer, name: 'hello-wall.ifcx' }]);
    assert.equal(r.lengthUnitScale, IFCX_LENGTH_UNIT_SCALE);
    assert.equal(r.entities.getTypeName(r.pathToId.get(TYPE)!), 'IfcWindowType');
    assert.equal(r.entities.getName(r.pathToId.get(CONCRETE)!), 'CONCRETE');
    assert.equal(r.entities.getName(r.pathToId.get(WINDOWS[0])!), 'Window');
    assert.deepEqual(r.relationships.getRelated(r.pathToId.get(CONCRETE)!, RelationshipType.AssociatesMaterial, 'forward'), [r.pathToId.get(WALL)]);
  });
});
