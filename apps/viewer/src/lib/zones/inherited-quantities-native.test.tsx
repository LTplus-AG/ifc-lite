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

test('#7353 canonical inherited quantity card follows native edits and type reassignment', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, a, b, relation, view } = fixture;
 const read = () => {
  const own = effectiveElementData(f.id, new IfcQuery(store), view).qsets;
  assert.equal(own.length, 0, 'source preparation leaves type-only quantities');
  const canonical = withInheritedTypeQuantities(own, store, f.id, RelationshipType.DefinesByType, (s, id) => extractTypeQuantitiesOnDemand(s as IfcDataStore, id, view)?.quantities);
  return { canonical };
 };
 assert.equal(net(read().canonical), 10);
 view.setPositionalAttribute(a.volume, 3, 20);
 assert.equal(await native(store, view, f.id), 20, 'independent export/reparse sees current type quantity edit');
 let result = read();
 const editedQuantity = net(result.canonical);
 const ui = render(<ZoneVolumeBreakdown zoneSet={f.zoneSet} globalId={f.id} quantitySets={result.canonical} projectUnits={extractProjectUnits(store.source, store.entityIndex)} unitDisplayOverrides={{}} />);
 assert.ok(ui.textContent?.includes('net'), 'mount actual native Properties card on its canonical quantity input');
 console.log('NATIVE_TYPE_QUANTITY_EDIT', JSON.stringify({ native: 20, canonicalCardInput: net(result.canonical), cardText: ui.textContent })); cleanup();
 const panel = render(<PropertiesPanel />);
 assert.match(panel.textContent ?? '', /netNetVolume20 m³/, 'actual Properties panel passes the current native view to its inherited quantity card');
 cleanup();
 view.setPositionalAttribute(relation, 5, `#${b.type}`);
 assert.equal(await native(store, view, f.id), 30, 'independent export/reparse follows the new native type');
 result = read(); const reassignedQuantity = net(result.canonical);
 assert.deepEqual({ editedQuantity, reassignedQuantity }, { editedQuantity: 20, reassignedQuantity: 30 }, 'canonical card must agree with both independently reparsed native exports');
 console.log('TYPE_REASSIGN', JSON.stringify({ native: 30, canonicalCardInput: net(result.canonical) }));
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10, 'source-only API retains the original native snapshot');
 const journalBefore = editedModelBytes(store, view);
 if (process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT) await writeFile(process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT + '.before.ifc', journalBefore);
 const revision = view.getMutationRevision();
 const beforeRead = useViewerStore.getState().mutationVersion;
 view.setQuantity(b.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume, undefined, true);
 assert.ok(view.getMutationRevision() > revision);
 assert.equal(useViewerStore.getState().mutationVersion, beforeRead, 'direct native edits need not publish a viewer notification');
 const journalExport = editedModelBytes(store, view);
 const journalStore = await parse(journalExport);
 const nativeSets = extractTypeQuantitiesOnDemand(journalStore, f.id)?.quantities ?? [];
 console.log('NATIVE_TYPE_JOURNAL_INVENTORY', JSON.stringify(nativeSets));
 if (process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT) await writeFile(process.env.CAMPAIGN_TYPE_JOURNAL_EXPORT, journalExport);
 await assertSameNativeIfcGraph(journalExport, journalBefore, 'the current native writer ignores this type-owned quantity journal write (#7355 counterexample)');
 assert.equal(net(nativeSets), 30, 'native HasPropertySets remains first after a type quantity journal write');
 const source = store.source.materialize().slice();
 const readRevision = view.getMutationRevision();
 const readJournal = view.getMutations();
 assert.equal(net(read().canonical), 30, 'canonical reader must retain independently reparsed native basis precedence');
 assert.equal(view.getMutationRevision(), readRevision, 'current extraction remains read-only');
 assert.deepEqual(view.getMutations(), readJournal, 'current extraction preserves native journal');
 assert.deepEqual(store.source.materialize(), source, 'current extraction preserves source bytes');
 useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
 const deletedView = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(deletedView);
 deletedView.deleteEntity(a.volume);
 assert.equal(await native(store, deletedView, f.id), undefined, 'native export drops an empty type quantity set');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, deletedView)?.quantities ?? []), undefined, 'deleted native quantities cannot be resurrected');
 useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
 const detachedView = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(detachedView);
 detachedView.deleteEntity(relation);
 assert.equal(await native(store, detachedView, f.id), undefined, 'native export has no type after relationship deletion');
 assert.equal(extractTypeQuantitiesOnDemand(store, f.id, detachedView), null, 'deleted type assignments cannot be resurrected');
 const independentView = new MutablePropertyView(store.properties, 'independent-native-model');
 independentView.setAttribute(a.volume, 'VolumeValue', '70');
 assert.equal(await native(store, independentView, f.id), 70, 'independent native model view exports its named edit');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, independentView)?.quantities ?? []), 70, 'shared source does not share another view quantity cache');
 independentView.setPositionalAttribute(a.volume, 3, 80);
 assert.equal(await native(store, independentView, f.id), 80);
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, independentView)?.quantities ?? []), 80, 'positional precedence and direct revision invalidate the memo');
 assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id, view)?.quantities ?? []), 30, 'the original model view retains its current native basis');



});


