/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { createScheduleAdapter } from './schedule-adapter.js';
import type { StoreApi } from './types.js';

const MODEL = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCTASK('task-a',$,'Original',$,$,'A',$,$,$,.F.,$,$,.CONSTRUCTION.);
ENDSEC;END-ISO-10303-21;`;

test('schedule adapter sees overlay edits after mutationVersion changes (#5249)', async () => {
  const dataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
  const view = new MutablePropertyView(dataStore.properties, 'm');
  const editor = new StoreEditor(dataStore, view);
  const state = {
    models: new Map([['m', { id: 'm', ifcDataStore: dataStore }]]),
    activeModelId: 'm', ifcDataStore: dataStore, mutationVersion: 0,
    getMutationView: (id: string) => id === 'm' ? view : null,
  };
  const adapter = createScheduleAdapter({ getState: () => state, subscribe: () => () => {} } as unknown as StoreApi);
  assert.equal(adapter.tasks()[0]?.name, 'Original');
  editor.setAttribute(1, 'Name', 'Edited');
  editor.addEntity('IfcTask', ['task-b', null, 'New', null, null, 'B', null, null, null, '.F.', null, null, '.CONSTRUCTION.']);
  state.mutationVersion++;
  assert.deepEqual(adapter.tasks().map(t => t.name), ['Edited', 'New']);
  editor.removeEntity(1);
  state.mutationVersion++;
  assert.deepEqual(adapter.tasks().map(t => t.name), ['New']);
});
