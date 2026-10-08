/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { QuantityType } from '@ifc-lite/data';
import { extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { parseStep, seedModel, exportAndReparse } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { createElementFieldReader } from './element-field-reader.js';
import type { ElementFieldBinding } from '@ifc-lite/charts';
import type { IfcDataStore } from '@ifc-lite/parser';

function assertUnsetPhysicalUnit(store: IfcDataStore): void {
  const physical = (store.entityIndex.byType.get('IFCQUANTITYLENGTH') ?? []).map(id => store.getEntity(id))
    .find(record => record?.attributes[0] === 'Girth');
  assert.ok(physical, 'the exported physical quantity must exist, including native cloned identities');
  assert.equal(physical.attributes[2], null, 'native IFC export explicitly unsets the physical quantity Unit');
}

test('#7210 Charts respects explicit unit removal through native STEP export', async () => {
  const original = await readFile(new URL('../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
  const text = original.replace(/ENDSEC;\s*END-ISO-10303-21;\s*$/, `
#60040=IFCSIUNIT(*,.LENGTHUNIT.,.CENTI.,.METRE.);
#60041=IFCQUANTITYLENGTH('Girth',$,#60040,12.,$);
#60042=IFCELEMENTQUANTITY('0000000000000000000042',#1,'Qto_Probe',$,$,(#60041));
#60043=IFCRELDEFINESBYPROPERTIES('0000000000000000000043',#1,$,$,(#52),#60042);
ENDSEC;\nEND-ISO-10303-21;`);
  const store = await parseStep(text); seedModel('probe', 0, store, 52);
  assert.equal(store.getEntity(60041)?.attributes[2], 60040);
  const binding: ElementFieldBinding = { kind: 'quantity', qsetName: 'Qto_Probe', quantityName: 'Girth', valueKind: 'number', dataType: 'IFCLENGTHMEASURE' };
  assert.equal(createElementFieldReader(store).readResolved(52, binding).unitSiScale, 0.01);
  const view = getOrCreateMutationView((await import('@/store')).useViewerStore, 'probe'); assert.ok(view);
  view.setQuantityExtractor(id => extractQuantitiesOnDemand(store, id));
  view.setQuantity(52, 'Qto_Probe', 'Girth', 15, QuantityType.Length, null);
  const liveBeforeExport = createElementFieldReader(store, view).readResolved(52, binding);
  const saved = await exportAndReparse('probe', store);
  const quantity = extractQuantitiesOnDemand(saved, 52).find(set => set.name === 'Qto_Probe')?.quantities[0];
  assert.ok(quantity); assert.equal(quantity.value, 15); assert.equal(quantity.explicitUnit, undefined);
  const exported = createElementFieldReader(saved).readResolved(52, binding);
  const live = createElementFieldReader(store, view).readResolved(52, binding);
  assertUnsetPhysicalUnit(saved);
  assert.equal(liveBeforeExport.unitSiScale, exported.unitSiScale, 'live reader must agree with actual native STEP explicit-unit removal');
  assert.equal(live.unitSiScale, undefined);
  view.setQuantity(52, 'Qto_Probe', 'Girth', 16, QuantityType.Length);
  const later = createElementFieldReader(store, view).readResolved(52, binding);
  const laterSaved = await exportAndReparse('probe', store);
  assert.equal(later.value, 16);
  assertUnsetPhysicalUnit(laterSaved);
  assert.equal(later.unitSiScale, createElementFieldReader(laterSaved).readResolved(52, binding).unitSiScale, 'omitted unit after an explicit removal must not resurrect it');
});
