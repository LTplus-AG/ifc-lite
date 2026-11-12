/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ifcGuidToUuid, isValidIfcGuid, uuidToIfcGuid } from '@ifc-lite/encoding';
import { expect, test } from 'vitest';
import { readRhino3dm } from '../index.js';
import { craft, type Craft } from '../../test-support/craft.js';

const WALL = '2O2Fr$t4X7Zf8NOew3FLOH', DOOR = '0YvctVUKr0kugbFTf53O9L', SLAB = '1hqIFTRjfV6AWq_bMtnZwI';
const box = (c: Craft, x = 0) => c.box([x, 0, 0], [x + 1, 1, 1]);
const stamp = (id: string, ...more: [string, string][]): [string, string][] => [['IFC::GlobalId', id], ...more];

test('objects sharing a GlobalId merge only inside the Rhino group named that GlobalId (D8)', async () => {
  const ids: string[] = [];
  const result = await readRhino3dm(await craft(c => {
    const wall = c.group(WALL), other = c.group('some other group');
    ids.push(
      c.addMesh(box(c, 0), { name: 'wall part 1', groups: [wall], userStrings: stamp(WALL) }),
      c.addMesh(box(c, 5), { name: 'door', userStrings: stamp(DOOR) }),
      c.addMesh(box(c, 1), { name: 'wall part 2', groups: [other, wall], userStrings: stamp(WALL) }),
      // A copy-paste keeps user text, but lands in no group or in a different one.
      c.addMesh(box(c, 9), { name: 'pasted wall', userStrings: stamp(WALL) }),
      c.addMesh(box(c, 12), { name: 'pasted wall in another group', groups: [other], userStrings: stamp(WALL) }),
      c.addMesh(box(c, 20), { name: 'pasted door', userStrings: stamp(DOOR) }),
    );
  }));
  expect(result.entities.map(e => e.name)).toEqual(['wall part 1', 'door', 'pasted wall', 'pasted wall in another group', 'pasted door']);
  const [wall, door, ...pasted] = result.entities;
  expect(wall).toMatchObject({ globalId: WALL, objectIds: [ids[0], ids[2]] });
  expect(door).toMatchObject({ globalId: DOOR, objectIds: [ids[1]] });
  // The repeats get the id derived from their own Rhino UUID and keep the stated one as a property.
  expect(pasted.map(e => e.globalId)).toEqual([ids[3], ids[4], ids[5]].map(uuidToIfcGuid));
  expect(pasted.map(e => ifcGuidToUuid(e.globalId))).toEqual([ids[3], ids[4], ids[5]]);
  expect(pasted.map(e => e.propertySets.find(s => s.name === 'IFC')!.properties)).toEqual([[['GlobalId', WALL]], [['GlobalId', WALL]], [['GlobalId', DOOR]]]);
  expect(new Set(result.entities.map(e => e.globalId)).size).toBe(5);
  // Both wall parts are meshes of the one wall entity, and the lists stay in entity order.
  // Each mesh moved with its entity: the box at x is still the one its object drew.
  expect(result.meshes.map(m => [m.entity, m.origin[0]])).toEqual([[0, 0], [0, 1], [1, 5], [2, 9], [3, 12], [4, 20]]);
  expect(result.warnings).toEqual(['3 objects repeat an IFC::GlobalId outside its group and got a new id; the stated id stays in their properties.']);
});

