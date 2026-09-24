/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { createModelAdapter } from './model-adapter.js';
import type { StoreApi } from './types.js';

const IFC = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCWALL('0000000000000000000002',$,'Wall A',$,$,$,$,$,$);
#3=IFCWALL('0000000000000000000003',$,'Wall B',$,$,$,$,$,$);
ENDSEC;END-ISO-10303-21;`;

async function model(id: string) {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer as ArrayBuffer);
  const view = new MutablePropertyView(dataStore.properties, id);
  view.setExpressIdWatermark(3);
  return {
    entry: { id, name: id, ifcDataStore: dataStore, schemaVersion: 'IFC4', fileSize: 0, loadedAt: 0 },
    view,
    count: dataStore.entities.count,
  };
}

test('bim.model.list counts live creations and tombstones per model (#5249)', async () => {
  const a = await model('a');
  const b = await model('b');
  const views = new Map([['a', a.view], ['b', b.view]]);
  const state = {
    models: new Map([['a', a.entry], ['b', b.entry]]),
    ifcDataStore: null,
    activeModelId: 'a',
    getMutationView: (id: string) => views.get(id) ?? null,
  };
  const adapter = createModelAdapter({ getState: () => state, subscribe: () => () => {} } as unknown as StoreApi);

  assert.deepEqual(adapter.list().map(m => m.entityCount), [a.count, b.count]);
  a.view.deleteEntity(3);
  const created = a.view.createEntity('IfcWall', ['0000000000000000000004', null, 'New wall']);
  const transient = b.view.createEntity('IfcWall', ['0000000000000000000005', null, 'Transient']);
  b.view.deleteEntity(transient.expressId);
  assert.deepEqual(adapter.list().map(m => m.entityCount), [a.count, b.count]);

  a.view.createEntity('IfcWall', ['0000000000000000000006', null, 'Another wall']);
  assert.equal(adapter.list()[0]?.entityCount, a.count + 1);
  a.view.deleteEntity(created.expressId);
  assert.equal(adapter.list()[0]?.entityCount, a.count);
  assert.equal(adapter.list()[1]?.entityCount, b.count);
});

test('legacy single-model count reads the registered legacy mutation view (#5249)', async () => {
  const legacy = await model('__legacy__');
  const state = {
    models: new Map(),
    ifcDataStore: legacy.entry.ifcDataStore,
    activeModelId: null,
    getMutationView: (id: string) => id === '__legacy__' ? legacy.view : null,
  };
  const adapter = createModelAdapter({ getState: () => state, subscribe: () => () => {} } as unknown as StoreApi);
  legacy.view.deleteEntity(3);
  assert.equal(adapter.list()[0]?.entityCount, legacy.count - 1);
});
