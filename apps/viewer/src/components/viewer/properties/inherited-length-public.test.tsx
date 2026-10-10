/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { act } from 'react';
import { QuantityType } from '@ifc-lite/data';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { StoreEditor } from '@ifc-lite/mutations';
import { extractQuantitiesOnDemand, extractTypeQuantitiesOnDemand, readCurrentTypeQuantities, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { cleanup, click, render, type as typeInput, advance } from '@/test/render';
import { inheritedSource, parse } from '@/test/inherited-quantities-native-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { setGlobalRendererRef } from '@/hooks/useBCF';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  useViewerStore.setState(initial, true);
});

function installSource(source: IfcDataStore) {
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  const maxExpressId = getMaxExpressId(source, model.geometryResult?.meshes ?? [], model.geometryResult?.pointClouds ?? []);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source, maxExpressId }]]),
    ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map(), propertiesActiveTab: 'quantities', unitDisplayOverrides: {} });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  return view;
}

async function nativeLength(t: TestContext) {
  const fixture = await inheritedSource(t); if (!fixture) return null;
  const { store, view, a, f } = fixture;
  const editor = new StoreEditor(store, view);
  const metre = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', null, '.METRE.']).expressId;
  const millimetre = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']).expressId;
  // @raw-entity-enumeration-ok authentic fixture locates its original native Project before authoring the source assignment.
  const project = store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
  const assignment = store.getEntity(project)?.attributes[8]; assert.ok(typeof assignment === 'number');
  const units = store.getEntity(assignment)?.attributes[0]; assert.ok(Array.isArray(units));
  view.setPositionalAttribute(assignment, 0, units.map(id => {
    assert.ok(typeof id === 'number');
    return `#${String(store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'LENGTHUNIT' ? millimetre : id}`;
  }));
  view.setEntityType(a.volume, 'IfcQuantityLength');
  // Retype maps attributes by EXPRESS name: VolumeValue is not LengthValue.
  // Author the required native LengthValue after the class change (#7382).
  view.setPositionalAttribute(a.volume, 3, 10);
  view.setPositionalAttribute(a.volume, 2, `#${metre}`);
  const source = await parse(editedModelBytes(store, view));
  assert.equal(source.entities.getTypeName(f.id), 'IfcWallStandardCase');
  assert.equal(source.entities.getTypeName(a.type), 'IfcWallType');
  assert.equal(extractQuantitiesOnDemand(source, f.id).length, 0, 'no occurrence-first collision can explain the missing inherited row');
  const sourceQuantity = extractTypeQuantitiesOnDemand(source, f.id)?.quantities[0]?.quantities[0]; assert.ok(sourceQuantity);
  assert.equal(sourceQuantity.value, 10); assert.equal(sourceQuantity.explicitUnit, 'm');
  const current = installSource(source);
  return { ...fixture, source, current, metre, millimetre, project };

}

function quantityRow(ui: HTMLElement, name: string) {
  const label = Array.from(ui.querySelectorAll('span')).find(span => span.textContent === name);
  assert.ok(label, `native quantity ${name} is visible`);
  const row = label.closest('.group\\/copyrow');
  assert.ok(row, 'quantity has its actual value/copy row');
  return row;
}

// Separate top-level cases ensure source omission cannot hide the live witness.
for (const edited of [false, true]) test(`#7382 inherited native Length appears in Properties quantities tab edited=${edited}`, async t => {
  const fixture = await nativeLength(t); if (!fixture) return;
  const { source, current, a, f, millimetre } = fixture;
  if (edited) {
    // Existing native positional editing works independently of the pending #7355 default-history writer.
    current.setPositionalAttribute(a.volume, 3, 35);
    current.setPositionalAttribute(a.volume, 2, `#${millimetre}`);
  }
  const saved = await parse(editedModelBytes(source, current));
  const native = extractTypeQuantitiesOnDemand(saved, f.id)?.quantities[0]?.quantities[0]; assert.ok(native);
  assert.equal(native.value, edited ? 35 : 10);
  assert.equal(native.explicitUnit, edited ? 'mm' : 'm');
  assert.equal(native.explicitUnitSiScale, edited ? 0.001 : 1);
  const read = readCurrentTypeQuantities(source, f.id, current);
  assert.equal(read.status, 'available');
  assert.deepEqual(read.value?.quantities[0]?.quantities[0], native, 'canonical current reader agrees with independent saved native graph');
  const ui = render(<PropertiesPanel />);
  const card = Array.from(ui.querySelectorAll('button')).find(button => button.textContent?.includes('Qto_WallBaseQuantities'));
  assert.ok(card, 'selected occurrence quantities tab exposes its inherited native Length set');
  if (card.getAttribute('data-state') !== 'open') click(card);
  assert.equal(quantityRow(ui, 'NetVolume').querySelector('span.font-mono')?.textContent, edited ? '35 mm' : '10 m',
    'mounted Properties quantity value and physical unit agree with native export');
});