// Review finding on PR #9880.
test('a merged entity holds the user text of every part: new keys are added, a different value is kept under a numbered key', async () => {
  let first = '';
  const result = await readRhino3dm(await craft(c => {
    const wall = c.group(WALL), part = (name: string, x: number, ...more: [string, string][]) => c.addMesh(box(c, x), { name, groups: [wall], userStrings: stamp(WALL, ...more) });
    // The first part stays verbatim, also where two of its keys compare equal.
    first = part('part 1', 0, ['IFC::Material', 'Concrete'], ['Pset_WallCommon::IsExternal', 'true'], ['IFC::Material #3', 'literal'], ['IFC ::Tag', 'a'], ['IFC::Tag', 'b']);
    part('part 2', 1, ['IFC::Material', 'Insulation'], ['Pset_Custom::Rating', 'A'], ['IFC::Description', 'from part 2'], ['ifc::name', 'Second name']);
    // Keys ignore case, and a value the entity already holds is not added again.
    part('part 3', 2, ['ifc::material', 'Insulation'], ['Pset_WallCommon::IsExternal', 'true']);
    part('part 4', 3, ['IFC::Material', 'Plaster']);
    // A spaced `IFC` set is the same key. A stated `#2` is a key of its own, so it stays, and no generated name takes it.
    part('part 5', 4, ['IFC ::Material', 'Wood'], ['IFC::Material #2', 'Concrete']);
  }));
  expect(result.entities).toHaveLength(1);
  const [wall] = result.entities;
  // The first part gives the name, since it states none; the description comes from the part that has one.
  expect(wall).toMatchObject({ globalId: WALL, name: 'Second name', description: 'from part 2', objectIds: { length: 5 } });
  expect(wall.userStrings).toEqual([
    ['IFC::GlobalId', WALL], ['IFC::Material', 'Concrete'], ['Pset_WallCommon::IsExternal', 'true'], ['IFC::Material #3', 'literal'], ['IFC ::Tag', 'a'], ['IFC::Tag', 'b'],
    ['IFC::Material #4', 'Insulation'], ['Pset_Custom::Rating', 'A'], ['IFC::Description', 'from part 2'], ['ifc::name', 'Second name'],
    ['IFC::Material #5', 'Plaster'], ['IFC ::Material #6', 'Wood'], ['IFC::Material #2', 'Concrete'],
  ]);
  expect(wall.propertySets).toEqual([
    { name: 'IFC', properties: [['GlobalId', WALL], ['Material', 'Concrete'], ['Material #3', 'literal'], ['Tag', 'a'], ['Tag', 'b'], ['Material #4', 'Insulation'], ['name', 'Second name'], ['Material #5', 'Plaster'], ['Material #6', 'Wood'], ['Material #2', 'Concrete']] },
    { name: 'Pset_WallCommon', properties: [['IsExternal', 'true']] },
    { name: 'Pset_Custom', properties: [['Rating', 'A']] },
    { name: 'Rhino', properties: [['Layer', 'Default'], ['ObjectType', 'Mesh'], ['ObjectId', first]] },
  ]);
  expect(result.warnings).toEqual([]);
});

/** The user text one wall grouped from `parts` comes back with, without its GlobalId. */
async function mergedText(...parts: [string, string][][]): Promise<[string, string][]> {
  const result = await readRhino3dm(await craft(c => {
    const wall = c.group(WALL);
    parts.forEach((userStrings, x) => c.addMesh(box(c, x), { groups: [wall], userStrings: stamp(WALL, ...userStrings) }));
  }));
  expect(result.entities).toHaveLength(1);
  return result.entities[0].userStrings.slice(1);
}

// Review finding on PR #9880 (discussion_r4552470195).
test('a key a part states as `<key> #2` is a key of its own: an equal value under another key is not a repeat', async () => {
  const result = await readRhino3dm(await craft(c => {
    const wall = c.group(WALL);
    c.addMesh(box(c, 0), { groups: [wall], userStrings: stamp(WALL, ['Pset::Rating', 'A']) });
    c.addMesh(box(c, 1), { groups: [wall], userStrings: stamp(WALL, ['Pset::Rating #2', 'A']) });
  }));
  const [wall] = result.entities;
  expect(wall.userStrings).toEqual([['IFC::GlobalId', WALL], ['Pset::Rating', 'A'], ['Pset::Rating #2', 'A']]);
  expect(wall.propertySets.find(set => set.name === 'Pset')).toEqual({ name: 'Pset', properties: [['Rating', 'A'], ['Rating #2', 'A']] });
});

test('a generated numbered key never takes a name a part states, whichever comes first in the file', async () => {
  // The stated `X #2` comes after the value that needs a number, and before it.
  expect(await mergedText([['X', 'a']], [['X', 'b']], [['X #2', 'c']])).toEqual([['X', 'a'], ['X #3', 'b'], ['X #2', 'c']]);
  expect(await mergedText([['X', 'a']], [['X #2', 'c']], [['X', 'b']])).toEqual([['X', 'a'], ['X #2', 'c'], ['X #3', 'b']]);
  // Keys ignore case, so `x #2` is taken too. A stated numbered key that differs gets a number of its own.
  expect(await mergedText([['X', 'a'], ['x #2', 'c']], [['X', 'b'], ['X #2', 'd']])).toEqual([['X', 'a'], ['x #2', 'c'], ['X #3', 'b'], ['X #2 #2', 'd']]);
});

