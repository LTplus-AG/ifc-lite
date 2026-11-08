/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9192: the first selection of a large model read every typing relationship
 * from block-compressed source. The current read now takes them from the parsed
 * graph and reads only what it needs, so these tests pin both halves: which
 * records a read decodes, and that the answer is the one reading every
 * relationship gives, through a real parse and a real overlay.
 */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { RelationshipGraphBuilder, RelationshipType, relationshipGraphFromColumns, relationshipGraphToColumns } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser, compressSource, compressSourceInPlace, readCurrentTypeQuantities, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { cleanup, render } from '@/test/render';
import { fixtureModel } from '@/test/store-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

const gid = (n: number) => String(n).padStart(22, '0');
const wall = (id: number) => `#${id}=IFCWALL('${gid(id)}',$,'W${id}',$,$,$,$,$,$);`;
const typing = (id: number, members: string, type: string) => `#${id}=IFCRELDEFINESBYTYPE('${gid(id)}',$,$,$,${members},${type});`;

/**
 * Walls #10 and #11 share type A through one relationship. Wall #12 has two
 * types, its first relationship in the file having the higher id. Wall #13 is
 * typed twice over by two relationships naming the same pair. Wall #14 has no
 * type. Type A carries one set itself and one through a relationship; type B
 * carries a set through a definition set.
 */
const BASE = [
  ...[10, 11, 12, 13, 14].map(wall),
  `#20=IFCWALLTYPE('${gid(20)}',$,'A',$,$,(#21),$,$,$,.STANDARD.);`,
  `#21=IFCELEMENTQUANTITY('${gid(21)}',$,'Qto_Own',$,$,(#22));`, "#22=IFCQUANTITYLENGTH('L',$,$,1.5,$);",
  `#24=IFCELEMENTQUANTITY('${gid(24)}',$,'Qto_Related',$,$,(#25));`, "#25=IFCQUANTITYLENGTH('L',$,$,2.5,$);",
  `#40=IFCWALLTYPE('${gid(40)}',$,'B',$,$,$,$,$,$,.STANDARD.);`,
  `#41=IFCELEMENTQUANTITY('${gid(41)}',$,'Qto_B',$,$,(#43));`, "#43=IFCQUANTITYLENGTH('L',$,$,3.5,$);",
  `#42=IFCPROPERTYSET('${gid(42)}',$,'Pset_B',$,());`,
  typing(33, '(#12)', '#40'), typing(32, '(#12)', '#20'), typing(30, '(#10,#11)', '#20'),
  typing(34, '(#13)', '#40'), typing(35, '(#13)', '#40'),
  `#36=IFCRELDEFINESBYPROPERTIES('${gid(36)}',$,$,$,(#20),#24);`,
  `#37=IFCRELDEFINESBYPROPERTIES('${gid(37)}',$,$,$,(#40),(#41,#42));`,
  `#38=IFCRELAGGREGATES('${gid(38)}',$,$,$,#14,(#13));`,
];
const ELEMENTS = [10, 11, 12, 13, 14];

