/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { readCurrentTypeQuantities, extractTypeQuantitiesOnDemand, extractTypeEntityOwnQuantities, extractQuantitiesOnDemand, extractProjectUnits, quantitySiScale } from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from '@/store';
import { QuantitySetCard } from '@/components/viewer/properties/QuantitySetCard';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup } from '@/test/render';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { inheritedSource, parse, net } from '@/test/inherited-quantities-native-fixture';
const original = useViewerStore.getState();
afterEach(() => { cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(original, true); });
for (const skipHistory of [true, false]) test(`#7355 current Type quantity reader/card matches native export for exact skipHistory=${skipHistory} write`, async t => {
  const f = await inheritedSource(t); if (!f) return;
  const { store, b, relation, view } = f;
  view.setPositionalAttribute(relation, 5, `#${b.type}`);
  const before = editedModelBytes(store, view);
  assert.equal(net(extractTypeQuantitiesOnDemand(await parse(before), f.f.id)?.quantities ?? []), 30);
  const historyBefore = view.getMutations().length;
  view.setQuantity(b.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume, undefined, skipHistory);
  const historyDelta = view.getMutations().length - historyBefore;
  const overlay = net(view.getQuantitiesForEntity(b.type));
  const currentBefore = readCurrentTypeQuantities(store, f.f.id, view);
  useViewerStore.setState({ propertiesActiveTab: 'quantities', unitDisplayOverrides: {} });
  const liveBefore = render(<PropertiesPanel />).textContent; cleanup();
  const bytes = editedModelBytes(store, view), saved = await parse(bytes);
  const native = net(extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities ?? []);
  const currentAfter = readCurrentTypeQuantities(store, f.f.id, view);
  const liveAfter = render(<PropertiesPanel />).textContent; cleanup();
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: saved }]]), ifcDataStore: saved,
    mutationViews: new Map(), storeEditors: new Map() });
  const savedCard = render(<PropertiesPanel />).textContent; cleanup();
  console.log('WRITER_CURRENT_CARD_MATRIX', JSON.stringify({ skipHistory, historyDelta, overlay,
    currentBefore, liveBefore, native, currentAfter, liveAfter, savedCard }));
  if (process.env.CAMPAIGN_WRITER_MATRIX_PREFIX) {
    await writeFile(`${process.env.CAMPAIGN_WRITER_MATRIX_PREFIX}-${skipHistory}.before.ifc`, before);
    await writeFile(`${process.env.CAMPAIGN_WRITER_MATRIX_PREFIX}-${skipHistory}.ifc`, bytes);
  }
  assert.equal(historyDelta, skipHistory ? 0 : 1);
  assert.equal(overlay, 35, 'exact real overlay contains the requested value');
  assert.equal(currentBefore.status, 'available');
  assert.equal(currentAfter.status, 'available');
  assert.equal(native, skipHistory ? 30 : 35, 'independent reparse distinguishes unchanged skipHistory nomination from supported default-history writer');
  assert.match(savedCard ?? '', new RegExp(`netNetVolume${native} m³`));
  if (!skipHistory) {
    assert.equal(net(currentBefore.value?.quantities ?? []), native, 'live current canonical reader must match independently exported supported Type write');
    assert.match(liveBefore ?? '', /netNetVolume35 m³/, 'mounted live card agrees before export');
    assert.equal(net(currentAfter.value?.quantities ?? []), native, 'export does not substitute for live canonical reading');
    assert.match(liveAfter ?? '', /netNetVolume35 m³/);
  }
});