test('three parts: each new value gets the next number, an equal key and value is added once', async () => {
  expect(await mergedText([['X', 'a'], ['Y', '1']], [['X', 'b'], ['Y', '1']], [['x', 'c'], ['Z', 'a']], [['X', 'b'], ['Y', '1']]))
    .toEqual([['X', 'a'], ['Y', '1'], ['X #2', 'b'], ['x #3', 'c'], ['Z', 'a']]);
});

test('the merge follows file order: the first part keeps the plain key, and no value depends on the order', async () => {
  const a: [string, string][] = [['X', 'a'], ['K', '1']], b: [string, string][] = [['K', '2'], ['X', 'b']], c: [string, string][] = [['X #2', 'c'], ['X', 'a']];
  const abc = await mergedText(a, b, c), cba = await mergedText(c, b, a);
  expect(abc).toEqual([['X', 'a'], ['K', '1'], ['K #2', '2'], ['X #3', 'b'], ['X #2', 'c']]);
  expect(cba).toEqual([['X #2', 'c'], ['X', 'a'], ['K', '2'], ['X #3', 'b'], ['K #2', '1']]);
  // The same file reads the same twice, and both orders hold the same values.
  expect(await mergedText(a, b, c)).toEqual(abc);
  const values = (text: [string, string][]) => text.map(([, value]) => value).sort();
  expect(values(cba)).toEqual(values(abc));
});

// Review finding on PR #9880.
test('an IFC key is read by the rule that sorts it, so a spaced namespace fills the column and no value is lost', async () => {
  const result = await readRhino3dm(await craft(c => {
    c.addMesh(box(c), { userStrings: [['IFC ::Description', 'spaced'], ['ifc::description', 'second spelling'], [' IFC::ObjectType', 'Floor'], ['IFC ::Class', 'IfcSlab'], ['IFC::Description ', 'trailing']] });
  }));
  const [slab] = result.entities;
  expect(slab).toMatchObject({ description: 'spaced', objectType: 'Floor', ifcClass: 'IfcSlab' });
  // The second spelling and the key that names no column stay as properties.
  expect(slab.propertySets[0]).toEqual({ name: 'IFC', properties: [['description', 'second spelling'], ['Class', 'IfcSlab'], ['Description ', 'trailing']] });
});

test('a group owns its GlobalId even when an ungrouped copy comes first in the file', async () => {
  const result = await readRhino3dm(await craft(c => {
    const wall = c.group(WALL);
    c.addMesh(box(c, 9), { name: 'pasted first', userStrings: stamp(WALL) });
    c.addMesh(box(c, 0), { name: 'part 1', groups: [wall], userStrings: stamp(WALL) });
    c.addMesh(box(c, 1), { name: 'part 2', groups: [wall], userStrings: stamp(WALL) });
  }));
  expect(result.entities.map(e => [e.name, e.globalId === WALL, e.objectIds.length])).toEqual([['pasted first', false, 1], ['part 1', true, 2]]);
});

test('an object without a usable GlobalId gets one from its Rhino UUID, never one another object states', async () => {
  let plain = '';
  const result = await readRhino3dm(await craft(c => {
    plain = c.addMesh(box(c), { name: 'plain' });
    c.addMesh(box(c, 2), { name: 'invalid', userStrings: stamp('not a guid') });
    // States exactly the id the first object would derive.
    c.addMesh(box(c, 4), { name: 'thief', userStrings: stamp(uuidToIfcGuid(plain)) });
  }));
  const ids = result.entities.map(e => e.globalId);
  expect(ids.every(isValidIfcGuid)).toBe(true);
  expect(new Set(ids).size).toBe(3);
  expect(ids[2]).toBe(uuidToIfcGuid(plain));
  expect(ids[0]).not.toBe(uuidToIfcGuid(plain));
  expect(result.warnings).toEqual([]);
});

