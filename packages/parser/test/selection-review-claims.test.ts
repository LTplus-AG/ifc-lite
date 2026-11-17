/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser, readCurrentTypeQuantities } from '../src/index.js';
import { resolveCurrentTypeRelationships } from '../src/current-type-relationships.js';
import { selectionRelationshipIds } from '../src/selection-relationship-ids.js';

const records = ["#1=IFCPROJECT('p',$,'Project',$,$,$,$,$,$);",
  "#2=IFCWALLTYPE('t',$,'Type',$,$,$,$,$,$,.STANDARD.);",
  "#3=IFCELEMENTQUANTITY('q',$,'Qto_Test',$,$,(#4));",
  "#4=IFCQUANTITYLENGTH('Length',$,$,2.5,$);", "#100=IFCWALL('w',$,'Wall',$,$,$,$,$,$);"];
function bytes(rows: string[]) {
  return new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${rows.join('\n')}ENDSEC;END-ISO-10303-21;`).buffer;
}

it('#9947 deferred property atoms never move exceptional relationships out of the primary index', async () => {
  const store = await new IfcParser().parseColumnar(bytes([...records,
    "#10=IFCRELDEFINESBYTYPE('t',$,$,$,('#100'),#2);",
    "#20=IFCRELDEFINESBYPROPERTIES('q',$,$,$,('#2'),#3);",
  ]), { disableWorkerScan: true, deferPropertyAtomIndex: true });
  const view = new MutablePropertyView(null, 'deferred');
  // Prove the deferred path is active; relationship categories are not atoms.
  expect(store.entityIndex.byId.has(4)).toBe(false);
  expect(store.deferredEntityIndex?.get(4)?.type).toBe('IFCQUANTITYLENGTH');
  for (const id of [10, 20]) {
    expect(store.entityIndex.byId.has(id)).toBe(true);
    expect(store.deferredEntityIndex?.get(id)).toBeUndefined();
    expect(store.selectionRelationshipIndex?.missing).toContain(id);
  }
  expect(selectionRelationshipIds(store, view, 100, [RelationshipType.DefinesByType], ['IFCRELDEFINESBYTYPE'])).toContain(10);
  expect(selectionRelationshipIds(store, view, 2, [RelationshipType.DefinesByProperties], ['IFCRELDEFINESBYPROPERTIES'])).toContain(20);
  const relationships = resolveCurrentTypeRelationships(store, view);
  expect(relationships.typesOf(100)).toEqual([2]);
  expect(relationships.definitionsOf(2)).toEqual([3]);
});

it('#9947 duplicate definition members follow native edit budgets without accumulating across revisions', async () => {
  // 510 source typing references + one distinct definition edge + a created
  // 512 x 511 definition set = 262143. This hits the same exact budget without
  // allocating a quarter-million source graph edges just to test arithmetic.
  const members = Array.from({ length: 509 }, (_, i) => 1000 + i);
  const definitions = Array.from({ length: 511 }, (_, i) => 5000 + i);
  const store = await new IfcParser().parseColumnar(bytes([...records,
    "#10=IFCRELDEFINESBYTYPE('selected',$,$,$,(#100),#2);",
    `#11=IFCRELDEFINESBYTYPE('filler',$,$,$,(${members.map(id => '#' + id).join(',')}),#2);`,
    "#20=IFCRELDEFINESBYPROPERTIES('q',$,$,$,(#2,#2),(#3,#3));",
    ...definitions.map(id => `#${id}=IFCPROPERTYSET('p${id}',$,'Budget',$,());`),
  ]), { disableWorkerScan: true });
  let fillerReads = 0;
  const getEntity = store.getEntity.bind(store);
  store.getEntity = id => { if (id === 11) fillerReads++; return getEntity(id); };
  const native = { ...store, selectionRelationshipIndex: undefined };
  const view = new MutablePropertyView(null, 'duplicates');
  view.setExpressIdWatermark(6000);
  view.createEntity('IfcRelDefinesByProperties', ['budget', null, null, null,
    Array.from({ length: 512 }, (_, i) => 1000 + i), definitions]);
  const compare = (status: 'available' | 'unavailable') => {
    const expected = readCurrentTypeQuantities(native, 100, view);
    expect(expected.status).toBe(status);
    if (status === 'available') expect(expected.value?.quantities[0].quantities[0].value).toBe(2.5);
    expect(readCurrentTypeQuantities(store, 100, view)).toEqual(expected);
  };
  compare('available');
  for (let revision = 0; revision < 8; revision++) {
    view.setAttribute(20, 'Name', 'revision ' + revision);
    compare('available');
    view.setPositionalAttribute(20, 4, [2, 2, 2]); compare('unavailable');
    view.setPositionalAttribute(20, 4, [2, 2]); compare('available');
  }
  expect(fillerReads).toBe(0);
});