test('#7355 tracked Type write followed by skipHistory edit keeps live and native current value', async t => {
  const f = await inheritedSource(t); if (!f) return;
  f.view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const history = f.view.getMutations().length;
  f.view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 40, QuantityType.Volume, undefined, true);
  assert.equal(f.view.getMutations().length, history);
  const native = net(extractTypeQuantitiesOnDemand(await parse(editedModelBytes(f.store, f.view)), f.f.id)?.quantities ?? []);
  assert.equal(native, 40);
  assert.equal(net(readCurrentTypeQuantities(f.store, f.f.id, f.view).value?.quantities ?? []), native);
});
for (const duplicateGuid of [false, true]) test(`#7355 current Type same-name ownership duplicateGuid=${duplicateGuid} matches native writer disposition`, async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const quantity = editor.addEntity('IfcQuantityVolume', ['NetVolume', null, null, 30, null]).expressId;
  const guid = duplicateGuid ? f.store.getEntity(f.a.qto)?.attributes[0] : generateIfcGuid(); assert.ok(typeof guid === 'string' && guid);
  const qto = editor.addEntity('IfcElementQuantity', [guid, null, 'Qto_WallBaseQuantities', null, null, [`#${quantity}`]]).expressId;
  f.view.setPositionalAttribute(f.a.type, 5, [`#${f.a.qto}`, `#${qto}`]);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
  current.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const read = readCurrentTypeQuantities(source, f.f.id, current);
  if (duplicateGuid) {
    assert.throws(() => editedModelBytes(source, current), /identity|ambiguous/);
    assert.equal(read.status, 'unavailable', 'ambiguous native Root ownership cannot be presented as current available facts');
    return;
  }
  const native = extractTypeQuantitiesOnDemand(await parse(editedModelBytes(source, current)), f.f.id)?.quantities ?? [];
  assert.deepEqual(native.flatMap(set => set.quantities.map(q => q.value)), [35, 30]);
  assert.deepEqual(read.value?.quantities.flatMap(set => set.quantities.map(q => q.value)), [35, 30]);
  assert.equal(read.value?.quantities[1].globalId, guid, 'untouched same-name Root remains independently owned');
});
test('#7355 valid native Type length-unit replacement remains available in current reader and card', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const metre = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', null, '.METRE.']).expressId;
  const millimetre = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']).expressId;
  const project = f.store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
  const assignment = f.store.getEntity(project)?.attributes[8]; assert.ok(typeof assignment === 'number');
  const units = f.store.getEntity(assignment)?.attributes[0]; assert.ok(Array.isArray(units));
  f.view.setPositionalAttribute(assignment, 0, units.map(id => {
    assert.ok(typeof id === 'number');
    return `#${String(f.store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'LENGTHUNIT' ? millimetre : id}`;
  }));
  f.view.setEntityType(f.a.volume, 'IfcQuantityLength');
  f.view.setPositionalAttribute(f.a.volume, 2, `#${metre}`);
  f.view.setPositionalAttribute(f.a.volume, 3, 10);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
  useViewerStore.setState({ propertiesActiveTab: 'quantities' });
  const sourceCard = render(<PropertiesPanel />).textContent; cleanup();
  console.log('WRITER_INHERITED_LENGTH_SOURCE_CARD_BEFORE_WRITE', JSON.stringify({ sourceCard, sourceQuantity: extractTypeQuantitiesOnDemand(source, f.f.id)?.quantities }));
  current.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Length, 'MILLIMETRE');
  const saved = await parse(editedModelBytes(source, current));
  const native = extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities[0]?.quantities[0]; assert.ok(native);
  assert.equal(native.value, 35); assert.equal(native.explicitUnit, 'mm'); assert.equal(native.explicitUnitSiScale, 0.001);
  const read = readCurrentTypeQuantities(source, f.f.id, current);
  console.log('WRITER_NATIVE_LENGTH_REPLACEMENT', JSON.stringify({ native, read }));
  assert.equal(read.status, 'available', 'valid writer unit replacement cannot be narrowed to unknown reader coverage');
  assert.deepEqual(read.value?.quantities[0]?.quantities[0], native);
  useViewerStore.setState({ propertiesActiveTab: 'quantities' });
  // The occurrence Properties panel omitted this native inherited Length set
  // before the write too; the finite writer repair does not introduce that UI.
  console.log('WRITER_INHERITED_LENGTH_CURRENT_PANEL', JSON.stringify({ activeTab: useViewerStore.getState().propertiesActiveTab, currentCard: render(<PropertiesPanel />).textContent }));
  cleanup();
  const qset = read.value?.quantities[0]; assert.ok(qset);
  assert.match(render(<QuantitySetCard qset={qset} projectUnits={extractProjectUnits(source.source, source.entityIndex)} searchQuery="NetVolume" />).textContent ?? '',
    /NetVolume.*35.*mm/, 'actual canonical quantity card preserves the independently native replacement scale');
});

