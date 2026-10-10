/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { extractProjectUnits, extractQuantitiesOnDemand, extractTypeQuantitiesOnDemand } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { inheritedSource, parse } from '@/test/inherited-quantities-native-fixture';

export async function explicitFixture(t: TestContext, occurrence: boolean) {
  const x = await inheritedSource(t); if (!x) return;
  const editor = new StoreEditor(x.store, x.view);
  const unit = editor.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.MILLI.', '.CUBIC_METRE.']).expressId;
  x.view.setPositionalAttribute(x.a.volume, 2, `#${unit}`);
  let quantityId = x.a.volume;
  if (occurrence) {
    // The occurrence wins over both the later own basis and inherited Net30.
    x.view.setPositionalAttribute(x.a.volume, 3, 30);
    const ownerId = x.store.getEntity(x.f.id)?.attributes[1];
    const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
    const volume = (name: string, value: number, explicit: boolean) => editor.addEntity('IfcQuantityVolume',
      x.store.schemaVersion === 'IFC2X3' ? [name, null, explicit ? `#${unit}` : null, value]
        : [name, null, explicit ? `#${unit}` : null, value, null]).expressId;
    quantityId = volume('NetExplicitVolume', 10, true);
    const later = volume('NetLaterVolume', 999, true);
    const gross = volume('GrossImplicitVolume', 99, false);
    const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'Qto_ExplicitOccurrence', null, null,
      [`#${quantityId}`, `#${later}`, `#${gross}`]]).expressId;
    editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), owner, null, null, [`#${x.f.id}`], `#${qto}`]);
  }
  const store = await parse(editedModelBytes(x.store, x.view));
  assert.equal(store.getEntity(quantityId)?.attributes[2], unit, 'real native export/reparse preserves member Unit');
  assert.equal(store.getEntity(quantityId)?.attributes[3], 10, 'real native export/reparse preserves raw amount');
  assert.deepEqual(store.getEntity(unit)?.attributes.slice(1), ['.VOLUMEUNIT.', '.MILLI.', '.CUBIC_METRE.']);
  const native = (occurrence ? extractQuantitiesOnDemand(store, x.f.id) : extractTypeQuantitiesOnDemand(store, x.f.id)?.quantities ?? [])
    .flatMap(set => set.quantities).find(q => q.name === (occurrence ? 'NetExplicitVolume' : 'NetVolume'));
  assert.ok(native);
  assert.equal(native.explicitUnitSiScale, 1e-9, 'canonical native collector independently resolves cubic millimetres');
  assert.equal(extractProjectUnits(store.source, store.entityIndex).resolvedForUnitType('VOLUMEUNIT')?.siScale, 1,
    'actual project cubic metres differ from the explicit member unit');
  const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
  useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: store,
    maxExpressId: getMaxExpressId(store, model.geometryResult?.meshes ?? []) }]]), ifcDataStore: store,
    mutationViews: new Map(), storeEditors: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(view);
  return { ...x, store, view, unit, quantityId, quantityName: native.name };
}