for (const kind of ['oversized', 'unsupported', 'malformed-value', 'negative-volume'] as const) {
 test(`#7353 ${kind} native type quantities preserve own bases with explicit unavailable coverage`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, a, view } = fixture;
  if (kind === 'oversized') {
   const editor = new StoreEditor(store, view);
   const ids = Array.from({ length: 4_097 }, (_, i) => editor.addEntity('IfcQuantityVolume',
    store.schemaVersion === 'IFC2X3' ? [`NativeVolume${i}`, null, null, i + 1] : [`NativeVolume${i}`, null, null, i + 1, null]).expressId);
   view.setPositionalAttribute(a.qto, 5, ids.map(id => `#${id}`));
  } else if (kind === 'unsupported') {
   view.setEntityType(a.volume, 'IfcPhysicalComplexQuantity');
   view.setPositionalAttribute(a.volume, 2, [`#${fixture.b.volume}`]);
   view.setPositionalAttribute(a.volume, 3, 'Native grouped quantity');
  } else {
   view.setPositionalAttribute(a.volume, 3, kind === 'negative-volume' ? -1 : null);
  }
  view.createQuantitySet(f.id, 'Native occurrence quantities', [{ name: 'NetVolume', value: 25, quantityType: QuantityType.Volume }]);
  const exported = await parse(editedModelBytes(store, view));
  assert.equal(net(extractQuantitiesOnDemand(exported, f.id)), 25, 'independent native export retains the occurrence basis');
  if (kind === 'oversized') assert.equal(extractTypeQuantitiesOnDemand(exported, f.id)?.quantities[0]?.quantities.length, 4_097, 'actual native input exceeds the current bounded member inventory');
  if (kind === 'unsupported') assert.equal(exported.getEntity(a.volume)?.type.toUpperCase(), 'IFCPHYSICALCOMPLEXQUANTITY');
  if (kind === 'malformed-value') assert.equal(exported.getEntity(a.volume)?.attributes[3], null);
  if (kind === 'negative-volume') assert.equal(exported.getEntity(a.volume)?.attributes[3], -1);
  const revision = view.getMutationRevision();
  const result = readCurrentTypeQuantities(store, f.id, view);
  assert.equal(result.status, 'unavailable'); assert.equal(result.value, null);
  assert.ok(result.reason, 'unavailable coverage has an explicit reason');
  assert.equal(extractTypeQuantitiesOnDemand(store, f.id, view), null, 'nullable current API does not fall back to original source10');
  assert.equal(net(extractTypeQuantitiesOnDemand(store, f.id)?.quantities ?? []), 10, 'source-only control remains the original snapshot');
  const panel = render(<PropertiesPanel />);
  assert.match(panel.textContent ?? '', /Inherited type quantities are unavailable/);
  assert.match(panel.textContent ?? '', /netNetVolume25 m³/, 'unknown inherited coverage preserves the known native occurrence basis');
  assert.doesNotMatch(panel.textContent ?? '', /netNetVolume10 m³/, 'current refusal must not resurrect the source type basis');
  assert.equal(view.getMutationRevision(), revision, 'refused current capture and mounted card remain read-only');
 });
}