for (const targetKind of [QuantityType.Volume, QuantityType.Area]) test(`#7355 intentional native Unit removal with kind=${targetKind} uses current implicit project context`, async t => {
  const f = await inheritedSource(t); if (!f) return;
  const unit = new StoreEditor(f.store, f.view).addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.CENTI.', '.CUBIC_METRE.']).expressId;
  f.view.setPositionalAttribute(f.a.volume, 2, `#${unit}`);
  const source = await parse(editedModelBytes(f.store, f.view));
  const sourceQ = extractTypeQuantitiesOnDemand(source, f.f.id)?.quantities[0]?.quantities[0]; assert.ok(sourceQ);
  assert.equal(sourceQ.explicitUnit, 'cm³');
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
  current.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, targetKind, null);
  const saved = await parse(editedModelBytes(source, current));
  const native = extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities[0]?.quantities[0]; assert.ok(native);
  assert.equal(native.type, targetKind); assert.equal(native.value, 35); assert.equal(native.explicitUnitSiScale, undefined);
  const read = readCurrentTypeQuantities(source, f.f.id, current);
  assert.equal(read.status, 'available');
  assert.deepEqual(read.value?.quantities[0]?.quantities[0], native, 'intentional unit removal cannot retain stale native explicit scale or dimension');
  assert.equal(quantitySiScale(native, extractProjectUnits(saved.source, saved.entityIndex)), 1);
  const liveQuantity = read.value?.quantities[0].quantities[0]; assert.ok(liveQuantity);
  assert.equal(quantitySiScale(liveQuantity, extractProjectUnits(source.source, source.entityIndex)), 1);
});

for (const explicitIntent of [false, true]) test(`#7355 supported explicit Volume unit intent=${explicitIntent} preserves live current metadata`, async t => {
  const f = await inheritedSource(t); if (!f) return;
  const unit = new StoreEditor(f.store, f.view).addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', null, '.CUBIC_METRE.']).expressId;
  f.view.setPositionalAttribute(f.a.volume, 2, `#${unit}`);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
  current.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume, explicitIntent ? 'm³' : undefined);
  const native = extractTypeQuantitiesOnDemand(await parse(editedModelBytes(source, current)), f.f.id)?.quantities[0]?.quantities[0]; assert.ok(native);
  const read = readCurrentTypeQuantities(source, f.f.id, current);
  assert.equal(read.status, 'available'); assert.deepEqual(read.value?.quantities[0]?.quantities[0], native);
  assert.equal(native.value, 35); assert.equal(native.explicitUnitSiScale, 1);
  assert.match(render(<PropertiesPanel />).textContent ?? '', /netNetVolume35 m³/);
});

for (const overlayUnit of [false, true]) test(`#7355 current unit replacement refuses native unassigned unit overlay=${overlayUnit}`, async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const metre = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', null, '.METRE.']).expressId;
  if (!overlayUnit) editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']);
  f.view.setEntityType(f.a.volume, 'IfcQuantityLength');
  f.view.setPositionalAttribute(f.a.volume, 2, `#${metre}`);
  f.view.setPositionalAttribute(f.a.volume, 3, 10);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
  if (overlayUnit) new StoreEditor(source, current).addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']);
  current.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Length, 'MILLIMETRE');
  const read = readCurrentTypeQuantities(source, f.f.id, current);
  assert.throws(() => editedModelBytes(source, current), /unit/i, 'native writer refuses replacement outside its source project assignment');
  console.log('WRITER_UNASSIGNED_UNIT_CURRENT_BEFORE', JSON.stringify({ overlayUnit, read }));
  assert.equal(read.status, 'unavailable', 'unsupported native replacement cannot be shown as current available physical facts');
});

test('#7355 distinct named Type sets preserve native precedence after editing the first set', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const quantity = editor.addEntity('IfcQuantityVolume', ['NetVolume', null, null, 30, null]).expressId;
  const guid = generateIfcGuid();
  const second = editor.addEntity('IfcElementQuantity', [guid, null, 'Qto_SecondVolume', null, null, [`#${quantity}`]]).expressId;
  f.view.setPositionalAttribute(f.a.type, 5, [`#${f.a.qto}`, `#${second}`]);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
  current.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const read = readCurrentTypeQuantities(source, f.f.id, current);
  const native = extractTypeQuantitiesOnDemand(await parse(editedModelBytes(source, current)), f.f.id)?.quantities ?? [];
  useViewerStore.setState({ propertiesActiveTab: 'quantities', unitDisplayOverrides: {} });
  const card = render(<PropertiesPanel />).textContent;
  console.log('WRITER_DISTINCT_SET_PRECEDENCE_BEFORE', JSON.stringify({ read, native, card }));
  assert.equal(read.status, 'available');
  assert.deepEqual(native.map(set => set.name), ['Qto_WallBaseQuantities', 'Qto_SecondVolume']);
  assert.equal(native[1].globalId, guid);
  assert.deepEqual(read.value?.quantities.map(set => set.name), native.map(set => set.name), 'current canonical order preserves independent native first-set precedence');
  assert.match(card ?? '', /netNetVolume35 m³/);
});


