/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { afterEach, test, type TestContext } from 'node:test';
import { IfcParser, extractProjectUnits, extractTypeQuantitiesOnDemand, extractQuantitiesOnDemand, readCurrentTypeQuantities, type IfcDataStore } from '@ifc-lite/parser';
import { IfcQuery } from '@ifc-lite/query';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { RelationshipType, QuantityType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { effectiveElementData } from '@/components/viewer/properties/effectiveElementData';
import { withInheritedTypeQuantities } from '@/lib/zones/inherited-quantities';
import { ZoneVolumeBreakdown } from '@/components/viewer/ZoneVolumeBreakdown';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';

const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
const net = (sets: readonly { quantities: readonly { name: string; value: number }[] }[]) => sets.flatMap(set => [...set.quantities]).find(q => q.name === 'NetVolume')?.value;
const native = async (store: IfcDataStore, view: MutablePropertyView, id: number) => net(extractTypeQuantitiesOnDemand(await parse(editedModelBytes(store, view)), id)?.quantities ?? []);

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
 test(`#7355 native writer ${kind} preserves the requested quantity in export`, async t => {
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
  assert.equal(net(sets), 35, 'independent native export/reparse must retain the supported write');
 });
}
