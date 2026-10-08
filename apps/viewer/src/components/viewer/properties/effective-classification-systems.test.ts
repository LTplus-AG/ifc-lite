/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { EMPTY_SOURCE_BYTES, extractClassificationsOnDemand, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { classificationPopulationUnavailable, effectiveClassificationSystems } from './effective-classification-systems';

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

it('#7131 refuses a complete population when transported classification membership inputs are absent', async () => {
  const bytes = new TextEncoder().encode(STEP);
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties ?? null, 'model');
  const missingMembership = { ...store, source: EMPTY_SOURCE_BYTES };
  // Simulate omitted transport fields without pretending undefined satisfies
  // the normal parsed-store contract, which requires a relationship graph.
  Reflect.deleteProperty(missingMembership, 'onDemandClassificationMap');
  Reflect.deleteProperty(missingMembership, 'relationships');
  assert.equal(classificationPopulationUnavailable(missingMembership, view), true);
  assert.equal(classificationPopulationUnavailable(store, view), false);
  assert.equal(classificationPopulationUnavailable({ ...store, source: EMPTY_SOURCE_BYTES }, view), false);
});

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
    names: ['DIN 276', 'OmniClass positional'], unresolved: false, // #7131: native STEP export applies positional edits after named edits.
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

// #7131: relationship records are indexed but absent from the sparse entity columns.
it('#7131 refuses source-empty population after an indexed ArchiCAD relationship edit', async t => {
  const fixture = new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return;
    }
    throw error;
  }
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  assert.equal(store.entities.getTypeName(21173), 'Unknown');
  assert.equal(store.entityIndex.byId.get(21173)?.type, 'IFCRELASSOCIATESCLASSIFICATION');
  const view = new MutablePropertyView(store.properties ?? null, 'archicad');
  const transported = { ...store, source: EMPTY_SOURCE_BYTES };
  assert.equal(classificationPopulationUnavailable(transported, view), false);
  view.setPositionalAttribute(21173, 4, ['#20909']);
  assert.equal(view.getEffectiveChanges().length, 1);
  assert.equal(classificationPopulationUnavailable(transported, view), true, 'indexed relationship edits cannot prove source-empty membership');
  assert.equal(classificationPopulationUnavailable(store, view), false, 'source-bearing native reader remains available');
  const referenceView = new MutablePropertyView(store.properties ?? null, 'archicad-reference');
  assert.equal(store.entityIndex.byId.get(21169)?.type, 'IFCCLASSIFICATIONREFERENCE');
  assert.equal(store.entities.getTypeName(21169), 'IfcClassificationReference', 'the actual source reference retains its canonical kind');
  referenceView.setAttribute(21169, 'Name', 'Known partial edit');
  assert.equal(classificationPopulationUnavailable(transported, referenceView), true, 'indexed source definitions use the same canonical kind lookup');
  assert.equal(classificationPopulationUnavailable(store, referenceView), false);
  referenceView.setExpressIdWatermark(100_000);
  referenceView.createEntity('IfcRelAssociatesClassification', ['0000000000000000000001', null, null, null, ['#20909'], '#21169']);
  const known = extractClassificationsOnDemand(transported, 20909, referenceView);
  assert.ok(known.some(row => row.name === 'Known partial edit' && row.unresolved === true), 'native source-empty reader retains known indexed reference fields without inventing resolution');
});