// #7378 review: both new-set and copied-member paths share scalar unit admission.
for (const newSet of [true, false]) test(`#7355 new Length unassigned MILLIMETRE refuses newSet=${newSet}`, async t => {
  const f = await inheritedSource(t); if (!f) return;
  const setName = newSet ? 'New length quantities' : 'Qto_WallBaseQuantities';
  f.view.setQuantity(f.a.type, setName, 'NewLength', 35, QuantityType.Length, 'MILLIMETRE');
  assert.equal(readCurrentTypeQuantities(f.store, f.f.id, f.view).status, 'unavailable');
  assert.throws(() => editedModelBytes(f.store, f.view), /explicit unit cannot resolve a native reference/);
  assert.equal(f.store.getEntity(f.a.volume)?.attributes[3], 10, 'refusal retains native source value');
  assert.throws(() => editedModelBytes(f.store, f.view), /explicit unit cannot resolve a native reference/);
});

test('#7355 newly added explicit cm³ Volume refuses instead of emitting project m³', async t => {
  const f = await inheritedSource(t); if (!f) return;
  f.view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NewVolume', 35, QuantityType.Volume, 'cm³');
  assert.equal(readCurrentTypeQuantities(f.store, f.f.id, f.view).status, 'unavailable');
  assert.throws(() => editedModelBytes(f.store, f.view), /explicit unit cannot resolve a native reference/);
  assert.equal(f.store.getEntity(f.a.volume)?.attributes[3], 10);
});

test('#7355 sole native set missing GlobalId refuses live edit and export consistently', async t => {
  const f = await inheritedSource(t); if (!f) return;
  f.view.setPositionalAttribute(f.a.qto, 0, null);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  assert.equal(readCurrentTypeQuantities(source, f.f.id, view).status, 'available',
    'unchanged native quantities do not require writer identity');
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const read = readCurrentTypeQuantities(source, f.f.id, view);
  assert.equal(read.status, 'unavailable');
  assert.match(read.reason ?? '', /identity is missing/);
  assert.throws(() => editedModelBytes(source, view), /identity is missing or ambiguous/);
  assert.equal(source.getEntity(f.a.volume)?.attributes[3], 10);
});


test('#7355 ordinary occurrence explicit m³ retains the surviving export contract', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const units = extractProjectUnits(f.store.source, f.store.entityIndex);
  assert.deepEqual(units.resolvedForUnitType('VOLUMEUNIT'), { symbol: 'm³', siScale: 1 });
  f.view.setQuantity(f.f.id, 'Occurrence quantities', 'NetVolume', 35, QuantityType.Volume, 'm³');
  const saved = await parse(editedModelBytes(f.store, f.view));
  const quantity = extractQuantitiesOnDemand(saved, f.f.id).find(set => set.name === 'Occurrence quantities')
    ?.quantities.find(q => q.name === 'NetVolume'); assert.ok(quantity);
  assert.equal(quantity.value, 35);
  assert.equal(quantity.value * quantitySiScale(quantity, extractProjectUnits(saved.source, saved.entityIndex)), 35,
    'unchanged occurrence API preserves the requested project-m³ physical value');
});

