/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { StoreEditor } from '@ifc-lite/mutations';
import { extractQuantitiesOnDemand, extractTypeQuantitiesOnDemand, readCurrentTypeQuantities, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { cleanup, click, render } from '@/test/render';
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

// Separate top-level cases ensure source omission cannot hide the live witness.
for (const edited of [false, true]) test(`#7382 inherited native Length appears in Properties quantities tab edited=${edited}`, async t => {
  const fixture = await inheritedSource(t); if (!fixture) return;
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
  view.setPositionalAttribute(a.volume, 2, `#${metre}`);
  const source = await parse(editedModelBytes(store, view));
  assert.equal(source.entities.getTypeName(f.id), 'IfcWallStandardCase');
  assert.equal(source.entities.getTypeName(a.type), 'IfcWallType');
  assert.equal(extractQuantitiesOnDemand(source, f.id).length, 0, 'no occurrence-first collision can explain the missing inherited row');
  const sourceQuantity = extractTypeQuantitiesOnDemand(source, f.id)?.quantities[0]?.quantities[0]; assert.ok(sourceQuantity);
  assert.equal(sourceQuantity.value, 10); assert.equal(sourceQuantity.explicitUnit, 'm');
  const current = installSource(source);
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
  assert.match(ui.textContent ?? '', edited ? /NetVolume\s*35\s*mm/ : /NetVolume\s*10\s*m\b/,
    'mounted Properties quantity value and physical unit agree with native export');
});
