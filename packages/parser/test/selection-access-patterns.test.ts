/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it, expect } from 'vitest';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser, extractPropertiesOnDemand, extractAllMaterialsOnDemand, extractClassificationsOnDemand, extractDocumentsOnDemand, readCurrentTypeQuantities, type IfcDataStore } from '../src/index.js';
import { toTransport, fromTransport } from '../src/data-store-transport.js';
import { classificationEdges } from '../src/classification-overlay.js';

async function model(count = 600, extra: string[] = []) {
  const rows = ["#1=IFCPROJECT('p',$,'Project',$,$,$,$,$,$);", "#2=IFCWALLTYPE('t',$,'Type',$,$,(#3),$,$,$,.STANDARD.);",
    "#3=IFCELEMENTQUANTITY('q',$,'Qto_Test',$,$,(#4));", "#4=IFCQUANTITYLENGTH('Length',$,$,2.5,$);", "#5=IFCMATERIAL('Concrete',$,$);"];
  for (let i = 0; i < count; i++) rows.push(`#${100+i}=IFCWALL('w${i}',$,'Wall',$,$,$,$,$,$);`,
    `#${100000+i}=IFCRELDEFINESBYTYPE('t${i}',$,$,$,(#${100+i}),#2);`,
    `#${200000+i}=IFCRELDEFINESBYPROPERTIES('p${i}',$,$,$,(#${100+i}),#6);`);
  rows.push("#6=IFCPROPERTYSET('ps',$,'Pset_Test',$,(#7));", "#7=IFCPROPERTYSINGLEVALUE('Value',$,IFCLABEL('base'),$);",
    "#8=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#2),#5);");
  rows.push(...extra);
  let early: IfcDataStore | undefined;
  const bytes = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${rows.join('\n')}ENDSEC;END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true, onSpatialReady: s => { early = s; } });
  const view = new MutablePropertyView(null, 'selection');
  return { store, view, early: early! };
}

it('#9947 unrelated property edits never extract base properties during relationship selections', async () => {
  const { store, view } = await model();
  let reads = 0;
  view.setOnDemandExtractor(id => { reads++; return extractPropertiesOnDemand(store, id); });
  for (let id = 200; id < 250; id++) view.setProperty(id, 'Pset_Test', 'Value', 'edited');
  reads = 0;
  for (let id = 100; id < 110; id++) {
    expect(extractAllMaterialsOnDemand(store, id, view)[0]?.name).toBe('Concrete');
    extractClassificationsOnDemand(store, id, view); extractDocumentsOnDemand(store, id, view);
  }
  expect(reads).toBe(0);
});

it('#9947 one type-quantity read does not probe unrelated relationship rows', async () => {
  const { store, view } = await model();
  let probes = 0;
  const original = view.getAttributeMutationsForEntity.bind(view);
  view.getAttributeMutationsForEntity = id => { probes++; return original(id); };
  expect(readCurrentTypeQuantities(store, 100, view).value?.quantities[0].quantities[0].value).toBe(2.5);
  expect(probes).toBeLessThan(20);
});

it('#9947 early stores with 30000 typing and definition rows read only the selected type', async () => {
  const { early, view } = await model(30000);
  let reads = 0;
  const original = early.getEntity.bind(early);
  early.getEntity = id => { reads++; return original(id); };
  expect(readCurrentTypeQuantities(early, 100, view).value?.quantities[0].quantities[0].value).toBe(2.5);
  expect(reads).toBeLessThan(20);
});

it('#9947 bulk subjects decode a shared typing row at most once per revision', async () => {
  const { store, view } = await model();
  // A large authored relationship also occurs in real native sessions.
  view.setExpressIdWatermark(300000);
  const created = view.createEntity('IfcRelDefinesByType', ['shared', null, null, null,
    Array.from({ length: 600 }, (_, i) => 100 + i), 2]);
  let reads = 0, decodes = 0;
  const attributes = view.getAttributeMutationsForEntity.bind(view);
  view.getAttributeMutationsForEntity = id => { if (id === created.expressId) decodes++; return attributes(id); };
  const original = view.getNewEntities.bind(view);
  view.getNewEntities = () => { reads++; return original(); };
  for (let id = 100; id < 700; id++) {
    extractAllMaterialsOnDemand(store, id, view); extractClassificationsOnDemand(store, id, view); extractDocumentsOnDemand(store, id, view);
  }
  expect(created.expressId).toBeGreaterThan(300000);
  expect(reads).toBeLessThan(10);
  expect(decodes).toBe(1);
});

it('#9947 omitted classification subject retains the full inventory contract', async () => {
  const { store, view } = await model();
  expect(classificationEdges(store, view).types.get(100)).toEqual([2]);
});

it('#9947 unexpected source errors are retried on the next type-quantity read', async () => {
  const { store, view } = await model(600, ["#300000=IFCRELDEFINESBYTYPE('legacy',$,$,$,('#100'),#2);"]);
  const original = store.getEntity.bind(store); let fail = true;
  store.getEntity = id => { if (fail) { fail = false; throw new Error('transient source failure'); } return original(id); };
  expect(readCurrentTypeQuantities(store, 100, view).status).toBe('unavailable');
  expect(readCurrentTypeQuantities(store, 100, view).value?.quantities[0].quantities[0].value).toBe(2.5);
});

it('#9947 worker transport retains direct type coverage and early relationship-attached quantities', async () => {
  const { early, view } = await model(600, ["#300001=IFCRELDEFINESBYPROPERTIES('type-q',$,$,$,(#2),#3);"]);
  view.setPositionalAttribute(2, 5, []);
  const { payload } = toTransport(early);
  const restored = fromTransport(structuredClone(payload), early.source);
  let probes = 0;
  const original = view.getAttributeMutationsForEntity.bind(view);
  view.getAttributeMutationsForEntity = id => { probes++; return original(id); };
  expect(readCurrentTypeQuantities(restored, 100, view).value?.quantities[0].quantities[0].value).toBe(2.5);
  expect(probes).toBeLessThan(20);
});

it('#9947 separate selection turns never trigger the bulk inventory threshold', async () => {
  const { store, view } = await model();
  let reads = 0;
  const original = store.getEntity.bind(store);
  store.getEntity = id => { reads++; return original(id); };
  for (let id = 100; id < 180; id++) {
    await Promise.resolve();
    expect(extractAllMaterialsOnDemand(store, id, view)[0]?.name).toBe('Concrete');
  }
  expect(reads).toBeLessThan(200);
});

it('#9947 source-backed selections do not enumerate the model classification-reference bucket', async () => {
  const { store, view } = await model();
  let enumerations = 0;
  const get = store.entityIndex.byType.get.bind(store.entityIndex.byType);
  store.entityIndex.byType.get = type => { if (type === 'IFCCLASSIFICATIONREFERENCE') enumerations++; return get(type); };
  expect(extractClassificationsOnDemand(store, 100, view)).toEqual([]);
  expect(enumerations).toBe(0);
});
