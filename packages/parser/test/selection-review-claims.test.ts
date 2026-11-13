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
  // 262142 distinct typing edges + one distinct definition edge. Native reads
  // of an edited row count its raw member list: two admits, three refuses.
  const members = [100, ...Array.from({ length: 262141 }, (_, i) => 1000 + i)];
  const store = await new IfcParser().parseColumnar(bytes([...records,
    `#10=IFCRELDEFINESBYTYPE('t',$,$,$,(${members.map(id => '#' + id).join(',')}),#2);`,
    "#20=IFCRELDEFINESBYPROPERTIES('q',$,$,$,(#2,#2),(#3,#3));",
  ]), { disableWorkerScan: true });
  const native = { ...store, selectionRelationshipIndex: undefined };
  const view = new MutablePropertyView(null, 'duplicates');
  const compare = (status: 'available' | 'unavailable') => {
    const expected = readCurrentTypeQuantities(native, 100, view);
    expect(expected.status).toBe(status);
    expect(readCurrentTypeQuantities(store, 100, view)).toEqual(expected);
  };
  compare('available');
  for (let revision = 0; revision < 8; revision++) {
    view.setAttribute(20, 'Name', 'revision ' + revision);
    compare('available');
    view.setPositionalAttribute(20, 4, [2, 2, 2]); compare('unavailable');
    view.setPositionalAttribute(20, 4, [2, 2]); compare('available');
  }
});
