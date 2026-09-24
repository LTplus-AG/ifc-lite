/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcTypeEnum } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { executeList, type ListDefinition } from '@ifc-lite/lists';
import { createListDataProvider } from './adapter.js';

it('List execution reads effective membership and row values from one model (#5249)', async () => {
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'Tower',$,$,$,$,$,$);
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION((0.,0.,1.));
#22=IFCDIRECTION((1.,0.,0.));
#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);
#24=IFCLOCALPLACEMENT($,#23);
#25=IFCRECTANGLEPROFILEDEF(.AREA.,$,#23,1.,1.);
#26=IFCEXTRUDEDAREASOLID(#25,#23,#21,1.);
#27=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#26));
#28=IFCPRODUCTDEFINITIONSHAPE($,$,(#27));
#41=IFCWALL('0Wall00000000000000041',$,'Wall A',$,$,#24,#28,$,$);
#42=IFCWALL('0Wall00000000000000042',$,'Wall B',$,$,#24,#28,$,$);
#44=IFCDOOR('0Door00000000000000044',$,'Door A',$,$,#24,#28,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(text);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const view = new MutablePropertyView(store.properties, 'a');
  view.setExpressIdWatermark(100);
  view.deleteEntity(42);
  view.setEntityType(44, 'IfcWall');
  view.setAttribute(44, 'Name', 'Converted wall');
  view.setProperty(44, 'Pset_Test', 'Mark', 'Edited');
  view.setQuantity(44, 'Qto_Test', 'Length', 12);
  const created = view.createEntity('IfcDuctSegment', ['0Duct0000000000000001', '$', 'New duct', '$', '$', '#24', '#28', '$', '$']);

  const provider = createListDataProvider(store, '', undefined, view);
  assert.deepEqual(provider.getEntitiesByType(IfcTypeEnum.IfcWall), [41, 44]);
  assert.deepEqual(provider.getEntitiesByType(IfcTypeEnum.IfcDoor), []);
  assert.deepEqual(provider.getEntitiesByType(IfcTypeEnum.IfcDuctSegment), [created.expressId]);
  assert.deepEqual(provider.getAllEntityIds?.(), [41, 44, created.expressId]);
  assert.equal(provider.getEntityTypeName(44), 'IfcWall');
  assert.equal(provider.getEntityName(44), 'Converted wall');
  assert.equal(provider.getEntityName(created.expressId), 'New duct');
  assert.equal(provider.getPropertySets(44)[0]?.properties[0]?.value, 'Edited');
  assert.equal(provider.getQuantitySets(44)[0]?.quantities[0]?.value, 12);
  assert.deepEqual(provider.discoverAllColumns?.().properties.get('Pset_Test'), ['Mark']);
  assert.deepEqual(provider.discoverAllColumns?.().quantities.get('Qto_Test'), ['Length']);

  const definition: ListDefinition = {
    id: 'walls', name: 'Walls', createdAt: 0, updatedAt: 0,
    entityTypes: [IfcTypeEnum.IfcWall], conditions: [],
    columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }],
  };
  assert.deepEqual(executeList(definition, provider).rows.map((row) => row.values[0]), ['Wall A', 'Converted wall']);
  assert.deepEqual(executeList({ ...definition, expressIdsByModel: { default: [42] } }, provider).rows, []);

  const otherView = new MutablePropertyView(store.properties, 'b');
  otherView.deleteEntity(41);
  const otherProvider = createListDataProvider(store, '', undefined, otherView);
  assert.deepEqual(otherProvider.getEntitiesByType(IfcTypeEnum.IfcWall), [42]);
  assert.deepEqual(provider.getEntitiesByType(IfcTypeEnum.IfcWall), [41, 44]);
});
