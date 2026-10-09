/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { afterEach, test, type TestContext } from 'node:test';
import { IfcParser, extractTypeQuantitiesOnDemand, extractQuantitiesOnDemand, extractTypePropertiesOnDemand } from '@ifc-lite/parser';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { QuantityType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
const net = (sets: readonly { quantities: readonly { name: string; value: number }[] }[]) => sets.flatMap(set => [...set.quantities]).find(q => q.name === 'NetVolume')?.value;

async function inheritedSource(t: TestContext) {
 const f = await seedDeclaredZoneWall(t); if (!f) return;
 const draft = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(draft);
 const editor = new StoreEditor(f.store, draft);
 const ownerId = f.store.getEntity(f.id)?.attributes[1];
 const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
 // Prepare authentic exported source ownership: keep the real wall/geometry but replace its quantity/type assignments.
 for (const kind of ['IFCRELDEFINESBYPROPERTIES', 'IFCRELDEFINESBYTYPE']) {
  for (const id of f.store.entityIndex.byType.get(kind) ?? []) {
   const attrs = f.store.getEntity(id)?.attributes;
   const members = attrs?.[4];
   if (!Array.isArray(members) || !members.includes(f.id)) continue;
   const others = members.filter(id => id !== f.id);
   if (others.length) draft.setPositionalAttribute(id, 4, others.map(id => `#${id}`)); else draft.deleteEntity(id);
  }
 }
 const makeType = (value: number, name: string) => {
  const volume = editor.addEntity('IfcQuantityVolume', f.store.schemaVersion === 'IFC2X3' ? ['NetVolume', null, null, value] : ['NetVolume', null, null, value, null]).expressId;
  const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'Qto_WallBaseQuantities', null, null, [`#${volume}`]]).expressId;
  const type = editor.addEntity('IfcWallType', [generateIfcGuid(), owner, name, null, null, [`#${qto}`], null, null, null, '.NOTDEFINED.']).expressId;
  return { volume, type, qto };
 };
 const a = makeType(10, 'Native quantity type A'), b = makeType(30, 'Native quantity type B');
 const relation = editor.addEntity('IfcRelDefinesByType', [generateIfcGuid(), owner, null, null, [`#${f.id}`], `#${a.type}`]).expressId;
 const store = await parse(editedModelBytes(f.store, draft));
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10);
 const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
 useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: store }]]), ifcDataStore: store, mutationViews: new Map(), storeEditors: new Map() });
 const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
 return { f, store, a, b, relation, view };
}


