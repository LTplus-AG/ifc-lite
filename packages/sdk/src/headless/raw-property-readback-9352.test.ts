/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseModel } from '@ifc-lite/parser';
import { createBimContext } from '../index.js';
import { HeadlessBackend } from './backend.js';

const sample = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
async function session(bytes: Uint8Array = readFileSync(sample)) {
  const { store } = await parseModel(bytes, { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'model.ifc', 'm'), bim = createBimContext({ backend });
  const home = bim.store.listStoreyLevels('m')[0].expressId;
  const wall = bim.store.addWall('m', home, { Start: [0, 5, 0], End: [4, 5, 0], Thickness: .2, Height: 3 });
  return { backend, bim, S: bim.store, wall };
}
function exported(s: Awaited<ReturnType<typeof session>>): Uint8Array {
  const bytes = s.bim.export.ifc();
  return typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
}

for (const attachment of ['HasPropertySets', 'IfcRelDefinesByProperties'] as const) {
  it(`#9352 a raw ${attachment} property set reads live, follows atom edits and survives reopen`, async () => {
    const s = await session();
    try {
      const type = s.S.addElementType('m', { Type: 'IfcWallType', Name: 'Raw type', PredefinedType: 'STANDARD' });
      s.S.assignType('m', type.expressId, [s.wall.expressId]);
      const property = s.S.addEntity('m', { type: 'IfcPropertySingleValue', attributes: ['FireRating', null, { typed: { type: 'IfcLabel', value: 'EI60' } }, null] });
      const pset = s.S.addEntity('m', { type: 'IfcPropertySet', attributes: ['0000000000000000000001', null, 'Pset_RawAuthoring', null, [`#${property.expressId}`]] });
      if (attachment === 'HasPropertySets') s.S.setPositionalAttribute(type, 5, [`#${pset.expressId}`]);
      else s.S.addEntity('m', { type: 'IfcRelDefinesByProperties', attributes: ['0000000000000000000002', null, null, null, [`#${s.wall.expressId}`], `#${pset.expressId}`] });
      const rating = (bim: typeof s.bim) => (attachment === 'HasPropertySets' ? bim.typeProperties(s.wall)?.properties : bim.properties(s.wall))
        ?.find(p => p.name === 'Pset_RawAuthoring')?.properties.find(p => p.name === 'FireRating')?.value;
      expect(rating(s.bim)).toBe('EI60');
      s.S.setPositionalAttribute(property, 2, { typed: { type: 'IfcLabel', value: 'EI90' } });
      expect(rating(s.bim)).toBe('EI90');
      const { store } = await parseModel(exported(s), { disableWorkerScan: true });
      const reopened = new HeadlessBackend(store, 'reopened.ifc', 'm');
      try { expect(rating(createBimContext({ backend: reopened }))).toBe('EI90'); } finally { reopened.dispose(); }
    } finally { s.backend.dispose(); }
  });
}

it('#9352 a type with an explicitly empty Name reads the same before and after reopen', async () => {
  const s = await session();
  try {
    const type = s.S.addElementType('m', { Type: 'IfcWallType', Name: 'Temporary name', PredefinedType: 'STANDARD' });
    s.S.assignType('m', type.expressId, [s.wall.expressId]);
    s.bim.mutate.setProperty(type, 'Pset_RawAuthoring', 'FireRating', 'EI60', 'IfcLabel');
    s.S.setPositionalAttribute(type, 2, '');
    expect(s.bim.typeProperties(s.wall)?.typeName).toBe('');
    const { store } = await parseModel(exported(s), { disableWorkerScan: true });
    const reopened = new HeadlessBackend(store, 'reopened.ifc', 'm');
    try { expect(createBimContext({ backend: reopened }).typeProperties(s.wall)?.typeName).toBe(''); } finally { reopened.dispose(); }
  } finally { s.backend.dispose(); }
});

it('#9352 a raw pset and a high-level property edit describe one saved value', async () => {
  const s = await session();
  try {
    const property = s.S.addEntity('m', { type: 'IfcPropertySingleValue', attributes: ['FireRating', null, { typed: { type: 'IfcLabel', value: 'EI60' } }, null] });
    const pset = s.S.addEntity('m', { type: 'IfcPropertySet', attributes: ['0000000000000000000001', null, 'Pset_RawAuthoring', null, [`#${property.expressId}`]] });
    s.S.addEntity('m', { type: 'IfcRelDefinesByProperties', attributes: ['0000000000000000000002', null, null, null, [`#${s.wall.expressId}`], `#${pset.expressId}`] });
    expect(s.bim.properties(s.wall).find(p => p.name === 'Pset_RawAuthoring')?.properties[0].value).toBe('EI60');
    s.bim.mutate.setProperty(s.wall, 'Pset_RawAuthoring', 'FireRating', 'EI90', 'IfcLabel');
    const { store } = await parseModel(exported(s), { disableWorkerScan: true });
    const reopened = new HeadlessBackend(store, 'reopened.ifc', 'm');
    try {
      const values = createBimContext({ backend: reopened }).properties(s.wall).filter(p => p.name === 'Pset_RawAuthoring')
        .flatMap(p => p.properties.filter(p => p.name === 'FireRating').map(p => p.value));
      expect(values).toEqual(['EI90']);
    } finally { reopened.dispose(); }
  } finally { s.backend.dispose(); }
});

it('#9352 a property read in an atomic draft uses the draft raw records', async () => {
  const s = await session();
  try {
    const type = s.S.addElementType('m', { Type: 'IfcWallType', Name: 'Draft type', PredefinedType: 'STANDARD' });
    s.backend.ensureEditor().runAtomic(draft => {
      const property = draft.addEntity('IfcPropertySingleValue', ['FireRating', null, { typed: { type: 'IfcLabel', value: 'EI60' } }, null]);
      const pset = draft.addEntity('IfcPropertySet', ['0000000000000000000001', null, 'Pset_RawAuthoring', null, [`#${property.expressId}`]]);
      draft.setPositionalAttribute(type.expressId, 5, [`#${pset.expressId}`]);
      expect(draft.getMutationView().getPropertyValue(type.expressId, 'Pset_RawAuthoring', 'FireRating')).toBe('EI60');
    });
  } finally { s.backend.dispose(); }
});


it('#9352 a source relationship order keeps the same-named set claim stable', async () => {
  const s = await session();
  try {
    const make = (guid: string, value: string) => {
      const prop = s.S.addEntity('m', { type: 'IfcPropertySingleValue', attributes: ['Flag', null, { typed: { type: 'IfcLabel', value } }, null] });
      return s.S.addEntity('m', { type: 'IfcPropertySet', attributes: [guid, null, 'Pset_SameName', null, [`#${prop.expressId}`]] });
    };
    const first = make('0000000000000000000001', 'first'), second = make('0000000000000000000002', 'second');
    for (const [i, set] of [second, first].entries()) s.S.addEntity('m', { type: 'IfcRelDefinesByProperties',
      attributes: [`000000000000000000000${i + 3}`, null, null, null, [`#${s.wall.expressId}`], `#${set.expressId}`] });
    const { store } = await parseModel(exported(s), { disableWorkerScan: true });
    const backend = new HeadlessBackend(store, 'source-order.ifc', 'm'), bim = createBimContext({ backend });
    try {
      const values = () => bim.properties(s.wall).filter(p => p.name === 'Pset_SameName').map(p => p.properties[0].value);
      expect(values()).toEqual(['second', 'first']);
      bim.mutate.setProperty(s.wall, 'Pset_SameName', 'Flag', 'edited', 'IfcLabel');
      expect(values()).toEqual(['edited', 'first']);
    } finally { backend.dispose(); }
  } finally { s.backend.dispose(); }
});
