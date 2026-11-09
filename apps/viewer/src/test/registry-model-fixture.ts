/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from './store-fixture';

/** Real source and mutation overlay shared by export, UI and registry roundtrips. */
export async function editedRegistryModel() {
  const bytes = new Uint8Array(await readFile(new URL('../../public/samples/hello-wall.ifc', import.meta.url)));
  const parser = new IfcParser();
  const store = await parser.parseColumnar(bytes.buffer, { disableWorkerScan: true });
  // @raw-entity-enumeration-ok fixture locates the wall in a freshly parsed source before creating its mutation view
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
  return { bytes, parser, store, wall: wall!, id, view };
}
