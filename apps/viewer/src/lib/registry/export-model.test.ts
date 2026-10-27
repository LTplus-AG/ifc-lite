/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { exportRegistryModel } from './export-model';

test('registry publishing exports the complete active IFC with its pending property edit', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../../../public/samples/hello-wall.ifc', import.meta.url)));
  const parser = new IfcParser();
  const store = await parser.parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const wall = store.entityIndex.byType.get('IFCWALL')?.[0] ?? store.entityIndex.byType.get('IFCWALLSTANDARDCASE')?.[0];
  assert.notEqual(wall, undefined);
  const id = 'registry-model';
  const view = new MutablePropertyView(store.properties ?? null, id);
  view.setAttribute(wall!, 'Name', 'Registry persisted wall');
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel(id), ifcDataStore: store, schemaVersion: 'IFC4', name: 'edited.ifc' }),
    activeModelId: id, ifcDataStore: store,
    mutationViews: new Map([[id, view]]), mutationVersion: 1, georefMutations: new Map(),
    scheduleData: null, scheduleIsEdited: false, scheduleSourceModelId: null,
  });
  const exported = await exportRegistryModel();
  assert.equal(exported.filename, 'edited.ifc');
  const text = new TextDecoder().decode(exported.bytes);
  assert.match(text, /END-ISO-10303-21;/);
  assert.match(text, /Registry persisted wall/);
  assert.notDeepEqual(exported.bytes, bytes, 'publishing must not reuse the initial source bytes');
  const reopened = await parser.parseColumnar(exported.bytes.buffer, { disableWorkerScan: true });
  assert.equal(reopened.entityCount, store.entityCount, 'the full model is retained');
  const originalWall = reopened.entityIndex.byId.get(wall!);
  assert(originalWall, 'the edited wall still exists after re-parsing');
});