for (const kind of ['type-default-history', 'occurrence-default-history', 'occurrence-skip-history'] as const) {
 test(`#7355 native writer ${kind} separates supported ownership from unchanged skipHistory export semantics`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, a } = fixture;
  let source = store;
  if (kind !== 'type-default-history') {
   fixture.view.createQuantitySet(f.id, 'Native occurrence quantities', [{ name: 'NetVolume', value: 15, quantityType: QuantityType.Volume }]);
   source = await parse(editedModelBytes(store, fixture.view));
   assert.equal(net(extractQuantitiesOnDemand(source, f.id)), 15);
   const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
   useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source,
    mutationViews: new Map(), storeEditors: new Map() });
  }
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  const before = editedModelBytes(source, view);
  const target = kind === 'type-default-history' ? a.type : f.id;
  const name = kind === 'type-default-history' ? 'Qto_WallBaseQuantities' : 'Native occurrence quantities';
  const skipHistory = kind === 'occurrence-skip-history';
  const historyBefore = view.getMutations().length;
  view.setQuantity(target, name, 'NetVolume', 35, QuantityType.Volume, undefined, skipHistory);
  assert.equal(net(view.getQuantitiesForEntity(target)), 35, 'the real overlay contains the requested write');
  assert.equal(view.getMutations().length - historyBefore, skipHistory ? 0 : 1, 'true means skipHistory');
  const bytes = editedModelBytes(source, view);
  const exported = await parse(bytes);
  const sets = kind === 'type-default-history' ? extractTypeQuantitiesOnDemand(exported, f.id)?.quantities ?? []
   : extractQuantitiesOnDemand(exported, f.id);
  console.log('NATIVE_WRITER_7355', JSON.stringify({ kind, target, skipHistory, historyDelta: view.getMutations().length - historyBefore,
   nativeQuantity: net(sets), nativeSets: sets }));
  if (process.env.CAMPAIGN_WRITER_EXPORT_PREFIX) {
   await writeFile(`${process.env.CAMPAIGN_WRITER_EXPORT_PREFIX}-${kind}.before.ifc`, before);
   await writeFile(`${process.env.CAMPAIGN_WRITER_EXPORT_PREFIX}-${kind}.ifc`, bytes);
  }
  if (skipHistory) {
   assert.equal(net(sets), 15, 'generic occurrence skipHistory export nomination is separately diagnosed and remains outside #7355');
   await assertSameNativeIfcGraph(bytes, before, 'this separate nomination omission retains its original native graph');
  } else {
   assert.equal(net(sets), 35, 'independent native export/reparse must retain the supported write');
  }
  if (kind === 'type-default-history') {
   const owned = exported.getEntity(a.type)?.attributes[5]; assert.ok(Array.isArray(owned));
   assert.ok(owned.some(id => exported.getEntity(id)?.type === 'IFCELEMENTQUANTITY'), 'the saved quantity belongs to HasPropertySets');
   for (const id of exported.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
    const members = exported.getEntity(id)?.attributes[4];
    assert.ok(!Array.isArray(members) || !members.includes(a.type), 'IfcRelDefinesByProperties cannot relate a type object');
   }
   const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
   useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: exported }]]), ifcDataStore: exported,
    mutationViews: new Map(), storeEditors: new Map() });
   const panel = render(<PropertiesPanel />);
   assert.match(panel.textContent ?? '', /netNetVolume35 m³/, 'mounted native saved card agrees with the exported type quantity');
  }
 });
}

