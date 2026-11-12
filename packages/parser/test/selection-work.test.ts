/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it, expect } from 'vitest';
import { IfcParser, extractAllMaterialsOnDemand, extractClassificationsOnDemand, extractDocumentsOnDemand, readCurrentTypeQuantities, prepareTypeQuantityRelationships } from '../src/index.js';
import type { MetadataReadView } from '../src/effective-metadata-record.js';

async function fixture(extra: string[] = []) {
  const lines = ["#1=IFCWALL('w',$,'Wall',$,$,$,$,$,$);", "#2=IFCWALLTYPE('t',$,'Type',$,$,(#6),$,$,$,.STANDARD.);",
    "#3=IFCMATERIAL('Concrete',$,$);", "#4=IFCRELDEFINESBYTYPE('r',$,$,$,(#1),#2);",
    "#5=IFCRELASSOCIATESMATERIAL('m',$,$,$,(#2),#3);", "#6=IFCELEMENTQUANTITY('q',$,'Qto_Test',$,$,(#7));",
    "#7=IFCQUANTITYLENGTH('Length',$,$,2.5,$);", "#8=IFCCLASSIFICATION('source','edition',$,'System',$,$,$);",
    "#9=IFCCLASSIFICATIONREFERENCE($,'code','Class',#8,$,$);", "#10=IFCRELASSOCIATESCLASSIFICATION('c',$,$,$,(#2),#9);",
    "#12=IFCDOCUMENTREFERENCE('https://example.org','doc','Document',$,$);", "#13=IFCRELASSOCIATESDOCUMENT('d',$,$,$,(#2),#12);",
    "#11=IFCMATERIAL('Steel',$,$);"];
  for (let i = 0; i < 500; i++) lines.push(`#${100+i}=IFCRELASSOCIATESMATERIAL('other${i}',$,$,$,(#${1000+i}),#3);`,
    `#${1000+i}=IFCWALL('wall${i}',$,'Other',$,$,$,$,$,$);`, `#${2000+i}=IFCRELDEFINESBYTYPE('type${i}',$,$,$,(#${1000+i}),#2);`);
  const bytes = new TextEncoder().encode(`ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;${[...lines, ...extra].join('\n')}ENDSEC;END-ISO-10303-21;`);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  let revision = 0;
  const edits = new Map<number, Map<number, string | number>>();
  const view: MetadataReadView & { hasPendingChanges(): boolean } = {
    isDeleted: () => false, getNewEntities: () => [], getNewEntity: () => null,
    getTombstones: () => new Set(), getTypeMutations: () => new Map(),
    getPositionalMutationsForEntity: id => edits.get(id) ?? null,
    getAttributeMutationsForEntity: () => [], getMutationRevision: () => revision,
    hasPendingChanges: () => edits.size > 0,
    getEffectiveChanges: () => [...edits.keys()].map(entityId => ({ entityId, kind: 'attribute' })),
  };
  return { store, view, edit(id: number, slot: number, value: string | number) { const row = edits.get(id) ?? new Map<number, string | number>(); row.set(slot, value); edits.set(id, row); revision++; } };
}

it('#9947 reads only incident material relationships, with type fallback and endpoint edits', async () => {
  const { store, view, edit } = await fixture();
  const get = store.getEntity.bind(store), reads: number[] = [];
  store.getEntity = id => { reads.push(id); return get(id); };
  expect(extractAllMaterialsOnDemand(store, 1, view)[0]?.name).toBe('Concrete');
  expect(reads.filter(id => id >= 100 && id < 600)).toEqual([]);
  // A previously unrelated association is moved INTO the selected occurrence.
  edit(100, 4, '#1');
  edit(100, 5, '#11');
  expect(extractAllMaterialsOnDemand(store, 1, view).map(row => row.name)).toEqual(['Steel']);
});

it('#9947 classification selection reads its own type associations, not unrelated materials', async () => {
  const { store, view } = await fixture();
  const get = store.getEntity.bind(store), reads: number[] = [];
  store.getEntity = id => { reads.push(id); return get(id); };
  expect(extractClassificationsOnDemand(store, 1, view).length).toBe(1);
  expect(reads.filter(id => id >= 2000 && id < 2500)).toEqual([]);
});

it('#9947 published type coverage avoids a relationship inventory on selection and invalidates after edits', async () => {
  const { store, view, edit } = await fixture();
  prepareTypeQuantityRelationships(store);
  let scans = 0;
  const original = view.getAttributeMutationsForEntity;
  view.getAttributeMutationsForEntity = id => { scans++; return original(id); };
  const result = readCurrentTypeQuantities(store, 1, view);
  expect(result.value?.quantities[0].quantities[0].value).toBe(2.5);
  expect(scans).toBeLessThan(10);
  edit(7, 3, 4.5);
  expect(readCurrentTypeQuantities(store, 1, view).value?.quantities[0].quantities[0].value).toBe(4.5);
});

it('#9947 document selection reads type documents without enumerating unrelated typing rows', async () => {
  const { store, view } = await fixture();
  const get = store.getEntity.bind(store), reads: number[] = [];
  store.getEntity = id => { reads.push(id); return get(id); };
  expect(extractDocumentsOnDemand(store, 1, view).map(row => row.name)).toEqual(['Document']);
  expect(reads.filter(id => id >= 2000 && id < 2500)).toEqual([]);
});

it('#9947 retains source-only relationship rows that the graph cannot vouch for', async () => {
  const { store, view } = await fixture(["#14=IFCRELASSOCIATESMATERIAL('legacy',$,$,$,('#1'),#11);"]);
  expect(extractAllMaterialsOnDemand(store, 1, view).map(row => row.name)).toEqual(['Steel']);
});

it('#9947 retains document association source order when graph target order differs', async () => {
  const { store, view } = await fixture([
    "#16=IFCDOCUMENTREFERENCE($,'second','Second',$,$);",
    "#15=IFCRELASSOCIATESDOCUMENT('first',$,$,$,(#1),#16);",
    "#14=IFCRELASSOCIATESDOCUMENT('second',$,$,$,(#1),#12);",
  ]);
  expect(extractDocumentsOnDemand(store, 1, view).map(row => row.name)).toEqual(['Second', 'Document']);
});

it('#9947 preparation retains unavailable coverage instead of throwing through model publication', async () => {
  const { store, view } = await fixture(["#14=IFCRELDEFINESBYTYPE('unindexed',$,$,$,('#1'),#2);"]);
  store.getEntity = () => { throw new Error('source read failed'); };
  expect(() => prepareTypeQuantityRelationships(store)).not.toThrow();
  expect(readCurrentTypeQuantities(store, 1, view)).toEqual({ status: 'unavailable',
    reason: 'Native current type quantities are unreadable', value: null });
});

it('#9947 selecting one member does not project a shared typing row onto every sibling', async () => {
  const members = [1, ...Array.from({ length: 500 }, (_, i) => 1000 + i)];
  const { store, view } = await fixture([`#30=IFCRELDEFINESBYTYPE('shared',$,$,$,(${members.map(id => `#${id}`).join(',')}),#2);`]);
  const isDeleted = view.isDeleted, siblings: number[] = [];
  view.isDeleted = id => { if (id >= 1000 && id < 1500) siblings.push(id); return isDeleted(id); };
  expect(extractAllMaterialsOnDemand(store, 1, view)[0]?.name).toBe('Concrete');
  expect(siblings).toEqual([]);
});