test('#7355 first scalar edit retains native identity and opaque complex-only members', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const child = editor.addEntity('IfcQuantityVolume', ['Opaque child', 'Description', null, 12, 'Formula']).expressId;
  const complex = editor.addEntity('IfcPhysicalComplexQuantity', ['Opaque complex', 'Description',
    [`#${child}`], 'Grouping', 'Quality', 'Usage']).expressId;
  const secondVolume = editor.addEntity('IfcQuantityVolume', ['NetVolume', null, null, 30, null]).expressId;
  const secondSet = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), null,
    'Unchanged second quantities', null, null, [`#${secondVolume}`]]).expressId;
  f.view.setPositionalAttribute(f.a.qto, 5, [`#${complex}`]);
  f.view.setPositionalAttribute(f.a.type, 5, [`#${f.a.qto}`, `#${secondSet}`]);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const current = readCurrentTypeQuantities(source, f.f.id, view);
  assert.equal(current.status, 'unavailable', 'opaque complex quantities refuse numeric live coverage rather than exposing the second set as first');
  assert.match(current.reason ?? '', /quantity class is unavailable or unsupported/);
  assert.equal(current.value, null);
  const saved = await parse(editedModelBytes(source, view));
  assert.equal(net(extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities ?? []), 35);
  assert.equal(extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities
    .find(set => set.name === 'Unchanged second quantities')?.quantities.find(q => q.name === 'NetVolume')?.value, 30);
  const owned = saved.getEntity(f.a.type)?.attributes[5]; assert.ok(Array.isArray(owned));
  assert.ok(owned.some(id => {
    if (typeof id !== 'number') return false;
    const members = saved.getEntity(id)?.attributes[5];
    return Array.isArray(members) && members.includes(complex);
  }),
    'the rewritten native type-owned definition still owns the opaque member');
  assert.deepEqual(saved.getEntity(complex)?.attributes, source.getEntity(complex)?.attributes);
  assert.deepEqual(saved.getEntity(child)?.attributes, source.getEntity(child)?.attributes);
  assert.deepEqual(saved.getEntity(secondSet)?.attributes, source.getEntity(secondSet)?.attributes);
  assert.deepEqual(saved.getEntity(secondVolume)?.attributes, source.getEntity(secondVolume)?.attributes);
});


test('#7355 complex-only native set missing GlobalId refuses its first scalar edit', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const child = editor.addEntity('IfcQuantityVolume', ['Opaque child', null, null, 12, null]).expressId;
  const complex = editor.addEntity('IfcPhysicalComplexQuantity', ['Opaque complex', null,
    [`#${child}`], 'Grouping', null, null]).expressId;
  f.view.setPositionalAttribute(f.a.qto, 0, null);
  f.view.setPositionalAttribute(f.a.qto, 5, [`#${complex}`]);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const read = readCurrentTypeQuantities(source, f.f.id, view);
  assert.equal(read.status, 'unavailable');
  assert.match(read.reason ?? '', /identity is missing/);
  assert.throws(() => editedModelBytes(source, view), /Native type quantity definition identity is missing or ambiguous/);
  assert.deepEqual(source.getEntity(complex)?.attributes[2], [child]);
});

test('#7355 unrelated native sets without GlobalIds survive a GUID-owned Type edit', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const untouched = [12, 24].map((value, index) => {
    const atom = editor.addEntity('IfcQuantityVolume', [`UnchangedVolume${index}`, null, null, value, null]).expressId;
    return editor.addEntity('IfcElementQuantity', [null, null, `Unchanged quantities ${index}`, null, null, [`#${atom}`]]).expressId;
  });
  f.view.setPositionalAttribute(f.a.type, 5, [`#${f.a.qto}`, ...untouched.map(id => `#${id}`)]);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const current = readCurrentTypeQuantities(source, f.f.id, view);
  assert.equal(current.status, 'available');
  assert.equal(net(current.value?.quantities ?? []), 35);
  const saved = await parse(editedModelBytes(source, view));
  assert.equal(net(extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities ?? []), 35);
  for (const id of untouched) assert.deepEqual(saved.getEntity(id)?.attributes, source.getEntity(id)?.attributes,
    'unaffected native definitions do not acquire or require fabricated writer identities');
  assert.deepEqual(current.value?.quantities.filter(set => set.name.startsWith('Unchanged quantities')).map(set => set.quantities[0]?.value), [12, 24]);
});