function bytesOf(lines: string[]) {
  const text = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('t.ifc','2026-11-07T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;', 'DATA;',
    `#1=IFCPROJECT('${gid(1)}',$,'P',$,$,$,$,$,#3);`, '#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);', '#3=IFCUNITASSIGNMENT((#2));',
    ...lines, 'ENDSEC;', 'END-ISO-10303-21;',
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
const parse = (lines: string[]) => new IfcParser().parseColumnar(bytesOf(lines), { disableWorkerScan: true });

/** The same store with no graph to consult, so every relationship is read from its record. */
const everyRelationshipRead = (store: IfcDataStore): IfcDataStore => ({ ...store, relationships: new RelationshipGraphBuilder().build() });

/** 'A: Qto_Own,Qto_Related' for a typed element, 'none' without quantities, 'refused' when unavailable. */
const describe = (store: IfcDataStore, id: number, view: MutablePropertyView) => {
  const read = readCurrentTypeQuantities(store, id, view);
  if (read.status === 'unavailable') return 'refused';
  return read.value ? `${read.value.typeName}: ${read.value.quantities.map(set => set.name).join(',')}` : 'none';
};
const describeAll = (store: IfcDataStore, view: MutablePropertyView) => ELEMENTS.map(id => describe(store, id, view));

/**
 * Compare read lists by count and a short sample. On reverted code a list holds tens of
 * thousands of ids, and a deepEqual failure diffing it against [] ran for most of a minute and
 * tens of gigabytes before it printed (it took down the revert oracle's runner).
 */
const assertReadIds = (actual: readonly number[], expected: readonly number[], message: string) =>
  assert.ok(actual.length === expected.length && actual.every((id, at) => id === expected[at]),
    `${message}: read ${actual.length} record(s) [${actual.slice(0, 8).join(', ')}${actual.length > 8 ? ', ...' : ''}], expected [${expected.join(', ')}]`);

const CLEAN = ['A: Qto_Own,Qto_Related', 'A: Qto_Own,Qto_Related', 'B: Qto_B', 'B: Qto_B', 'none'];
const EDITS: Array<[string, (view: MutablePropertyView) => void, string[]]> = [
  ['no edit', () => {}, CLEAN],
  ['a deleted relationship', view => { view.deleteEntity(30); }, ['none', 'none', 'B: Qto_B', 'B: Qto_B', 'none']],
  ['an edit removing a member', view => view.setPositionalAttribute(30, 4, ['#11']), ['none', 'A: Qto_Own,Qto_Related', 'B: Qto_B', 'B: Qto_B', 'none']],
  ['an edit adding a member', view => view.setPositionalAttribute(30, 4, ['#10', '#11', '#14']), ['A: Qto_Own,Qto_Related', 'A: Qto_Own,Qto_Related', 'B: Qto_B', 'B: Qto_B', 'A: Qto_Own,Qto_Related']],
  ['an edit changing the type', view => view.setPositionalAttribute(30, 5, '#40'), ['B: Qto_B', 'B: Qto_B', 'B: Qto_B', 'B: Qto_B', 'none']],
  // A named edit leaves RelatingType as the text '#40', which this reader has always refused as
  // unreadable, model-wide (base 7a92ff7347 does the same). The point is that the edit is seen.
  ['a named edit changing the type', view => view.setAttribute(30, 'RelatingType', '#40'), ['refused', 'refused', 'refused', 'refused', 'refused']],
  ['the first of two types deleted', view => { view.deleteEntity(33); }, [...CLEAN.slice(0, 2), 'A: Qto_Own,Qto_Related', ...CLEAN.slice(3)]],
  ['the first of two types edited away', view => view.setPositionalAttribute(33, 4, ['#14']), [...CLEAN.slice(0, 2), 'A: Qto_Own,Qto_Related', 'B: Qto_B', 'B: Qto_B']],
  ['one of two relationships naming the same pair deleted', view => { view.deleteEntity(34); }, CLEAN],
  ['both relationships naming the same pair deleted', view => { view.deleteEntity(34); view.deleteEntity(35); }, [...CLEAN.slice(0, 3), 'none', 'none']],
  ['a relationship retyped away', view => view.setEntityType(30, 'IfcRelAssignsToGroup'), ['none', 'none', 'B: Qto_B', 'B: Qto_B', 'none']],
  ['a created relationship', view => { view.createEntity('IfcRelDefinesByType', [gid(50), null, null, null, ['#14'], '#20']); }, [...CLEAN.slice(0, 4), 'A: Qto_Own,Qto_Related']],
  ['a created relationship deleted again', view => { view.deleteEntity(view.createEntity('IfcRelDefinesByType', [gid(50), null, null, null, ['#14'], '#20']).expressId); }, CLEAN],
  ['a definition relationship deleted', view => { view.deleteEntity(36); }, ['A: Qto_Own', 'A: Qto_Own', 'B: Qto_B', 'B: Qto_B', 'none']],
  ['a definition relationship retargeted', view => view.setPositionalAttribute(36, 4, ['#40']), ['A: Qto_Own', 'A: Qto_Own', 'B: Qto_Related,Qto_B', 'B: Qto_Related,Qto_B', 'none']],
  ['a created definition relationship', view => { view.createEntity('IfcRelDefinesByProperties', [gid(51), null, null, null, ['#40'], '#24']); }, ['A: Qto_Own,Qto_Related', 'A: Qto_Own,Qto_Related', 'B: Qto_B,Qto_Related', 'B: Qto_B,Qto_Related', 'none']],
  ['a member of a definition set deleted', view => { view.deleteEntity(41); }, [...CLEAN.slice(0, 2), 'none', 'none', 'none']],
  ['a type deleted', view => { view.deleteEntity(40); }, [...CLEAN.slice(0, 2), 'refused', 'refused', 'none']],
  ['an unreadable edit to any relationship', view => view.setPositionalAttribute(35, 4, 'unreadable'), ['refused', 'refused', 'refused', 'refused', 'refused']],
];

for (const [label, edit, expected] of EDITS) {
  test(`#9192 ${label}: the read through the graph matches a read of every relationship`, async () => {
    const store = await parse(BASE);
    const view = new MutablePropertyView(null, 'm');
    edit(view);
    assert.deepEqual(describeAll(store, view), expected);
    assert.deepEqual(describeAll(everyRelationshipRead(store), view), expected, 'reading every relationship gives the same answer');
    assert.deepEqual(describeAll({ ...store, relationships: relationshipGraphFromColumns(relationshipGraphToColumns(store.relationships)) }, view),
      expected, 'a graph restored from columns, as a worker or cache load hands it over, gives the same answer');
  });
}

test('#9192 an edit made after a read is honoured by the next read', async () => {
  const store = await parse(BASE);
  const view = new MutablePropertyView(null, 'm');
  assert.equal(describe(store, 10, view), 'A: Qto_Own,Qto_Related');
  view.setPositionalAttribute(30, 5, '#40');
  assert.equal(describe(store, 10, view), 'B: Qto_B');
  view.removePositionalMutation(30, 5);
  assert.equal(describe(store, 10, view), 'A: Qto_Own,Qto_Related');
});

test('#9192 a read decodes the relationships of the element and its type, and no other', async () => {
  const filler = Array.from({ length: 400 }, (_, i) => 1000 + i);
  const store = await parse([...BASE, ...filler.flatMap(id => [wall(id), typing(id + 1000, `(#${id})`, '#40')])]);
  const reads: number[] = [];
  const counted: IfcDataStore = { ...store, getEntity: id => { reads.push(id); return store.getEntity(id); } };
  const view = new MutablePropertyView(null, 'm');
  const fillerRelations = new Set(filler.map(id => id + 1000));
  const fillerReads = () => reads.filter(id => fillerRelations.has(id));

  assert.equal(describe(counted, 10, view), 'A: Qto_Own,Qto_Related');
  assertReadIds(fillerReads(), [], 'no unrelated typing relationship is decoded');
  assert.ok(reads.includes(30) && reads.includes(36), 'the relationships naming the element and its type are read from their records');
  assert.ok(!reads.includes(33) && !reads.includes(37), 'the relationships naming other elements and types are not');

  // An edit brings back the one record it touched, not the scan.
  reads.length = 0;
  view.setPositionalAttribute(1000 + filler[7], 5, '#20');
  assert.equal(describe(counted, filler[7], view), 'A: Qto_Own,Qto_Related');
  assertReadIds(fillerReads(), [1000 + filler[7]], 'an edit re-reads only the record it touched');
});

test('#9192 walking every element reads each relationship once, however many members it names', async () => {
  const members = Array.from({ length: 300 }, (_, i) => 2000 + i);
  const store = await parse([...BASE, ...members.map(wall), typing(60, `(${members.map(id => `#${id}`).join(',')})`, '#40')]);
  let relationshipReads = 0;
  const counted: IfcDataStore = { ...store, getEntity: id => { if (id === 60) relationshipReads++; return store.getEntity(id); } };
  const view = new MutablePropertyView(null, 'm');
  for (const id of members) assert.equal(describe(counted, id, view), 'B: Qto_B');
  assert.equal(relationshipReads, 1);
});

test('#9192 a relationship the parser recorded no edge for still refuses the whole model', async () => {
  // RelatedObjects and RelatingType unreadable: no edge names anything, so no lookup would ever reach these.
  for (const line of [typing(70, '$', '#20'), typing(70, '(#10)', '$')]) {
    const store = await parse([...BASE, line]);
    const view = new MutablePropertyView(null, 'm');
    assert.deepEqual(describeAll(store, view), ['refused', 'refused', 'refused', 'refused', 'refused'], line);
    assert.deepEqual(describeAll(everyRelationshipRead(store), view), ['refused', 'refused', 'refused', 'refused', 'refused'], line);
  }
});

test('#9192 a malformed relationship the graph does name refuses the elements and types it names', async () => {
  // The byte reader takes #14 from this list, so the graph vouches for the record until a lookup reads it.
  // An empty member is the one unreadable value it lets through: it can never be a reference.
  const store = await parse([...BASE, typing(70, '(#14,$)', '#20')]);
  const view = new MutablePropertyView(null, 'm');
  assert.equal(describe(store, 14, view), 'refused', 'the named element is not told it has no type');
  assert.equal(describe(store, 10, view), 'A: Qto_Own,Qto_Related', 'an element the record does not name keeps its answer');
});

test('#9192 the row limit still refuses, without reading a relationship and once per revision', async () => {
  const rows = Array.from({ length: 65_537 }, (_, i) => typing(100_000 + i, '(#10)', '#20'));
  const store = await parse([...BASE, ...rows]);
  const reads: number[] = [];
  const counted: IfcDataStore = { ...store, getEntity: id => { reads.push(id); return store.getEntity(id); } };
  const view = new MutablePropertyView(null, 'm');
  const read = readCurrentTypeQuantities(counted, 11, view);
  assert.equal(read.status, 'unavailable');
  assert.match(read.reason ?? '', /exceeds the read limit/);
  assertReadIds(reads, [], 'the row limit refuses without reading a relationship');

  // Not re-derived for the next element: on a large model that walk ran on every click.
  let rowsWalked = 0;
  const isDeleted = view.isDeleted.bind(view);
  view.isDeleted = id => { rowsWalked++; return isDeleted(id); };
  assert.equal(readCurrentTypeQuantities(counted, 12, view).status, 'unavailable');
  assert.equal(rowsWalked, 1, 'only the asked element is checked');

  view.setPositionalAttribute(100_000, 4, ['#11']);
  rowsWalked = 0;
  assert.equal(readCurrentTypeQuantities(counted, 12, view).status, 'unavailable', 'the limit still holds at the next revision');
  assert.ok(rowsWalked > 65_536, `a new revision walks the rows again (walked ${rowsWalked})`);
});

test('#9192 the reference budget counts only what a read of each relationship counts', async () => {
  // 600 objects, each given 600 definitions by one relationship: 360,000 references written, past the
  // 262,144 budget. A definition set counts only its effective property-definition members (#7681), so
  // the answer turns on what those 600 are, which the graph's edge count alone cannot tell.
  const objects = Array.from({ length: 600 }, (_, i) => 3000 + i);
  const definitions = Array.from({ length: 600 }, (_, i) => 5000 + i);
  const relationship = (named: number[]) => `#90=IFCRELDEFINESBYPROPERTIES('${gid(90)}',$,$,$,(${objects.map(id => `#${id}`).join(',')}),(${named.map(id => `#${id}`).join(',')}));`;
  const read = (store: IfcDataStore, view: MutablePropertyView) => [describe(store, 10, view), describe(everyRelationshipRead(store), 10, view)];

  const walls = await parse([...BASE, ...objects.map(wall), ...definitions.map(wall), relationship(definitions)]);
  assert.deepEqual(read(walls, new MutablePropertyView(null, 'm')), ['A: Qto_Own,Qto_Related', 'A: Qto_Own,Qto_Related'],
    'a set naming walls holds no definition, so it adds no reference');

  const psets = await parse([...BASE, ...objects.map(wall), ...definitions.map(id => `#${id}=IFCPROPERTYSET('${gid(id)}',$,'P${id}',$,());`), relationship(definitions)]);
  assert.deepEqual(read(psets, new MutablePropertyView(null, 'm')), ['refused', 'refused'], 'a set of 600 definitions does');
  const fewer = new MutablePropertyView(null, 'm');
  for (const id of definitions.slice(0, 200)) fewer.deleteEntity(id);
  assert.deepEqual(read(psets, fewer), ['A: Qto_Own,Qto_Related', 'A: Qto_Own,Qto_Related'],
    'with 200 definitions deleted, 600 x 400 references fit the budget again');
  const retyped = new MutablePropertyView(null, 'm');
  for (const id of definitions.slice(0, 200)) retyped.setEntityType(id, 'IfcWall');
  assert.deepEqual(read(psets, retyped), ['A: Qto_Own,Qto_Related', 'A: Qto_Own,Qto_Related'], 'and with 200 of them retyped away');
});

test('#9192 a refusal holds for the edit revision, like an answer', async () => {
  // #70 names #14 next to an unreadable value; type #46's only quantity has no value.
  const store = await parse([...BASE, typing(70, '(#14,$)', '#20'), wall(15), wall(16),
    `#46=IFCWALLTYPE('${gid(46)}',$,'Bad',$,$,(#45),$,$,$,.STANDARD.);`,
    `#45=IFCELEMENTQUANTITY('${gid(45)}',$,'Qto_Bad',$,$,(#47));`, "#47=IFCQUANTITYLENGTH('L',$,$,$,$);",
    typing(48, '(#15,#16)', '#46')]);
  const view = new MutablePropertyView(null, 'm');
  // Every record read goes through the view's deletion check first, so it counts read attempts.
  const attempts = new Map<number, number>();
  const isDeleted = view.isDeleted.bind(view);
  view.isDeleted = id => { attempts.set(id, (attempts.get(id) ?? 0) + 1); return isDeleted(id); };
  const seen = (id: number) => attempts.get(id) ?? 0;

  assert.equal(describe(store, 14, view), 'refused');
  const relationship = seen(70);
  assert.ok(relationship > 0, 'the first selection reads #70');
  assert.equal(describe(store, 14, view), 'refused');
  assert.equal(seen(70), relationship, 'selecting #14 again reads #70 no more');

  assert.equal(describe(store, 15, view), 'refused');
  const quantity = seen(47);
  assert.ok(quantity > 0, 'the first element of the type reads its quantity');
  assert.equal(describe(store, 16, view), 'refused');
  assert.equal(seen(47), quantity, 'the next element of the same type reads it no more');

  view.setPositionalAttribute(48, 4, ['#15', '#16']);
  assert.equal(describe(store, 16, view), 'refused');
  assert.ok(seen(47) > quantity, 'a new revision reads again');
});

test('#9192 a definition relationship an edit over-counts is read only when it decides the budget', async () => {
  const objects = Array.from({ length: 600 }, (_, i) => 3000 + i);
  const psets = Array.from({ length: 600 }, (_, i) => 5000 + i);
  const relationship = (members: number[]) => `#90=IFCRELDEFINESBYPROPERTIES('${gid(90)}',$,$,$,(${members.map(id => `#${id}`).join(',')}),(${psets.map(id => `#${id}`).join(',')}));`;
  const model = (members: number[]) => parse([...BASE, ...objects.map(wall), ...psets.map(id => `#${id}=IFCPROPERTYSET('${gid(id)}',$,'P${id}',$,());`), relationship(members)]);
  const readsOf90 = (store: IfcDataStore, view: MutablePropertyView) => {
    let reads = 0;
    const counted: IfcDataStore = { ...store, getEntity: id => { if (id === 90) reads++; return store.getEntity(id); } };
    return { answer: describe(counted, 10, view), reads };
  };
  const deleting = (count: number) => { const view = new MutablePropertyView(null, 'm'); for (const id of psets.slice(0, count)) view.deleteEntity(id); return view; };

  // 60 x 600 = 36,000 references with one definition deleted: inside the budget whatever the read
  // counts, and #90 names neither #10 nor its type, so selecting #10 does not read it.
  assert.deepEqual(readsOf90(await model(objects.slice(0, 60)), deleting(1)), { answer: 'A: Qto_Own,Qto_Related', reads: 0 });
  // 600 x 600 with 200 deleted: the bound (360,000) crosses the budget, so #90 is read, and 600 x 400 fits.
  assert.deepEqual(readsOf90(await model(objects), deleting(200)), { answer: 'A: Qto_Own,Qto_Related', reads: 1 });
});

test('#9192 the budget fallback for a view that cannot list its deletions', async () => {
  // Without getTombstones, a deleted definition cannot be found through the graph, so every
  // definition relationship is counted as a read counts it.
  const objects = Array.from({ length: 600 }, (_, i) => 3000 + i);
  const psets = Array.from({ length: 600 }, (_, i) => 5000 + i);
  const store = await parse([...BASE, ...objects.map(wall), ...psets.map(id => `#${id}=IFCPROPERTYSET('${gid(id)}',$,'P${id}',$,());`),
    `#90=IFCRELDEFINESBYPROPERTIES('${gid(90)}',$,$,$,(${objects.map(id => `#${id}`).join(',')}),(${psets.map(id => `#${id}`).join(',')}));`]);
  const view = new MutablePropertyView(null, 'm');
  for (const id of psets.slice(0, 200)) view.deleteEntity(id);
  const withoutTombstones = Object.assign(Object.create(view) as MutablePropertyView, { getTombstones: undefined });
  assert.equal(describe(store, 10, withoutTombstones), 'A: Qto_Own,Qto_Related', '600 x 400 references fit the budget');
  assert.equal(describe(everyRelationshipRead(store), 10, withoutTombstones), 'A: Qto_Own,Qto_Related');
});

/**
 * Records the byte reader cannot read cleanly: it records no edge for them (#9192), so they are read
 * up front like any record without edges. Before, it read part of each, and the graph answered
 * elements differently from a read of every relationship, depending on which was asked first.
 */
const MISREAD: string[] = [
  // A nested or typed value stopped the list early and shifted the rest into the relating slot.
  typing(5, '((#10),#14)', '#40'),
  typing(5, "(#10,IFCLABEL('x'),#14)", '#40'),
  `#5=IFCRELDEFINESBYPROPERTIES('${gid(5)}',$,$,$,((#10),#20),#24);`,
  // The shifted value has the right class, so it looked like a regular edge: asked first, #11 was
  // answered from its other relationship, and #13's type was missing Qto_Related.
  typing(5, '((#10),#40,#11)', '#20'),
  `#5=IFCRELDEFINESBYPROPERTIES('${gid(5)}',$,$,$,((#20),#21,#40),#24);`,
  // RelatedObjects without its parentheses: #11 was read as the type.
  typing(5, '#10,#11', '#40'),
  // A relating value naming two entities: the edge came from #40 alone.
  typing(5, '(#10,#11)', '(#40,#41)'),
  // Members the decoder reads differently: without a comma it takes #10 only; a number and a
  // '#id' string it takes as references, which the byte reader skipped.
  typing(5, '(#10 #11)', '#40'),
  typing(5, '(#10,14)', '#40'),
  typing(5, "(#10,'#14')", '#40'),
];

test('#9192 a record the byte reader cannot read cleanly gets the answers a read of every relationship gives, whichever element is asked first', async () => {
  for (const line of MISREAD) {
    const store = await parse([line, ...BASE]);
    const expected = describeAll(everyRelationshipRead(store), new MutablePropertyView(null, 'm'));
    for (const first of ELEMENTS) {
      const view = new MutablePropertyView(null, 'm');
      const asked = describe(store, first, view);
      assert.equal(asked, expected[ELEMENTS.indexOf(first)], `${line}: #${first} asked first`);
      assert.deepEqual(describeAll(store, view), expected, `${line}: after #${first}`);
    }
  }
});

test('#9192 the misread records the reader caught before refuse the model, whichever element is asked first', async () => {
  for (const line of MISREAD.slice(0, 7)) {
    const store = await parse([line, ...BASE]);
    for (const first of ELEMENTS) {
      const view = new MutablePropertyView(null, 'm');
      assert.equal(describe(store, first, view), 'refused', `${line}: #${first} asked first`);
    }
  }
});

test('#9192 a well-formed record naming the wrong class gets the answers a read of every relationship gives', async () => {
  // The graph used to mark these for an up-front read; the byte reader now leaves misread records
  // without edges, so these are vouched for like any other and read on lookup, with the same answers.
  for (const line of [typing(5, '(#11)', '#14'), typing(5, '(#11,#12)', '#99'), `#5=IFCRELDEFINESBYPROPERTIES('${gid(5)}',$,$,$,(#20),#14);`]) {
    const store = await parse([line, ...BASE]);
    const expected = describeAll(everyRelationshipRead(store), new MutablePropertyView(null, 'm'));
    for (const first of ELEMENTS) {
      const view = new MutablePropertyView(null, 'm');
      assert.equal(describe(store, first, view), expected[ELEMENTS.indexOf(first)], `${line}: #${first} asked first`);
      assert.deepEqual(describeAll(store, view), expected, `${line}: after #${first}`);
    }
  }
});

test('#9192 a definition set is read whichever way it is spelled', async () => {
  for (const set of ['(#41,#42)', 'IFCPROPERTYSETDEFINITIONSET((#41,#42))']) {
    const lines = BASE.map(line => line.startsWith('#37=') ? `#37=IFCRELDEFINESBYPROPERTIES('${gid(37)}',$,$,$,(#40),${set});` : line);
    const store = await parse(lines);
    assert.equal(store.relationships.getRelated(40, RelationshipType.DefinesByProperties, 'inverse').length, 2, set);
    assert.deepEqual(describeAll(store, new MutablePropertyView(null, 'm')), CLEAN, set);
  }
});

test('#9192 a read of the store emitted before the definition edges exist still finds them', async () => {
  let early: IfcDataStore | undefined;
  const store = await new IfcParser().parseColumnar(bytesOf(BASE), { disableWorkerScan: true, onSpatialReady: value => { early = value; } });
  assert.ok(early);
  assert.equal(early.relationships.getRelated(20, RelationshipType.DefinesByProperties, 'inverse').length, 0,
    'this store really has no definition edges yet');
  const view = new MutablePropertyView(null, 'm');
  assert.deepEqual(describeAll(early, view), CLEAN);
  assert.deepEqual(describeAll(store, view), CLEAN);
});

test('#9192 the read is the same once the source is block-compressed', async () => {
  const store = await parse(BASE);
  const transfer = store.source.toTransferable();
  assert.equal(transfer.kind, 'contiguous');
  if (transfer.kind !== 'contiguous') return;
  assert.equal(compressSourceInPlace(store.source, compressSource(transfer.bytes)), true);
  assert.equal(store.source.isResident, false);
  const view = new MutablePropertyView(null, 'm');
  view.setPositionalAttribute(36, 4, ['#40']);
  assert.deepEqual(describeAll(store, view), ['A: Qto_Own', 'A: Qto_Own', 'B: Qto_Related,Qto_B', 'B: Qto_Related,Qto_B', 'none']);
});

test('#9192 the panel shows each model its own inherited quantities at models.size 1 and N', async () => {
  // The same express ids in both models, with different quantity sets on the type.
  const second = await parse(BASE.map(line => line.replace("'Qto_Own'", "'Qto_Second'")));
  const first = await parse(BASE);
  const seed = (...entries: Array<[string, IfcDataStore]>) => useViewerStore.setState({
    models: new Map(entries.map(([id, ifcDataStore], at) => [id, { ...fixtureModel(id, { idOffset: at * 100_000 }), ifcDataStore }])),
    activeModelId: entries[0][0], ifcDataStore: entries[0][1], mutationViews: new Map(), storeEditors: new Map(), propertiesActiveTab: 'quantities', unitDisplayOverrides: {},
  });
  const panelFor = (modelId: string, expressId: number) => {
    useViewerStore.setState({ selectedEntity: { modelId, expressId }, selectedEntityId: expressId });
    const text = render(<PropertiesPanel />).textContent ?? '';
    cleanup();
    return text;
  };

  seed(['a', first]);
  assert.match(panelFor('a', 10), /Qto_Own/);

  seed(['a', first], ['b', second]);
  assert.match(panelFor('a', 10), /Qto_Own/);
  const inB = panelFor('b', 10);
  assert.match(inB, /Qto_Second/);
  assert.doesNotMatch(inB, /Qto_Own/);

  // An edit in one model moves only that model's answer.
  const viewOfA = getOrCreateMutationView(useViewerStore, 'a'); assert.ok(viewOfA);
  viewOfA.setPositionalAttribute(30, 5, '#40');
  useViewerStore.setState(state => ({ mutationVersion: state.mutationVersion + 1 }));
  const inA = panelFor('a', 10);
  assert.match(inA, /Qto_B/);
  assert.doesNotMatch(inA, /Qto_Own/);
  assert.match(panelFor('b', 10), /Qto_Second/);
});
