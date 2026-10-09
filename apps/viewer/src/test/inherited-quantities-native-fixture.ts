/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { IfcParser, extractProjectUnits, extractQuantitiesOnDemand, extractTypeQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import { QuantityType } from '@ifc-lite/data';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';

export const parse = (bytes: Uint8Array) => new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
export const net = (sets: readonly { quantities: readonly { name: string; value: number }[] }[]) => sets.flatMap(set => [...set.quantities]).find(q => q.name === 'NetVolume')?.value;
export const native = async (store: IfcDataStore, view: MutablePropertyView, id: number) => net(extractTypeQuantitiesOnDemand(await parse(editedModelBytes(store, view)), id)?.quantities ?? []);

export async function inheritedSource(t: TestContext) {
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


// Shared authentic scenario inputs and export/reparse checks; public/UI and API
// status/value/reason assertions remain in their independent test entrypoints.
type NativeQuantityFixture = NonNullable<Awaited<ReturnType<typeof inheritedSource>>>;

export async function prepareExplicitQuantityUnit(fixture: NativeQuantityFixture) {
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
 return { source, current, readScale, nativeScale };
}

export async function prepareQuantityRefusal(fixture: NativeQuantityFixture, kind: 'oversized' | 'unsupported' | 'malformed-value' | 'negative-volume') {
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
}

export async function prepareProjectRefusal(fixture: NativeQuantityFixture, kind: 'unset-context' | 'deleted-project' | 'deleted-assignment' | 'unsupported-unit' | 'empty-assignment' | 'cyclic-unit' | 'oversized-dependencies') {
 const { f, store, a, view } = fixture;
  const project = store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
  const assignment = store.getEntity(project)?.attributes[8]; assert.equal(typeof assignment, 'number');
  const members = store.getEntity(assignment as number)?.attributes[0]; assert.ok(Array.isArray(members));
 const unitIds = members.map(id => { assert.ok(typeof id === 'number'); return id; });
  const editor = new StoreEditor(store, view);
  if (kind === 'unset-context') view.setPositionalAttribute(project, 8, null);
  else if (kind === 'deleted-project') view.deleteEntity(project);
  else if (kind === 'deleted-assignment') view.deleteEntity(assignment as number);
  else if (kind === 'empty-assignment') view.setPositionalAttribute(assignment as number, 0, []);
  else if (kind === 'unsupported-unit') {
   const dimensions = editor.addEntity('IfcDimensionalExponents', [3, 0, 0, 0, 0, 0, 0]).expressId;
   const unit = editor.addEntity('IfcContextDependentUnit', [`#${dimensions}`, '.VOLUMEUNIT.', 'Unknown native volume']).expressId;
   view.setPositionalAttribute(assignment as number, 0, unitIds.map(id =>
    `#${String(store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'VOLUMEUNIT' ? unit : id}`));
  } else if (kind === 'cyclic-unit') {
   // Deliberately malformed file-supplied graph: a derived element cannot name itself.
   const unit = editor.addEntity('IfcDerivedUnit', [[], '.USERDEFINED.', 'Native cycle']).expressId;
   const element = editor.addEntity('IfcDerivedUnitElement', [`#${unit}`, 1]).expressId;
   view.setPositionalAttribute(unit, 0, [`#${element}`]);
   view.setPositionalAttribute(assignment as number, 0, [...members, unit].map(id => `#${id}`));
  } else {
   const component = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', null, '.METRE.']).expressId;
   const elements = Array.from({ length: 513 }, (_, i) => editor.addEntity('IfcDerivedUnitElement', [`#${component}`, i === 0 ? 3 : 0]).expressId);
   const unit = editor.addEntity('IfcDerivedUnit', [elements.map(id => `#${id}`), '.USERDEFINED.', 'Native large unit']).expressId;
   view.setPositionalAttribute(assignment as number, 0, [...members, unit].map(id => `#${id}`));
  }
  view.createQuantitySet(f.id, 'Native occurrence quantities', [{ name: 'NetVolume', value: 25, quantityType: QuantityType.Volume }]);
  const exported = await parse(editedModelBytes(store, view));
  assert.equal(net(extractQuantitiesOnDemand(exported, f.id)), 25, 'raw native quantity stays intact when its physical unit is unknown');
  if (kind === 'unset-context') {
   assert.equal(exported.getEntity(project)?.attributes[8], null, 'independent native export actually removes UnitsInContext');
   assert.equal(extractProjectUnits(exported.source, exported.entityIndex).declaredCount, 0,
    'source-only native reparse retains its existing undeclared-unit convention');
   assert.equal(extractProjectUnits(store.source, store.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale, 1,
    'the original source unit context remains unchanged');
  }
}

export async function prepareQuantityUnitRefusal(fixture: NativeQuantityFixture, kind: 'deleted' | 'unsupported' | 'cyclic' | 'oversized') {
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
}

export async function prepareNewProjectContext(fixture: NativeQuantityFixture) {
 const { f, store, view } = fixture;
 const project = store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
 const assignment = store.getEntity(project)?.attributes[8]; assert.equal(typeof assignment, 'number');
 const members = store.getEntity(assignment as number)?.attributes[0]; assert.ok(Array.isArray(members));
 const unitIds = members.map(id => { assert.ok(typeof id === 'number'); return id; });
 const editor = new StoreEditor(store, view);
 const unit = editor.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.CENTI.', '.CUBIC_METRE.']).expressId;
 const replacement = unitIds.map(id => String(store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'VOLUMEUNIT' ? unit : id);
 const context = editor.addEntity('IfcUnitAssignment', [replacement.map(id => `#${id}`)]).expressId;
 view.setPositionalAttribute(project, 8, `#${context}`);
 view.createQuantitySet(f.id, 'Native occurrence quantities', [{ name: 'NetVolume', value: 25, quantityType: QuantityType.Volume }]);
 const exported = await parse(editedModelBytes(store, view));
 const nativeUnits = extractProjectUnits(exported.source, exported.entityIndex);
 assert.equal(net(extractQuantitiesOnDemand(exported, f.id)), 25, 'native occurrence value is independent of the inherited quantity');
 assert.equal(nativeUnits.resolvedForUnitType('VOLUMEUNIT')?.symbol, 'cm³');
 return { nativeUnits };
}

export async function prepareImplicitProjectUnit(fixture: NativeQuantityFixture) {
 const { f, store, a, view } = fixture;
 assert.equal(store.getEntity(a.volume)?.attributes[2], null, 'native type quantity inherits its project unit');
 const volumeUnit = (store.entityIndex.byType.get('IFCSIUNIT') ?? []).find(id =>
  String(store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'VOLUMEUNIT');
 assert.ok(volumeUnit, 'authentic AC20 source has an explicit project volume unit');
 const sourceUnits = extractProjectUnits(store.source, store.entityIndex);
 assert.equal(sourceUnits.resolvedForUnitType('VOLUMEUNIT')?.siScale, 1);
 view.setPositionalAttribute(volumeUnit, 2, '.MILLI.');
 const exported = await parse(editedModelBytes(store, view));
 const nativeUnits = extractProjectUnits(exported.source, exported.entityIndex);
 assert.equal(nativeUnits.resolvedForUnitType('VOLUMEUNIT')?.siScale, 1e-9,
  'independent native project context now declares cubic millimetres');
 assert.equal(net(extractTypeQuantitiesOnDemand(exported, f.id)?.quantities ?? []), 10);
 return { nativeUnits };
}