// #7353: the quantity's explicit Unit is a current native dependency too.
test('#7353 current inherited quantity explicit Unit scale agrees with native export', async t => {
 const fixture = await inheritedSource(t); if (!fixture) return;
 const { f, store, a, view } = fixture;
 const unit = new StoreEditor(store, view).addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', null, '.CUBIC_METRE.']).expressId;
 view.setPositionalAttribute(a.volume, 2, `#${unit}`);
 const source = await parse(editedModelBytes(store, view));
 const readScale = (data: IfcDataStore, current?: MutablePropertyView) => extractTypeQuantitiesOnDemand(data, f.id, current)?.quantities
  .flatMap(set => set.quantities).find(q => q.name === 'NetVolume')?.explicitUnitSiScale;
 assert.equal(readScale(source), 1, 'native source declares an explicit cubic-metre unit');
 const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
 useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source,
  mutationViews: new Map(), storeEditors: new Map() });
 const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
 current.setPositionalAttribute(unit, 2, '.MILLI.');
 const exported = await parse(editedModelBytes(source, current));
 const nativeScale = readScale(exported);
 assert.equal(nativeScale, 1e-9, 'independent native export/reparse sees the explicit cubic-millimetre unit');
 const actual = readScale(source, current);
 console.log('NATIVE_TYPE_QUANTITY_UNIT_EDIT', JSON.stringify({ nativeScale, currentScale: actual,
  coverage: readCurrentTypeQuantities(source, f.id, current).status }));
 assert.equal(actual, nativeScale, 'current inherited quantity unit scale must agree with independently reparsed native IFC');
 const created = new StoreEditor(source, current).addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.CENTI.', '.CUBIC_METRE.']).expressId;
 current.setPositionalAttribute(a.volume, 2, `#${created}`);
 const reassigned = readScale(await parse(editedModelBytes(source, current)));
 assert.ok(reassigned !== undefined && Math.abs(reassigned / 1e-6 - 1) <= Number.EPSILON * 2,
  'native cubic-centimetre scale differs from 1e-6 by at most two relative floating-point ulps');
 assert.equal(readScale(source, current), reassigned, 'current quantity Unit reassignment uses that native entity');
 assert.equal(readScale(source), 1, 'source-only unit semantics retain the original snapshot');
});

for (const kind of ['deleted', 'unsupported', 'cyclic', 'oversized'] as const) {
 test(`#7353 ${kind} native quantity Unit dependency refuses unknown coverage without crashing the card`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
  const { f, store, a, view } = fixture;
  const editor = new StoreEditor(store, view);
  const si = () => editor.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', null, '.CUBIC_METRE.']).expressId;
  let unit: number;
  if (kind === 'unsupported') {
   const dimensions = editor.addEntity('IfcDimensionalExponents', [3, 0, 0, 0, 0, 0, 0]).expressId;
   unit = editor.addEntity('IfcContextDependentUnit', [`#${dimensions}`, '.VOLUMEUNIT.', 'Unresolved native volume unit']).expressId;
  } else if (kind === 'deleted') {
   unit = si(); view.deleteEntity(unit);
  } else {
   // The cycle is deliberately malformed. The large graph has supported,
   // schema-shaped length factors: one cubic factor and neutral zero powers.
   unit = editor.addEntity('IfcDerivedUnit', [[], '.USERDEFINED.', 'Native volume']).expressId;
   const component = kind === 'cyclic' ? unit : editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', null, '.METRE.']).expressId;
   const elements = Array.from({ length: kind === 'cyclic' ? 1 : 513 }, (_, index) =>
    editor.addEntity('IfcDerivedUnitElement', [`#${component}`, kind === 'cyclic' ? 1 : index === 0 ? 3 : 0]).expressId);
   view.setPositionalAttribute(unit, 0, elements.map(id => `#${id}`));
  }
  view.setPositionalAttribute(a.volume, 2, `#${unit}`);
  view.createQuantitySet(f.id, 'Native occurrence quantities', [{ name: 'NetVolume', value: 25, quantityType: QuantityType.Volume }]);
  const exported = await parse(editedModelBytes(store, view));
  assert.equal(net(extractQuantitiesOnDemand(exported, f.id)), 25, 'native export preserves the independent known occurrence basis');
  if (kind === 'deleted') assert.equal(exported.entityIndex.byId.has(unit), false, 'native exported unit is deleted');
  else assert.ok(exported.getEntity(unit), 'refusal graph is present in the actual native export');
  if (kind === 'oversized') assert.equal(extractTypeQuantitiesOnDemand(exported, f.id)?.quantities
   .flatMap(set => set.quantities).find(q => q.name === 'NetVolume')?.explicitUnitSiScale, 1,
   'independent source reparse resolves every supported factor before current capture enforces its read cap');
  const revision = view.getMutationRevision();
  const result = readCurrentTypeQuantities(store, f.id, view);
  assert.equal(result.status, 'unavailable'); assert.equal(result.value, null); assert.ok(result.reason);
  if (kind === 'oversized') assert.match(result.reason, /read limit/);
  if (kind === 'cyclic') assert.match(result.reason, /unresolved or unsupported/, 'active cycle refusal precedes work-budget exhaustion or stack overflow');
  assert.equal(extractTypeQuantitiesOnDemand(store, f.id, view), null, 'unknown units cannot use a stale source scale or default SI');
  const panel = render(<PropertiesPanel />);
  assert.match(panel.textContent ?? '', /Inherited type quantities are unavailable/);
  assert.match(panel.textContent ?? '', /netNetVolume25 m³/);
  assert.doesNotMatch(panel.textContent ?? '', /netNetVolume10 m³/);
  assert.equal(view.getMutationRevision(), revision, 'bounded refusal and mounted card are read-only');
 });
}