test('#7382 same-name native own and inherited sets remain owned, searchable and copy physical display', async t => {
  const x = await nativeLength(t); if (!x) return;
  const editor = new StoreEditor(x.source, x.current);
  const owner = x.source.getEntity(x.f.id)?.attributes[1]; assert.ok(typeof owner === 'number');
  const atom = editor.addEntity('IfcQuantityLength', x.source.schemaVersion === 'IFC2X3' ? ['OwnWitnessLength', null, `#${x.metre}`, 7] : ['OwnWitnessLength', null, `#${x.metre}`, 7, null]).expressId;
  const set = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), `#${owner}`, 'Qto_WallBaseQuantities', null, null, [`#${atom}`]]).expressId;
  editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), `#${owner}`, null, null, [`#${x.f.id}`], `#${set}`]);
  const saved = await parse(editedModelBytes(x.source, x.current));
  assert.equal(extractQuantitiesOnDemand(saved, x.f.id)[0]?.quantities[0]?.value, 7);
  assert.equal(extractTypeQuantitiesOnDemand(saved, x.f.id)?.quantities[0]?.quantities[0]?.value, 10);
  installSource(saved);
  const ui = render(<PropertiesPanel />);
  const own = ui.querySelector('section[aria-label="Occurrence quantities"]');
  const inherited = ui.querySelector('section[aria-label="Inherited type quantities"]');
  assert.ok(own); assert.ok(inherited);
  assert.match(own.textContent ?? '', /OwnWitnessLength/); assert.doesNotMatch(own.textContent ?? '', /NetVolume/);
  assert.match(inherited.textContent ?? '', /NetVolume/); assert.doesNotMatch(inherited.textContent ?? '', /OwnWitnessLength/);
  assert.ok(own.compareDocumentPosition(inherited) & Node.DOCUMENT_POSITION_FOLLOWING, 'own quantities precede inherited quantities');
  act(() => useViewerStore.setState({ propertiesActiveTab: 'properties' }));
  const input = ui.querySelector<HTMLInputElement>('input[role="searchbox"]'); assert.ok(input);
  typeInput(input, '10 m'); await advance(0);
  assert.equal(useViewerStore.getState().propertiesActiveTab, 'quantities');
  assert.equal(ui.querySelector('section[aria-label="Occurrence quantities"]'), null);
  const row = quantityRow(ui, 'NetVolume');
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const writes: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { writes.push(text); } } });
  try {
    const copy = row.querySelector('button'); assert.ok(copy); click(copy); await advance(0);
    assert.deepEqual(writes, ['10 m'], 'actual inherited card copy agrees with independently exported physical quantity');
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else Reflect.deleteProperty(navigator, 'clipboard');
  }
});

test('#7382 unknown native project context keeps explicit inherited Length and refuses implicit own unit labels', async t => {
  const x = await nativeLength(t); if (!x) return;
  x.current.createQuantitySet(x.f.id, 'Own implicit quantities', [{ name: 'OwnRawLength', value: 7, quantityType: QuantityType.Length }]);
  x.current.setPositionalAttribute(x.project, 8, null);
  const saved = await parse(editedModelBytes(x.source, x.current));
  assert.equal(saved.getEntity(x.project)?.attributes[8], null);
  const own = extractQuantitiesOnDemand(saved, x.f.id)[0]?.quantities[0]; assert.ok(own);
  assert.equal(own.value, 7); assert.equal(own.explicitUnit, undefined);
  const inherited = extractTypeQuantitiesOnDemand(saved, x.f.id)?.quantities[0]?.quantities[0]; assert.ok(inherited);
  assert.equal(inherited.value, 10); assert.equal(inherited.explicitUnit, 'm');
  installSource(saved);
  const ui = render(<PropertiesPanel />);
  assert.equal(quantityRow(ui, 'OwnRawLength').querySelector('span.font-mono')?.textContent, '7');
  assert.equal(quantityRow(ui, 'NetVolume').querySelector('span.font-mono')?.textContent, '10 m');
  assert.match(ui.textContent ?? '', /Current quantity units are unavailable/);
});


test('#7382 federated native owner and same-id source swaps refresh inherited Length', async t => {
  const x = await nativeLength(t); if (!x) return;
  x.current.setPositionalAttribute(x.a.volume, 3, 77);
  const replacement = await parse(editedModelBytes(x.source, x.current));
  assert.equal(extractTypeQuantitiesOnDemand(replacement, x.f.id)?.quantities[0]?.quantities[0]?.value, 77);
  installSource(x.source);
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  const second = { ...model, id: 'second', name: 'Independent native second owner', idOffset: 1_000_000,
    ifcDataStore: replacement, maxExpressId: getMaxExpressId(replacement, model.geometryResult?.meshes ?? [], model.geometryResult?.pointClouds ?? []) };
  useViewerStore.setState({ models: new Map([['arch', model], ['second', second]]) });
  const ui = render(<PropertiesPanel />);
  assert.equal(quantityRow(ui, 'NetVolume').querySelector('span.font-mono')?.textContent, '10 m');
  act(() => useViewerStore.setState({ selectedEntity: { modelId: 'second', expressId: x.f.id }, selectedEntityId: useViewerStore.getState().toGlobalId('second', x.f.id) }));
  assert.equal(quantityRow(ui, 'NetVolume').querySelector('span.font-mono')?.textContent, '77 m', 'same local EXPRESS id resolves the selected federation owner');
  act(() => useViewerStore.setState({ selectedEntity: { modelId: 'arch', expressId: x.f.id }, selectedEntityId: useViewerStore.getState().toGlobalId('arch', x.f.id) }));
  assert.equal(quantityRow(ui, 'NetVolume').querySelector('span.font-mono')?.textContent, '10 m');
  act(() => useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: replacement,
    maxExpressId: second.maxExpressId }], ['second', second]]), ifcDataStore: replacement, mutationViews: new Map(), storeEditors: new Map() }));
  assert.equal(quantityRow(ui, 'NetVolume').querySelector('span.font-mono')?.textContent, '77 m', 'selected same-id source replacement cannot retain the former inherited value');
});