for (const alsoEditProperty of [false, true]) {
test(alsoEditProperty
 ? '#7355 simultaneous same-named property and quantity edits retain both native type definitions and shared owners'
 : '#7355 shared native type quantity copy retains units Formula opaque atoms and unrelated full graph', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, a, b, view } = fixture;
 const editor = new StoreEditor(store, view);
 const owner = store.getEntity(a.type)?.attributes[1];
 const volumeUnit = (store.entityIndex.byType.get('IFCSIUNIT') ?? []).find(id =>
  String(store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'VOLUMEUNIT'); assert.ok(volumeUnit);
 view.setPositionalAttribute(a.volume, 1, 'Exact source description');
 view.setPositionalAttribute(a.volume, 2, `#${volumeUnit}`);
 view.setPositionalAttribute(a.volume, 4, 'Exact source formula');
 const child = editor.addEntity('IfcQuantityVolume', ['Opaque child', 'Child description', `#${volumeUnit}`, 12, 'Child formula']).expressId;
 const complex = editor.addEntity('IfcPhysicalComplexQuantity', ['Opaque quantity', 'Opaque description', [`#${child}`], 'Native grouping', 'Exact quality', 'Exact usage']).expressId;
 view.setPositionalAttribute(a.qto, 3, 'Exact source set description');
 view.setPositionalAttribute(a.qto, 4, 'Exact source measurement method');
 view.setPositionalAttribute(a.qto, 5, [`#${a.volume}`, `#${complex}`]);
 const property = editor.addEntity('IfcPropertySingleValue', ['Unrelated property', null, { typed: 'IFCTEXT', value: 'Retain exact source value' }, null]).expressId;
 const pset = editor.addEntity('IfcPropertySet', [generateIfcGuid(), typeof owner === 'number' ? `#${owner}` : null,
  'Qto_WallBaseQuantities', 'Same name as the quantity set', [`#${property}`]]).expressId;
 view.setPositionalAttribute(a.type, 5, [`#${pset}`, `#${a.qto}`]);
 view.setPositionalAttribute(b.type, 5, [`#${b.qto}`, `#${a.qto}`, `#${pset}`]);
 const sourceBytes = editedModelBytes(store, view);
 const source = await parse(sourceBytes);
 const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
 useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source,
  mutationViews: new Map(), storeEditors: new Map() });
 const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
 current.setQuantity(a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
 if (alsoEditProperty) current.setProperty(a.type, 'Qto_WallBaseQuantities', 'Unrelated property', 'Edited native property');
 const bytes = editedModelBytes(source, current);
 const exported = await parse(bytes);
 assert.equal(net(extractTypeQuantitiesOnDemand(exported, f.id)?.quantities ?? []), 35);
 const owned = exported.getEntity(a.type)?.attributes[5]; assert.ok(Array.isArray(owned));
 const propertySets = owned.filter(id => exported.getEntity(id)?.type === 'IFCPROPERTYSET');
 assert.equal(propertySets.length, 1, 'same-named property and quantity sets remain different native classes');
 if (alsoEditProperty) {
  assert.ok(!owned.includes(pset), 'edited property set is also copied away from its shared owner');
  const properties = extractTypePropertiesOnDemand(exported, f.id)?.properties ?? [];
  const values = properties.filter(set => set.name === 'Qto_WallBaseQuantities')
   .flatMap(set => set.properties.filter(item => item.name === 'Unrelated property').map(item => item.value));
  assert.deepEqual(values, ['Edited native property'], 'saved/reparsed type exposes the property edit beside quantity35');
 } else assert.ok(owned.includes(pset), 'same-named native property set keeps its original ownership');
 assert.ok(!owned.includes(a.qto), 'only the edited type leaves the shared quantity set');
 const quantitySets = owned.filter(id => exported.getEntity(id)?.type === 'IFCELEMENTQUANTITY');
 assert.equal(quantitySets.length, 1, 'the same export retains exactly one current quantity definition');
 const replacementId = quantitySets[0]; assert.ok(replacementId);
 const replacement = exported.getEntity(replacementId); assert.ok(replacement);
 assert.equal(replacement.attributes[3], 'Exact source set description');
 assert.equal(replacement.attributes[4], 'Exact source measurement method');
 const members = replacement.attributes[5]; assert.ok(Array.isArray(members));
 assert.ok(members.includes(complex), 'opaque physical quantity retains its source atom identity');
 const volumeId = members.find(id => exported.getEntity(id)?.attributes[0] === 'NetVolume'); assert.ok(volumeId);
 const edited = exported.getEntity(volumeId); assert.ok(edited);
 assert.deepEqual(edited.attributes, ['NetVolume', 'Exact source description', volumeUnit, 35, 'Exact source formula']);
 assert.deepEqual(exported.getEntity(b.type)?.attributes, source.getEntity(b.type)?.attributes,
  'the other type retains the original shared set and its unrelated quantity');
 // @raw-entity-enumeration-ok compare every original native graph record; the edited type's HasPropertySets is the only changed original slot.
 for (const id of source.entityIndex.byId.keys()) {
  const before = source.getEntity(id), after = exported.getEntity(id); assert.ok(before); assert.ok(after);
  assert.equal(after.type, before.type);
  if (id === a.type) {
   const attrs = [...after.attributes]; attrs[5] = before.attributes[5];
   assert.deepEqual(attrs, before.attributes);
  } else assert.deepEqual(after.attributes, before.attributes, `unrelated native source #${id} changed`);
 }
 if (process.env.CAMPAIGN_WRITER_EXPORT_PREFIX) {
  await writeFile(`${process.env.CAMPAIGN_WRITER_EXPORT_PREFIX}-${alsoEditProperty ? 'combined-native' : 'shared-native'}.before.ifc`, sourceBytes);
  await writeFile(`${process.env.CAMPAIGN_WRITER_EXPORT_PREFIX}-${alsoEditProperty ? 'combined-native' : 'shared-native'}.ifc`, bytes);
 }
});
}

