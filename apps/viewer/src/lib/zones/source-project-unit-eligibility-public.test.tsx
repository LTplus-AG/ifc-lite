/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import * as parser from '@ifc-lite/parser';
import { QuantityType } from '@ifc-lite/data';
import { StoreEditor } from '@ifc-lite/mutations';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from '@/store';
import { cleanup } from '@/test/render';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { inheritedSource, parse } from '@/test/inherited-quantities-native-fixture';
const original = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(original, true); });

// #7355 lower layer exposes the existing writer resolver, independently of
// the later Type-owned quantity rewrite. All eligibility is real native IFC.
for (const disposition of ['assigned', 'unassigned', 'overlay', 'deleted'] as const) {
  test(`#7355 canonical source project unit eligibility: ${disposition}`, async t => {
    const f = await inheritedSource(t); if (!f) return;
    const project = f.store.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
    const assignment = f.store.getEntity(project)?.attributes[8]; assert.ok(typeof assignment === 'number');
    const units = f.store.getEntity(assignment)?.attributes[0]; assert.ok(Array.isArray(units));
    const editor = new StoreEditor(f.store, f.view);
    let millimetre = disposition === 'overlay' ? undefined : editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']).expressId;
    if (disposition === 'assigned' || disposition === 'deleted') {
      f.view.setPositionalAttribute(assignment, 0, units.map(id => {
        assert.ok(typeof id === 'number');
        return `#${String(f.store.getEntity(id)?.attributes[1]).replace(/\./g, '') === 'LENGTHUNIT' ? millimetre : id}`;
      }));
    }
    const source = await parse(editedModelBytes(f.store, f.view));
    const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
    useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source }]]), ifcDataStore: source,
      mutationViews: new Map(), storeEditors: new Map() });
    const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
    if (disposition === 'overlay') millimetre = new StoreEditor(source, current).addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', '.MILLI.', '.METRE.']).expressId;
    assert.ok(millimetre !== undefined);
    if (disposition === 'deleted') assert.equal(current.deleteEntity(millimetre), true);
    // Public API presence is part of the published contract. The subsequent
    // checks exercise native eligibility/scale, not a mocked return value.
    assert.equal(Object.hasOwn(parser, 'findSourceProjectLengthUnit'), true, 'published canonical source-unit resolver must exist');
    assert.equal(Object.hasOwn(parser, 'normalizeMapUnitName'), true, 'published canonical label normalizer must exist');
    const normalized = parser.normalizeMapUnitName('milli-meters');
    assert.equal(normalized, 'MILLIMETRE');
    const found = parser.findSourceProjectLengthUnit(normalized, source,
      source.entityIndex.byType.get('IFCPROJECT') ?? [], id => current.isDeleted(id));
    assert.equal(found, disposition === 'assigned' ? millimetre : null);
    if (disposition === 'assigned') {
      const native = source.getEntity(found!); assert.ok(native);
      assert.equal(native.type.toUpperCase(), 'IFCSIUNIT');
      assert.equal(String(native.attributes[1]).replace(/\./g, ''), 'LENGTHUNIT');
      assert.equal(String(native.attributes[2]).replace(/\./g, ''), 'MILLI');
      assert.equal(String(native.attributes[3]).replace(/\./g, ''), 'METRE');
      current.setQuantity(f.f.id, 'Qto_EligibilityControl', 'NativeLength', 35, QuantityType.Length, normalized);
      const saved = await parse(editedModelBytes(source, current));
      const qset = parser.extractQuantitiesOnDemand(saved, f.f.id).find(set => set.name === 'Qto_EligibilityControl');
      const quantity = qset?.quantities.find(q => q.name === 'NativeLength'); assert.ok(quantity);
      assert.equal(quantity.value, 35);
      assert.equal(quantity.explicitUnit, 'mm');
      assert.equal(quantity.explicitUnitSiScale, 0.001, 'existing native occurrence writer preserves the assigned unit scale');
    }
  });
}