test('IFC::Class sets the class when it names an IFC product class, else the proxy with one warning (D2)', async () => {
  const result = await readRhino3dm(await craft(c => {
    const add = (name: string, ifcClass?: string) => c.addMesh(box(c), { name, userStrings: ifcClass === undefined ? [] : [['IFC::Class', ifcClass]] });
    add('wall', 'IfcWall'); add('legacy', 'IfcWallStandardCase'); add('case', 'ifcdoor'); add('space', 'IfcSpace');
    add('none'); add('blank', '  ');
    add('typo', 'IfcWal'); add('abstract', 'IfcBuildingElement'); add('not a product', 'IfcPropertySet'); add('type', 'IfcWallType');
  }));
  expect(Object.fromEntries(result.entities.map(e => [e.name, e.ifcClass]))).toEqual({
    wall: 'IfcWall', legacy: 'IfcWallStandardCase', case: 'IfcDoor', space: 'IfcSpace',
    none: 'IfcBuildingElementProxy', blank: 'IfcBuildingElementProxy',
    typo: 'IfcBuildingElementProxy', abstract: 'IfcBuildingElementProxy', 'not a product': 'IfcBuildingElementProxy', type: 'IfcBuildingElementProxy',
  });
  expect(result.warnings).toEqual(['4 objects name an IFC::Class that is not an IFC product class and are imported as IfcBuildingElementProxy.']);
  // A rejected value stays visible in the IFC set.
  expect(result.entities.find(e => e.name === 'typo')!.propertySets[0]).toEqual({ name: 'IFC', properties: [['Class', 'IfcWal']] });
});

test('user text sorts into property sets, entity columns and the Rhino set', async () => {
  let id = '';
  const userStrings: [string, string][] = [
    ['IFC::GlobalId', SLAB], ['IFC::Class', 'IfcSlab'], ['IFC::Name', 'Floor slab'], ['IFC::Description', 'Ground floor'],
    ['IFC::ObjectType', 'Floor:200mm'], ['IFC::ExpressId', '4711'], ['IFC::Tag', 'S-1'],
    ['Pset_SlabCommon::IsExternal', 'false'], ['Pset_SlabCommon::LoadBearing', 'true'], ['Custom::Nested::Key', 'kept'],
    ['Pset_SlabCommon::LoadBearing #2', 'collision'], ['plain key', '42'], ['::empty set', 'a'], ['empty property::', 'b'],
  ];
  const result = await readRhino3dm(await craft(c => {
    const glass = c.material('Glass', [1, 2, 3, 255]), parent = c.layer('Building'), layer = c.layer('Slabs', { parent });
    id = c.addMesh(box(c), { name: 'rhino name', layer, material: glass, materialSource: 'MaterialFromObject', userStrings });
    c.addMesh(box(c, 3), { name: 'rhino name only' });
    c.addMesh(box(c, 6));
  }));
  const [slab, named, bare] = result.entities;
  expect(slab).toMatchObject({ globalId: SLAB, ifcClass: 'IfcSlab', name: 'Floor slab', description: 'Ground floor', objectType: 'Floor:200mm' });
  // Verbatim and in file order, for level 2.
  expect(slab.userStrings).toEqual(userStrings);
  expect(slab.propertySets).toEqual([
    { name: 'IFC', properties: [['GlobalId', SLAB], ['Class', 'IfcSlab'], ['Name', 'Floor slab'], ['ExpressId', '4711'], ['Tag', 'S-1']] },
    { name: 'Pset_SlabCommon', properties: [['IsExternal', 'false'], ['LoadBearing', 'true'], ['LoadBearing #2', 'collision']] },
    { name: 'Custom', properties: [['Nested::Key', 'kept']] },
    { name: 'Attribute User Text', properties: [['plain key', '42'], ['::empty set', 'a'], ['empty property::', 'b']] },
    { name: 'Rhino', properties: [['Layer', 'Building::Slabs'], ['ObjectType', 'Mesh'], ['ObjectId', id], ['Material', 'Glass']] },
  ]);
  expect([named.name, bare.name]).toEqual(['rhino name only', 'Mesh']);
  expect(named).toMatchObject({ description: '', objectType: '', ifcClass: 'IfcBuildingElementProxy' });
});

test('user text under Rhino:: stays out of the Rhino set, which holds only what the reader derives', async () => {
  let id = '';
  const result = await readRhino3dm(await craft(c => {
    id = c.addMesh(box(c), { userStrings: [['Rhino::ObjectId', 'spoofed'], ['rhino::Layer', 'elsewhere'], ['Rhino ::Material', 'gold']] });
  }));
  expect(result.entities[0].propertySets).toEqual([
    { name: 'Attribute User Text', properties: [['Rhino::ObjectId', 'spoofed'], ['rhino::Layer', 'elsewhere'], ['Rhino ::Material', 'gold']] },
    { name: 'Rhino', properties: [['Layer', 'Default'], ['ObjectType', 'Mesh'], ['ObjectId', id]] },
  ]);
});
