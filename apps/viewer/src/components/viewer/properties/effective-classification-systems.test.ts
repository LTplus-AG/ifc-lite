/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { EMPTY_SOURCE_BYTES, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveClassificationSystems } from './effective-classification-systems';

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#10=IFCCLASSIFICATION('CSI','2015',$,'Uniclass',$,$,$);
#11=IFCCLASSIFICATION('CSI','2018',$,'OmniClass',$,$,$);
ENDSEC;
END-ISO-10303-21;`;

it('#5249 lists effective classification systems after source edits and overlay creation', async () => {
  const bytes = new TextEncoder().encode(STEP);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties ?? null, 'model');
  view.setExpressIdWatermark(11);

  assert.deepEqual(effectiveClassificationSystems(store, view), {
    names: ['OmniClass', 'Uniclass'], unresolved: false,
  });

  view.deleteEntity(10);
  view.setPositionalAttribute(11, 3, 'OmniClass positional');
  assert.deepEqual(effectiveClassificationSystems(store, view).names, ['OmniClass positional']);
  view.setAttribute(11, 'Name', 'OmniClass 2018');
  const created = view.createEntity('IfcClassification', [null, null, null, 'DIN 276']);
  const forgotten = view.createEntity('IfcClassification', [null, null, null, 'Forgotten']);
  view.deleteEntity(forgotten.expressId);

  assert.deepEqual(effectiveClassificationSystems(store, view), {
    names: ['DIN 276', 'OmniClass 2018'], unresolved: false,
  });
  assert.equal(view.isDeleted(created.expressId), false);
});

it('#5249 keeps classification systems isolated by model view', async () => {
  const bytes = new TextEncoder().encode(STEP);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const first = new MutablePropertyView(store.properties ?? null, 'first');
  const second = new MutablePropertyView(store.properties ?? null, 'second');
  first.deleteEntity(10);
  second.deleteEntity(11);

  assert.deepEqual(effectiveClassificationSystems(store, first).names, ['OmniClass']);
  assert.deepEqual(effectiveClassificationSystems(store, second).names, ['Uniclass']);
  assert.deepEqual(effectiveClassificationSystems(store, null).names, ['OmniClass', 'Uniclass']);
});

it('#5249 keeps authored names visible when source classification names are unresolved', async () => {
  const bytes = new TextEncoder().encode(STEP);
  const parsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const serverStore = { ...parsed, source: EMPTY_SOURCE_BYTES };
  const view = new MutablePropertyView(parsed.properties ?? null, 'model');
  view.setExpressIdWatermark(11);
  view.createEntity('IfcClassification', [null, null, null, 'DIN 276']);

  assert.deepEqual(effectiveClassificationSystems(serverStore, view), {
    names: ['DIN 276'], unresolved: true,
  });

  view.setAttribute(10, 'Name', 'Uniclass edited');
  view.setAttribute(11, 'Name', 'OmniClass edited');
  assert.deepEqual(effectiveClassificationSystems(serverStore, view), {
    names: ['DIN 276', 'OmniClass edited', 'Uniclass edited'], unresolved: false,
  });
});
