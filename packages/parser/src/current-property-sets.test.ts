/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it, vi } from 'vitest';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand } from './index.js';

async function session() {
  const text = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCWALL('0000000000000000000001',$,'Wall',$,$,$,$,$,$);ENDSEC;END-ISO-10303-21;`;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  return { store, view, editor };
}

it('#9352 raw properties resolve current complex members, reference labels and units', async () => {
  const { store, view, editor } = await session();
  const material = editor.addEntity('IfcMaterial', ['Steel', null, null]);
  const reference = editor.addEntity('IfcPropertyReferenceValue', ['Finish', null, null, `#${material.expressId}`]);
  const unit = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']);
  const length = editor.addEntity('IfcPropertySingleValue', ['Length', null, { typed: { type: 'IfcLengthMeasure', value: 450 } }, `#${unit.expressId}`]);
  const complex = editor.addEntity('IfcComplexProperty', ['Specification', null, 'Assembly', [`#${reference.expressId}`, `#${length.expressId}`]]);
  const set = editor.addEntity('IfcPropertySet', ['0000000000000000000002', null, 'Pset_RawAuthoring', null, [`#${complex.expressId}`]]);
  editor.addEntity('IfcRelDefinesByProperties', ['0000000000000000000003', null, null, null, ['#1'], `#${set.expressId}`]);
  const read = () => extractPropertiesOnDemand(store, 1, view)[0].properties[0];
  expect(read().members).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Finish', value: 'Steel' }),
    expect.objectContaining({ name: 'Length', value: 450, unit: 'mm', unitSiScale: .001 }),
  ]));
  editor.setAttribute(material.expressId, 'Name', 'Aluminium');
  editor.setPositionalAttribute(length.expressId, 2, { typed: { type: 'IfcLengthMeasure', value: 600 } });
  expect(read().members).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'Finish', value: 'Aluminium' }),
    expect.objectContaining({ name: 'Length', value: 600 }),
  ]));
});

it('#9352 a cyclic raw complex property reports its existing depth guard', async () => {
  const { store, view, editor } = await session();
  const complex = editor.addEntity('IfcComplexProperty', ['Loop', null, 'Cycle', []]);
  editor.setPositionalAttribute(complex.expressId, 3, [`#${complex.expressId}`]);
  const set = editor.addEntity('IfcPropertySet', ['0000000000000000000002', null, 'Pset_RawAuthoring', null, [`#${complex.expressId}`]]);
  editor.addEntity('IfcRelDefinesByProperties', ['0000000000000000000003', null, null, null, ['#1'], `#${set.expressId}`]);
  expect(extractPropertiesOnDemand(store, 1, view)[0].properties[0].value).toMatch(/truncat|limit|depth/i);
});

it('#9352 deleting or changing a raw association updates property membership', async () => {
  const { store, view, editor } = await session();
  const prop = editor.addEntity('IfcPropertySingleValue', ['Flag', null, true, null]);
  const set = editor.addEntity('IfcPropertySet', ['0000000000000000000002', null, 'Pset_RawAuthoring', null, [`#${prop.expressId}`]]);
  const rel = editor.addEntity('IfcRelDefinesByProperties', ['0000000000000000000003', null, null, null, ['#1'], `#${set.expressId}`]);
  expect(extractPropertiesOnDemand(store, 1, view)).toHaveLength(1);
  editor.removeEntity(rel.expressId);
  expect(extractPropertiesOnDemand(store, 1, view)).toEqual([]);
});


it('#9352 current property reads do not enumerate unrelated authored entities', async () => {
  const { store, view, editor } = await session();
  for (let i = 0; i < 1000; i++) editor.addEntity('IfcCartesianPoint', [[i, 0, 0]]);
  const prop = editor.addEntity('IfcPropertySingleValue', ['Flag', null, true, null]);
  const set = editor.addEntity('IfcPropertySet', ['0000000000000000000002', null, 'Pset_RawAuthoring', null, [`#${prop.expressId}`]]);
  editor.addEntity('IfcRelDefinesByProperties', ['0000000000000000000003', null, null, null, ['#1'], `#${set.expressId}`]);
  const ordinary = vi.spyOn(view, 'getNewEntities'), borrowed = vi.spyOn(view, 'readNewEntities');
  try {
    expect(extractPropertiesOnDemand(store, 1, view)[0].properties[0].value).toBe(true);
    expect(ordinary).not.toHaveBeenCalled();
    expect(borrowed).not.toHaveBeenCalled();
  } finally { ordinary.mockRestore(); borrowed.mockRestore(); }
});
