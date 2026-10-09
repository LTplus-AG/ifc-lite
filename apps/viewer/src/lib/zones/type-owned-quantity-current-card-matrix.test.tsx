/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { readCurrentTypeQuantities, extractTypeQuantitiesOnDemand, extractProjectUnits, quantitySiScale } from '@ifc-lite/parser';
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