test('#7378 relationship-only Type quantity remains readable but refuses tracked ownership rewrite', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  f.view.setPositionalAttribute(f.a.type, 5, []);
  const relation = editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), null, null, null,
    [`#${f.a.type}`], `#${f.a.qto}`]).expressId;
  const source = await parse(editedModelBytes(f.store, f.view));
  assert.deepEqual(source.getEntity(f.a.type)?.attributes[5], []);
  assert.equal(source.getEntity(relation)?.attributes[5], f.a.qto);
  assert.equal(net(extractTypeQuantitiesOnDemand(source, f.f.id)?.quantities ?? []), 10);
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setQuantityExtractor(id => extractTypeEntityOwnQuantities(source, id).map(set => ({
    name: set.name, globalId: set.globalId,
    quantities: set.quantities.map(q => ({ name: q.name, type: q.type, value: q.value, unit: q.explicitUnit })),
  })));
  assert.equal(readCurrentTypeQuantities(source, f.f.id, view).status, 'available');
  assert.equal(net(extractTypeQuantitiesOnDemand(await parse(editedModelBytes(source, view)), f.f.id)?.quantities ?? []), 10);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const current = readCurrentTypeQuantities(source, f.f.id, view);
  assert.equal(current.status, 'unavailable');
  assert.equal(current.value, null);
  assert.match(current.reason ?? '', /Relationship-attached Type quantity edits are unsupported/);
  assert.throws(() => editedModelBytes(source, view), /Relationship-attached Type quantity edits are unsupported/);
  assert.equal(source.getEntity(f.a.volume)?.attributes[3], 10);
  assert.equal(source.getEntity(relation)?.attributes[5], f.a.qto);
  view.removeQuantityMutation(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume');
  assert.ok(view.getMutations().some(row => row.entityId === f.a.type && row.psetName === 'Qto_WallBaseQuantities'),
    'Undo leaves the append-only edit journal intact');
  const undone = readCurrentTypeQuantities(source, f.f.id, view);
  assert.equal(undone.status, 'available');
  assert.equal(net(undone.value?.quantities ?? []), 10);
  const saved = await parse(editedModelBytes(source, view));
  assert.equal(net(extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities ?? []), 10);
  assert.deepEqual(saved.getEntity(f.a.qto)?.attributes, source.getEntity(f.a.qto)?.attributes);
  assert.deepEqual(saved.getEntity(relation)?.attributes, source.getEntity(relation)?.attributes);
});

for (const name of [null, 123]) test(`#7378 unrelated relationship-attached quantity name ${name} does not block owned Type export`, async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const atom = editor.addEntity('IfcQuantityVolume', ['UnchangedVolume', null, null, 12, null]).expressId;
  const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), null, name, null, null, [`#${atom}`]]).expressId;
  const relation = editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), null, null, null,
    [`#${f.a.type}`], `#${qto}`]).expressId;
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const saved = await parse(editedModelBytes(source, view));
  const own = extractTypeEntityOwnQuantities(saved, f.a.type);
  assert.equal(net(own), 35);
  for (const id of [atom, qto, relation]) assert.deepEqual(saved.getEntity(id)?.attributes, source.getEntity(id)?.attributes,
    'unrelated native relationship/definition/quantity remains unchanged');
});


test('#7378 owned Type quantity edit leaves same-name relationship quantity identity untouched', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const atom = editor.addEntity('IfcQuantityVolume', ['NetVolume', null, null, 30, null]).expressId;
  const relatedOnly = editor.addEntity('IfcQuantityVolume', ['RelationshipVolume', null, null, 30, null]).expressId;
  const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), null, 'Qto_WallBaseQuantities', null, null, [`#${atom}`, `#${relatedOnly}`]]).expressId;
  const relation = editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), null, null, null,
    [`#${f.a.type}`], `#${qto}`]).expressId;
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const current = readCurrentTypeQuantities(source, f.f.id, view);
  assert.equal(current.status, 'available');
  assert.deepEqual(current.value?.quantities.map(set => set.quantities[0]?.value), [35, 30]);
  const saved = await parse(editedModelBytes(source, view));
  assert.equal(net(extractTypeEntityOwnQuantities(saved, f.a.type)), 35);
  assert.deepEqual(extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities.map(set => set.quantities[0]?.value), [35, 30]);
  for (const id of [atom, relatedOnly, qto, relation]) assert.deepEqual(saved.getEntity(id)?.attributes, source.getEntity(id)?.attributes);
  view.setPositionalAttribute(relatedOnly, 3, 31);
  assert.equal(readCurrentTypeQuantities(source, f.f.id, view).status, 'available');
  assert.throws(() => editedModelBytes(source, view), /Relationship-attached Type quantity edits are unsupported/,
    'source-only relationship claim proof does not qualify concurrent native metadata edits');
  view.removePositionalMutation(relatedOnly, 3);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'RelationshipVolume', 40, QuantityType.Volume);
  assert.equal(readCurrentTypeQuantities(source, f.f.id, view).status, 'unavailable');
  assert.throws(() => editedModelBytes(source, view), /Relationship-attached Type quantity edits are unsupported/);
  view.removeQuantityMutation(f.a.type, 'Qto_WallBaseQuantities', 'RelationshipVolume');
  view.deleteQuantitySet(f.a.type, 'Qto_WallBaseQuantities');
  assert.equal(readCurrentTypeQuantities(source, f.f.id, view).status, 'unavailable');
  assert.throws(() => editedModelBytes(source, view), /Relationship-attached Type quantity edits are unsupported/);
});