test('#7355 native pending type quantity edit uses HasPropertySets without a source-owned type record', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { store, view } = fixture;
 const editor = new StoreEditor(store, view);
 const quantity = editor.addEntity('IfcQuantityVolume', ['NetVolume', 'Pending native metadata', null, 45, 'Pending native formula']).expressId;
 const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), null, 'Pending type quantities', null, 'Native method', [`#${quantity}`]]).expressId;
 const type = editor.addEntity('IfcWallType', [generateIfcGuid(), null, 'Pending native type', null, null, [`#${qto}`], null, null, null, '.NOTDEFINED.']).expressId;
 view.setQuantity(type, 'Pending type quantities', 'NetVolume', 55, QuantityType.Volume);
 const exported = await parse(editedModelBytes(store, view));
 const owned = exported.getEntity(type)?.attributes[5]; assert.ok(Array.isArray(owned));
 const currentQto = owned.find(id => exported.getEntity(id)?.type === 'IFCELEMENTQUANTITY'); assert.ok(currentQto);
 const members = exported.getEntity(currentQto)?.attributes[5]; assert.ok(Array.isArray(members));
 const currentVolume = members.find(id => exported.getEntity(id)?.type === 'IFCQUANTITYVOLUME'); assert.ok(currentVolume);
 assert.deepEqual(exported.getEntity(currentVolume)?.attributes, ['NetVolume', 'Pending native metadata', null, 55, 'Pending native formula']);
 assert.equal(exported.getEntity(currentQto)?.attributes[4], 'Native method');
 for (const id of exported.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
  const members = exported.getEntity(id)?.attributes[4];
  assert.ok(!Array.isArray(members) || !members.includes(type), 'pending type ownership also excludes invalid occurrence relationships');
 }
});

test('#7355 installed type quantity base preserves native Undo graph and Redo value', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, a } = fixture;
 const current = new MutablePropertyView(store.properties, 'arch');
 const before = editedModelBytes(store, current);
 current.setQuantity(a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
 assert.equal(net(extractTypeQuantitiesOnDemand(await parse(editedModelBytes(store, current)), f.id)?.quantities ?? []), 35);
 current.removeQuantityMutation(a.type, 'Qto_WallBaseQuantities', 'NetVolume');
 await assertSameNativeIfcGraph(editedModelBytes(store, current), before,
  'an undone type quantity edit cannot replace or delete a source definition');
 current.setQuantity(a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
 assert.equal(net(extractTypeQuantitiesOnDemand(await parse(editedModelBytes(store, current)), f.id)?.quantities ?? []), 35);
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10, 'source-only data remains the original native snapshot');
});

test('#7355 current native HasPropertySets reassignment preserves the other shared owner', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, a, b, view } = fixture;
 view.setPositionalAttribute(a.type, 5, [`#${b.qto}`]);
 view.setQuantity(a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
 const exported = await parse(editedModelBytes(store, view));
 assert.equal(net(extractTypeQuantitiesOnDemand(exported, f.id)?.quantities ?? []), 35);
 assert.deepEqual(exported.getEntity(b.type)?.attributes, store.getEntity(b.type)?.attributes);
 assert.deepEqual(exported.getEntity(b.qto)?.attributes, store.getEntity(b.qto)?.attributes,
  'the other current owner retains the original shared definition');
 assert.deepEqual(exported.getEntity(b.volume)?.attributes, store.getEntity(b.volume)?.attributes);
 const owned = exported.getEntity(a.type)?.attributes[5]; assert.ok(Array.isArray(owned));
 assert.ok(!owned.includes(a.qto) && !owned.includes(b.qto), 'current type ownership is replaced from its native effective list');
});
