/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import {
  discoverFilterSchema,
  discoverFilterValues,
  discoverPropertyAndQuantitySchema,
  propValueKey,
} from './filter-schema.js';

// Bonsai/IfcOpenShell IFC4 model: #42 is a storey, #1222 a wall with
// Pset_WallCommon. An actual parsed index matters to this enumeration test.
const SAMPLE = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);

async function parsedStore() {
  const bytes = await readFile(SAMPLE);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

test('filter type and storey options follow effective creates, deletes, retypes, and edits (#5249)', async () => {
  const store = await parsedStore();
  const view = new MutablePropertyView(store.properties, 'm1');
  view.setExpressIdWatermark(2000);
  const before = discoverFilterSchema(store, view);
  assert.ok(before.ifcTypes.includes('IfcWall'));
  assert.ok(before.storeys.some(([name]) => name === 'My Storey'));

  view.setAttribute(42, 'Name', 'Renamed Level');
  view.setPositionalAttribute(42, 9, { real: 2 });
  assert.deepEqual(discoverFilterSchema(store, view).storeys, [['Renamed Level', 2]]);

  view.deleteEntity(42);
  view.setEntityType(1222, 'IfcBuildingElementProxy');
  const attributes = Array<null | string | { real: number }>(10).fill(null);
  attributes[2] = 'Authored Level';
  attributes[9] = { real: 3 };
  view.createEntity('IfcBuildingStorey', attributes);
  const after = discoverFilterSchema(store, view);
  assert.deepEqual(after.storeys, [['Authored Level', 3]]);
  assert.ok(after.ifcTypes.includes('IfcBuildingElementProxy'));
  assert.ok(!after.ifcTypes.includes('IfcWall'));
  assert.ok(!after.storeys.some(([name]) => name === 'Renamed Level'));
});

test('whole-model schema sees overlay sets on existing entities absent from on-demand maps (#5249)', async () => {
  const store = await parsedStore();
  store.onDemandPropertyMap?.delete(1222);
  store.onDemandQuantityMap?.delete(1222);
  const view = new MutablePropertyView(store.properties, 'm1');
  view.setProperty(1222, 'Pset_New', 'Flag', 'yes');
  view.setQuantity(1222, 'Qto_New', 'Length', 2);

  const schema = discoverPropertyAndQuantitySchema(store, undefined, view);
  assert.ok(schema.psets.some(([name, properties]) => name === 'Pset_New' && properties.includes('Flag')));
  assert.ok(schema.qtos.some(([name, quantities]) => name === 'Qto_New' && quantities.some(([quantity]) => quantity === 'Length')));

  view.deleteEntity(1222);
  const deleted = discoverPropertyAndQuantitySchema(store, undefined, view);
  assert.ok(!deleted.psets.some(([name]) => name === 'Pset_New'));
  assert.ok(!deleted.qtos.some(([name]) => name === 'Qto_New'));
});

test('type-scoped and value suggestions include authored properties on live entities (#5249)', async () => {
  const store = await parsedStore();
  const view = new MutablePropertyView(store.properties, 'm1');
  view.setExpressIdWatermark(2000);
  const created = view.createEntity('IfcBuildingElementProxy', [null, null, 'Authored object']);
  view.setProperty(created.expressId, 'Pset_Live', 'Flag', 'authored');

  const scoped = discoverPropertyAndQuantitySchema(store, ['IfcBuildingElementProxy'], view);
  assert.deepEqual(scoped.psets, [['Pset_Live', ['Flag']]]);
  const values = discoverFilterValues(store, view);
  assert.deepEqual(values.propertyValues.get(propValueKey('Pset_Live', 'Flag')), ['authored']);

  view.deleteEntity(created.expressId);
  const removed = discoverPropertyAndQuantitySchema(store, ['IfcBuildingElementProxy'], view);
  assert.deepEqual(removed.psets, []);
  assert.equal(discoverFilterValues(store, view).propertyValues.has(propValueKey('Pset_Live', 'Flag')), false);
});

test('filter values keep two model overlays isolated over the same parsed source (#5249)', async () => {
  const store = await parsedStore();
  const first = new MutablePropertyView(store.properties, 'a');
  const second = new MutablePropertyView(store.properties, 'b');
  first.setProperty(1222, 'Pset_Live', 'Flag', 'A');
  second.setProperty(1222, 'Pset_Live', 'Flag', 'B');
  const key = propValueKey('Pset_Live', 'Flag');
  assert.deepEqual([
    discoverFilterValues(store, first).propertyValues.get(key),
    discoverFilterValues(store, second).propertyValues.get(key),
  ], [['A'], ['B']]);
});