test('#7378 unrelated complex-only Type definition without GUID survives a numeric owned edit', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const child = editor.addEntity('IfcQuantityLength', ['Opaque child', null, null, 4, null]).expressId;
  const complex = editor.addEntity('IfcPhysicalComplexQuantity', ['Opaque complex', null, [`#${child}`], 'Usage', null, null]).expressId;
  const qto = editor.addEntity('IfcElementQuantity', [null, null, 'Unchanged complex quantities', null, null, [`#${complex}`]]).expressId;
  f.view.setPositionalAttribute(f.a.type, 5, [`#${f.a.qto}`, `#${qto}`]);
  const source = await parse(editedModelBytes(f.store, f.view));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const saved = await parse(editedModelBytes(source, view));
  assert.equal(net(extractTypeEntityOwnQuantities(saved, f.a.type)), 35);
  assert.ok(saved.getEntity(f.a.type)?.attributes[5] instanceof Array);
  assert.ok((saved.getEntity(f.a.type)?.attributes[5] as unknown[]).includes(qto));
  for (const id of [child, complex, qto]) assert.deepEqual(saved.getEntity(id)?.attributes, source.getEntity(id)?.attributes);
});


test('#7378 dual-attached Type quantity copies owned identity and preserves the independent native relation', async t => {
  const f = await inheritedSource(t); if (!f) return;
  const editor = new StoreEditor(f.store, f.view);
  const relation = editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), null, null, null,
    [`#${f.a.type}`], `#${f.a.qto}`]).expressId;
  const source = await parse(editedModelBytes(f.store, f.view));
  const originalGuid = source.getEntity(f.a.qto)?.attributes[0]; assert.equal(typeof originalGuid, 'string');
  const originalOwners = source.getEntity(f.a.type)?.attributes[5]; assert.ok(Array.isArray(originalOwners));
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  view.setQuantity(f.a.type, 'Qto_WallBaseQuantities', 'NetVolume', 35, QuantityType.Volume);
  const saved = await parse(editedModelBytes(source, view));
  const owned = saved.getEntity(f.a.type)?.attributes[5]; assert.ok(Array.isArray(owned));
  assert.ok(!owned.includes(f.a.qto), 'the old identity is no longer HasPropertySets-owned');
  for (const id of originalOwners.filter(id => id !== f.a.qto)) assert.ok(owned.includes(id));
  const copies = owned.map(id => typeof id === 'number' ? saved.getEntity(id) : null)
    .filter(entity => entity?.type.toUpperCase() === 'IFCELEMENTQUANTITY' && entity.attributes[2] === 'Qto_WallBaseQuantities');
  assert.equal(copies.length, 1);
  const copy = copies[0]; assert.ok(copy);
  assert.equal(typeof copy.attributes[0], 'string');
  assert.notEqual(copy.attributes[0], originalGuid, 'the owned definition receives its actual fresh GUID');
  const quantities = extractTypeQuantitiesOnDemand(saved, f.f.id)?.quantities ?? [];
  assert.equal(net(quantities.filter(set => set.globalId === copy.attributes[0])), 35);
  assert.equal(net(quantities.filter(set => set.globalId === originalGuid)), 10);
  for (const id of [f.a.qto, f.a.volume, relation]) assert.deepEqual(saved.getEntity(id)?.attributes, source.getEntity(id)?.attributes,
    'the independent native relationship keeps its original definition and scalar atoms');
  assert.equal(saved.getEntity(relation)?.attributes[5], f.a.qto);
});
