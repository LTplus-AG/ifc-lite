/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it, vi } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { IfcCreator } from '../ifc-creator.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { addHostedElementInStore } from './hosted-element.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { readRelatedLists } from './resolve-relations.js';
import { duplicateInStore } from './duplicate.js';
import { resolveDuplicateSource } from './resolve-source.js';
import { readStoreyInventory } from './storey/storey-model.js';
import { addStoreyInStore } from './storey/storey-add.js';
import { levelTopFaceAbove } from './storey/storey-attached.js';
import { parse, session } from './__test__/storey-fixtures.oracle.js';

async function setup() {
  const creator = new IfcCreator({ Name: 'Authoring' });
  creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const s = session(await parse(creator.toIfc().content));
  const home = readStoreyInventory(s.store, s.view).storeys[0].expressId;
  const wall = addOrdinaryElementInStore(s.editor, d => resolveSpatialAnchor(s.store, home, d.getMutationView()),
    { kind: 'wall', params: { Start: [0, 0, 0], End: [12, 0, 0], Thickness: .2, Height: 3 } });
  return { s, home, wall };
}

for (const kind of ['door', 'window'] as const) {
  it(`#9352 hosted ${kind} types distinguish an IFC enumeration from matching free text`, async () => {
    let { s, wall } = await setup();
    const field = kind === 'door' ? 'OperationType' : 'PartitioningType';
    const enumeration = kind === 'door' ? 'REVOLVING' : 'DOUBLE_PANEL_VERTICAL';
    const add = (offset: number, value: string) => addHostedElementInStore(s.store, s.editor, wall,
      kind === 'door' ? { kind, params: { Offset: offset, Width: .9, Height: 2.1, OperationType: value } }
        : { kind, params: { Offset: offset, Sill: .5, Width: .9, Height: 2.1, PartitioningType: value } }).expressId;
    const a = add(1, enumeration), b = add(3, enumeration.toLowerCase()), c = add(5, enumeration);
    const typeOf = (id: number) => readRelatedLists(s.store, 'IfcRelDefinesByType', s.view).find(r => r.relatedIds.includes(id))!.relatingId;
    const first = typeOf(a), second = typeOf(b);
    expect(second).not.toBe(first);
    expect(typeOf(c)).toBe(first);
    const check = () => {
      const reader = new AnchorEntityReader(s.store, s.view);
      const value = (id: number, name: string) => { const row = reader.entity(id)!; return row.attributes[row.names.indexOf(name)]; };
      expect(String(value(first, field)).replace(/\./g, '')).toBe(enumeration);
      expect(String(value(second, field)).replace(/\./g, '')).toBe('USERDEFINED');
      expect(value(second, `UserDefined${field}`)).toBe(enumeration.toLowerCase());
    };
    check();
    s = session(await parse(s.text()));
    check();
  });
}

it('#9352 an empty operation text does not reuse the default door type', async () => {
  const { s, wall } = await setup();
  const make = (offset: number, OperationType: string) => addHostedElementInStore(s.store, s.editor, wall,
    { kind: 'door', params: { Offset: offset, Width: .9, Height: 2.1, OperationType } }).expressId;
  const a = make(1, 'SINGLE_SWING_LEFT'), b = make(3, '');
  const types = readRelatedLists(s.store, 'IfcRelDefinesByType', s.view);
  expect(types.find(r => r.relatedIds.includes(a))!.relatingId).not.toBe(types.find(r => r.relatedIds.includes(b))!.relatingId);
});

it('#9352 duplicate refuses an incomplete external association before writing', async () => {
  const { s, wall } = await setup();
  const source = resolveDuplicateSource(s.store, wall, s.editor);
  const type = s.editor.addEntity('IfcWallType', ['0000000000000000000001', null, 'Type', null, null, null, null, null, null, '.STANDARD.']);
  const rel = s.editor.addEntity('IfcRelDefinesByType', ['0000000000000000000002', null, null, null, [`#${wall}`], `#${type.expressId}`]);
  source.associations = [{ relType: 'IfcRelDefinesByType', relId: rel.expressId, relatingExpressId: type.expressId,
    ownerHistoryId: null, name: null, description: null }];
  const before = s.snapshot();
  expect(() => duplicateInStore(s.editor, source)).toThrow(/relatedIds/);
  expect(s.snapshot()).toEqual(before);
});

it('#9352 a source nested part follows its host through a new containment', async () => {
  let { s, home, wall } = await setup();
  const placement = new AnchorEntityReader(s.store, s.view).entity(wall)!.attributes[5];
  if (typeof placement !== 'string' && typeof placement !== 'number') throw new Error('The fixture wall needs a placement reference');
  const part = s.editor.addEntity('IfcBuildingElementProxy', ['0000000000000000000001', null, 'Part', null, null,
    placement, null, null, '.NOTDEFINED.']).expressId;
  const nest = s.editor.addEntity('IfcRelNests', ['0000000000000000000002', null, null, null, `#${wall}`, [`#${part}`]]).expressId;
  s = session(await parse(s.text()));
  const other = addStoreyInStore(s.store, s.editor, { Name: 'Other', Elevation: 4 }).storeyId;
  for (const rel of readStoreyInventory(s.store, s.view).incoming.get(wall) ?? []) s.editor.removeEntity(rel.id);
  s.editor.addEntity('IfcRelContainedInSpatialStructure', ['0000000000000000000003', null, null, null, [`#${wall}`], `#${other}`]);
  // Nests is an independent graph edge kind. A source reader must not rely
  // on the TS parser's optional Aggregates alias for that same relationship.
  const inverse = s.store.relationships.inverse, edges = inverse.getEdges.bind(inverse);
  const nativeKinds = vi.spyOn(inverse, 'getEdges').mockImplementation((id, kind) =>
    edges(id, kind).filter(edge => kind !== RelationshipType.Aggregates || edge.relationshipId !== nest));
  try { expect(resolveDuplicateSource(s.store, part, s.editor).storeyId).toBe(other); }
  finally { nativeKinds.mockRestore(); }
  expect(home).not.toBe(other);
});

it('#9352 a level X-aligned beam without RefDirection uses the IFC default projection axis', async () => {
  const { s, home } = await setup();
  const beam = addOrdinaryElementInStore(s.editor, d => resolveSpatialAnchor(s.store, home, d.getMutationView()),
    { kind: 'beam', params: { Start: [0, 3, 2.8], End: [5, 3, 2.8], Width: .2, Height: .4 } });
  const reader = new AnchorEntityReader(s.store, s.view);
  const placement = reader.entity(Number(String(reader.entity(beam)!.attributes[5]).replace('#', '')))!;
  const axis = Number(String(placement.attributes[1]).replace('#', ''));
  s.editor.setPositionalAttribute(axis, 2, null);
  expect(levelTopFaceAbove({ dataStore: s.store, view: s.view, editor: s.editor }, beam, 'linear')).toBeCloseTo(.2, 8);
});
